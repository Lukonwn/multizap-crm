import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import type { LocalStorage } from '@multizap/storage';
import type { ToolQueue } from '../src/lib/queues';
import { ToolJobProcessor } from '../../worker/src/tools/processor';
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
let toolQueue: ToolQueue;
let proc: ToolJobProcessor;
let s: Session;

beforeAll(async () => {
  ({ app, prisma, redis, storage, toolQueue } = await setupTestApp());
  proc = new ToolJobProcessor(prisma, storage);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await toolQueue.queue.drain(true);
  await createAdmin(prisma);
  s = await login(app);
});

const upload = (name: string, content: string) => {
  const m = multipart(name, content);
  return app.inject({
    method: 'POST',
    url: '/tools/uploads',
    headers: { ...authed(s), 'content-type': m.contentType },
    payload: m.body,
  });
};
const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: authed(s), payload });
const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });

const LIST = 'nome;telefone\nAna;11987654321\nBia;11987654321\nCaio;21998765432\n';

describe('ferramentas (API)', () => {
  it('envio com prévia → processamento → download do resultado', async () => {
    const up = await upload('lista.csv', LIST);
    expect(up.statusCode).toBe(201);
    expect(up.json().upload).toMatchObject({
      format: 'csv',
      hasHeader: true,
      suggestedPhoneColumn: 1,
      sample: [
        ['nome', 'telefone'],
        ['Ana', '11987654321'],
        ['Bia', '11987654321'],
        ['Caio', '21998765432'],
      ],
    });

    const created = await post('/tools/jobs', {
      tool: 'dedupe',
      uploadIds: [up.json().upload.id],
      params: { by: 'phone' },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json().job;
    expect(job).toMatchObject({
      tool: 'dedupe',
      status: 'QUEUED',
      inputs: [{ name: 'lista.csv' }],
    });
    expect((await toolQueue.queue.getJobs(['waiting'])).map((j) => j.data)).toEqual([
      { jobId: job.id },
    ]);

    await proc.run(job.id); // worker
    const done = (await get(`/tools/jobs/${job.id}`)).json().job;
    expect(done).toMatchObject({
      status: 'COMPLETED',
      progress: 100,
      summary: { total: 3, duplicatesRemoved: 1 },
    });
    expect(done.outputs.map((o: { name: string }) => o.name)).toEqual([
      'lista-sem-duplicados.csv',
      'lista-duplicados-removidos.csv',
    ]);

    const file = await get(`/tools/jobs/${job.id}/outputs/0`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toBe(
      'attachment; filename="lista-sem-duplicados.csv"',
    );
    expect(file.rawPayload.toString('utf8')).toContain('Caio;21998765432');
    expect(file.rawPayload.toString('utf8')).not.toContain('Bia');

    expect((await get('/tools/jobs')).json().items).toHaveLength(1);
    const del = await app.inject({
      method: 'DELETE',
      url: `/tools/jobs/${job.id}`,
      headers: authed(s),
    });
    expect(del.statusCode).toBe(200);
    expect(await prisma.fileJob.count()).toBe(0);
  });

  it('valida quantidade de arquivos e parâmetros por ferramenta', async () => {
    const id = (await upload('a.csv', LIST)).json().upload.id;
    expect(
      (await post('/tools/jobs', { tool: 'compare', uploadIds: [id], params: {} })).statusCode,
    ).toBe(400);
    expect(
      (await post('/tools/jobs', { tool: 'split', uploadIds: [id], params: { mode: 'rows' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('/tools/jobs', { tool: 'inexistente', uploadIds: [id], params: {} })).statusCode,
    ).toBe(400);
  });

  it('recusa arquivo expirado ou inexistente e formatos não suportados', async () => {
    const r = await post('/tools/jobs', {
      tool: 'convert',
      uploadIds: ['00000000-0000-4000-8000-000000000000'],
      params: { outputFormat: 'xlsx' },
    });
    expect(r.statusCode).toBe(410);
    expect((await upload('a.pdf', 'x')).json().error.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('exige autenticação', async () => {
    expect((await app.inject({ method: 'GET', url: '/tools/jobs' })).statusCode).toBe(401);
  });
});
