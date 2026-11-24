import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import type { LocalStorage } from '@multizap/storage';
import type { ImportQueue } from '../src/lib/queues';
import { ImportProcessor } from '../../worker/src/imports/processor';
import {
  authed,
  createAdmin,
  login,
  multipart,
  resetDb,
  setupTestApp,
  type Session,
} from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let storage: LocalStorage;
let importQueue: ImportQueue;
let processor: ImportProcessor;
let s: Session;
let A: string;

beforeAll(async () => {
  ({ app, prisma, redis, storage, importQueue } = await setupTestApp());
  processor = new ImportProcessor(prisma, storage);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await importQueue.queue.drain(true);
  await createAdmin(prisma);
  s = await login(app);
  A = (await prisma.account.create({ data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB' } }))
    .id;
});

const upload = (name: string, content: string | Buffer, account = A) => {
  const m = multipart(name, content);
  return app.inject({
    method: 'POST',
    url: `/accounts/${account}/imports`,
    headers: { ...authed(s), 'content-type': m.contentType },
    payload: m.body,
  });
};
const post = (url: string, payload?: object) =>
  app.inject({ method: 'POST', url, headers: authed(s), payload });
const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });
const jobs = async () =>
  (await importQueue.queue.getJobs(['waiting', 'delayed'])).map((j) => j.data);

const CSV =
  'Nome;Celular\nAna;(11) 98765-4321\nBruno;11912345678\nAna de novo;11987654321\nCarlos;1198\n';

describe('fluxo de importação (10 etapas)', () => {
  it('envio → colunas → mapeamento → análise → prévia → confirmação → importação', async () => {
    // 1–3: arquivo + instância + detecção de colunas
    const up = await upload('clientes.csv', CSV);
    expect(up.statusCode).toBe(201);
    const imp = up.json().import;
    expect(imp).toMatchObject({
      status: 'UPLOADED',
      format: 'csv',
      hasHeader: true,
      columns: ['Nome', 'Celular'],
    });
    expect(imp.suggested).toEqual({ phone: 1, name: 0, tags: null, notes: null });
    expect(imp.sample).toHaveLength(5);

    // 4: mapeamento → análise assíncrona
    const mapping = { hasHeader: true, columns: imp.suggested, consent: { status: 'PENDING' } };
    expect((await post(`/accounts/${A}/imports/${imp.id}/analyze`, { mapping })).statusCode).toBe(
      202,
    );
    expect(await jobs()).toEqual([{ type: 'analyze', importId: imp.id }]);
    await processor.analyze(imp.id); // execução do worker

    // 5–8: pré-visualização, duplicados, inválidos e resumo
    const analyzed = (await get(`/accounts/${A}/imports/${imp.id}`)).json().import;
    expect(analyzed).toMatchObject({
      status: 'ANALYZED',
      totalRows: 4,
      validRows: 2,
      duplicateRows: 1,
      invalidRows: 1,
      hasRejectedFile: true,
    });
    const invalid = (await get(`/accounts/${A}/imports/${imp.id}/rows?status=INVALID`)).json();
    expect(invalid.items).toEqual([
      expect.objectContaining({
        rowNumber: 5,
        reason: 'Número incompleto',
        raw: ['Carlos', '1198'],
      }),
    ]);
    expect(await prisma.contact.count()).toBe(0); // nada importado sem confirmação

    const rejected = await get(`/accounts/${A}/imports/${imp.id}/rejected`);
    expect(rejected.statusCode).toBe(200);
    expect(rejected.headers['content-disposition']).toContain('clientes-rejeitados.csv');
    expect(rejected.rawPayload.toString()).toContain('Duplicado no arquivo (linha 2)');

    // 9–10: confirmação → importação
    expect((await post(`/accounts/${A}/imports/${imp.id}/confirm`)).statusCode).toBe(202);
    expect((await post(`/accounts/${A}/imports/${imp.id}/confirm`)).statusCode).toBe(409); // sem confirmação dupla
    expect((await jobs()).filter((j) => j.type === 'run')).toHaveLength(1);
    await processor.run(imp.id);
    const done = (await get(`/accounts/${A}/imports/${imp.id}`)).json().import;
    expect(done).toMatchObject({ status: 'COMPLETED', importedRows: 2 });
    const contacts = (await get(`/accounts/${A}/contacts`)).json();
    expect(contacts.total).toBe(2);
    expect(contacts.items[0]).toMatchObject({ origin: 'IMPORT' });
  });

  it('bloqueia o reenvio do mesmo arquivo para a mesma instância', async () => {
    const imp = (await upload('a.csv', CSV)).json().import;
    await post(`/accounts/${A}/imports/${imp.id}/analyze`, {
      mapping: { hasHeader: true, columns: { phone: 1 }, consent: { status: 'PENDING' } },
    });
    const again = await upload('copia.csv', CSV);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('DUPLICATE_IMPORT');
    // em outra instância é permitido
    const other = (
      await prisma.account.create({ data: { name: 'Outra', connectionType: 'WHATSAPP_WEB' } })
    ).id;
    expect((await upload('a.csv', CSV, other)).statusCode).toBe(201);
    // após cancelar, pode reenviar
    const pending = (await upload('b.csv', 'telefone\n11987654321\n')).json().import;
    await post(`/accounts/${A}/imports/${pending.id}/cancel`);
    expect((await upload('b.csv', 'telefone\n11987654321\n')).statusCode).toBe(201);
  });

  it('rejeita formatos não suportados e arquivos vazios', async () => {
    expect((await upload('lista.xls', 'x')).json().error.code).toBe('UNSUPPORTED_FORMAT');
    expect((await upload('vazio.csv', '\n\n')).json().error.code).toBe('EMPTY_FILE');
  });

  it('valida o mapeamento (coluna inexistente, consentimento sem origem)', async () => {
    const imp = (await upload('a.csv', CSV)).json().import;
    const bad = await post(`/accounts/${A}/imports/${imp.id}/analyze`, {
      mapping: { hasHeader: true, columns: { phone: 7 }, consent: { status: 'PENDING' } },
    });
    expect(bad.statusCode).toBe(400);
    const noSource = await post(`/accounts/${A}/imports/${imp.id}/analyze`, {
      mapping: { hasHeader: true, columns: { phone: 1 }, consent: { status: 'GRANTED' } },
    });
    expect(noSource.statusCode).toBe(400);
  });

  it('não confirma sem análise e isola importações por instância', async () => {
    const imp = (await upload('a.csv', CSV)).json().import;
    expect((await post(`/accounts/${A}/imports/${imp.id}/confirm`)).statusCode).toBe(409);
    const other = (
      await prisma.account.create({ data: { name: 'Outra', connectionType: 'WHATSAPP_WEB' } })
    ).id;
    expect((await get(`/accounts/${other}/imports/${imp.id}`)).statusCode).toBe(404);
    expect((await get(`/accounts/${other}/imports`)).json().items).toEqual([]);
  });
});
