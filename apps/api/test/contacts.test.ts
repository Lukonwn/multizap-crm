import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let s: Session;
let A: string;
let B: string;

beforeAll(async () => {
  ({ app, prisma, redis } = await setupTestApp());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await createAdmin(prisma);
  s = await login(app);
  A = (await prisma.account.create({ data: { name: 'Conta A', connectionType: 'WHATSAPP_WEB' } }))
    .id;
  B = (await prisma.account.create({ data: { name: 'Conta B', connectionType: 'WHATSAPP_WEB' } }))
    .id;
});

const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s, method !== 'GET'), payload });
const create = (account: string, payload: object) =>
  req('POST', `/accounts/${account}/contacts`, payload);

describe('cadastro e isolamento por instância', () => {
  it('cadastra com telefone normalizado e consentimento documentado', async () => {
    const r = await create(A, {
      name: 'Ana',
      phone: '(11) 98765-4321',
      consent: { source: 'Pediu contato na loja' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().contact).toMatchObject({
      name: 'Ana',
      phoneE164: '+5511987654321',
      origin: 'MANUAL',
      consentStatus: 'GRANTED',
    });
    expect(await prisma.consentEvent.count()).toBe(1);
  });

  it('o mesmo telefone pode existir em instâncias diferentes como registros independentes', async () => {
    expect((await create(A, { phone: '11987654321' })).statusCode).toBe(201);
    expect((await create(B, { phone: '11987654321' })).statusCode).toBe(201);
    const dup = await create(A, { phone: '+55 11 98765-4321' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('CONTACT_EXISTS');
    expect(await prisma.contact.count()).toBe(2);
  });

  it('nunca expõe ou altera contatos de outra instância (verificação de propriedade)', async () => {
    const c = (await create(A, { name: 'Ana', phone: '11987654321' })).json().contact;
    expect((await req('GET', `/accounts/${B}/contacts/${c.id}`)).statusCode).toBe(404);
    expect((await req('PATCH', `/accounts/${B}/contacts/${c.id}`, { name: 'x' })).statusCode).toBe(
      404,
    );
    expect((await req('DELETE', `/accounts/${B}/contacts/${c.id}`)).statusCode).toBe(404);
    expect((await req('POST', `/accounts/${B}/contacts/${c.id}/opt-out`, {})).statusCode).toBe(404);
    expect((await req('GET', `/accounts/${B}/contacts`)).json().total).toBe(0);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).name).toBe('Ana');
  });

  it('não permite usar etiquetas de outra instância', async () => {
    const tagB = (await req('POST', `/accounts/${B}/tags`, { name: 'vip' })).json().tag;
    const r = await create(A, { phone: '11987654321', tagIds: [tagB.id] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_TAGS');
  });
});

describe('pesquisa, filtros e etiquetas', () => {
  it('pesquisa por nome ou telefone e filtra por etiqueta e consentimento', async () => {
    const vip = (await req('POST', `/accounts/${A}/tags`, { name: 'VIP', color: '#f59e0b' })).json()
      .tag;
    await create(A, { name: 'Ana Souza', phone: '11987654321', tagIds: [vip.id] });
    await create(A, { name: 'Bruno', phone: '21998765432', consent: { source: 'Formulário' } });
    await create(A, { name: 'Carla', phone: '31987651234' });
    const list = async (qs: string) => (await req('GET', `/accounts/${A}/contacts?${qs}`)).json();
    expect((await list('q=souza')).items.map((c: { name: string }) => c.name)).toEqual([
      'Ana Souza',
    ]);
    expect((await list('q=(21) 99876')).items.map((c: { name: string }) => c.name)).toEqual([
      'Bruno',
    ]);
    expect((await list(`tagId=${vip.id}`)).total).toBe(1);
    expect((await list('consent=GRANTED')).total).toBe(1);
    expect((await list('pageSize=2')).items).toHaveLength(2);
    expect((await list('pageSize=2')).total).toBe(3);
    const tags = (await req('GET', `/accounts/${A}/tags`)).json().items;
    expect(tags).toEqual([{ id: vip.id, name: 'VIP', color: '#f59e0b', contactCount: 1 }]);
  });

  it('edita somente os campos enviados e substitui etiquetas', async () => {
    const t1 = (await req('POST', `/accounts/${A}/tags`, { name: 't1' })).json().tag;
    const c = (
      await create(A, {
        name: 'Ana',
        phone: '11987654321',
        notes: 'cliente antiga',
        tagIds: [t1.id],
      })
    ).json().contact;
    const t2 = (await req('POST', `/accounts/${A}/tags`, { name: 't2' })).json().tag;
    const r = await req('PATCH', `/accounts/${A}/contacts/${c.id}`, {
      name: 'Ana Maria',
      tagIds: [t2.id],
    });
    expect(r.json().contact).toMatchObject({
      name: 'Ana Maria',
      notes: 'cliente antiga',
      tags: [{ name: 't2' }],
    });
  });
});

describe('consentimento e descadastramento', () => {
  it('descadastro registra opt-out, revoga consentimento e persiste após excluir o contato', async () => {
    const c = (
      await create(A, { name: 'Ana', phone: '11987654321', consent: { source: 'Formulário' } })
    ).json().contact;
    const out = await req('POST', `/accounts/${A}/contacts/${c.id}/opt-out`, {
      reason: 'Pediu para sair',
    });
    expect(out.json().contact).toMatchObject({ consentStatus: 'REVOKED' });
    expect(out.json().contact.optedOutAt).not.toBeNull();

    // consentimento não pode ser reativado sem reverter o descadastro
    const grant = await req('POST', `/accounts/${A}/contacts/${c.id}/consent`, {
      action: 'GRANTED',
      source: 'Formulário',
    });
    expect(grant.statusCode).toBe(409);

    await req('DELETE', `/accounts/${A}/contacts/${c.id}`);
    const again = await create(A, { phone: '11987654321', consent: { source: 'Nova tentativa' } });
    expect(again.json().contact).toMatchObject({ consentStatus: 'REVOKED' });
    expect(again.json().contact.optedOutAt).not.toBeNull();
    expect(again.json().warning).toContain('descadastrado');

    // o descadastro é por instância
    expect((await create(B, { phone: '11987654321' })).json().contact.optedOutAt).toBeNull();
  });

  it('reverter descadastro exige novo consentimento documentado e fica no histórico', async () => {
    const c = (await create(A, { phone: '11987654321' })).json().contact;
    await req('POST', `/accounts/${A}/contacts/${c.id}/opt-out`, {});
    expect((await req('POST', `/accounts/${A}/contacts/${c.id}/resubscribe`, {})).statusCode).toBe(
      400,
    );
    const r = await req('POST', `/accounts/${A}/contacts/${c.id}/resubscribe`, {
      source: 'Solicitou retorno por e-mail',
      evidence: 'ticket 123',
    });
    expect(r.json().contact).toMatchObject({ consentStatus: 'GRANTED', optedOutAt: null });
    expect(await prisma.optOut.count()).toBe(0);
    const history = (await req('GET', `/accounts/${A}/contacts/${c.id}/history`)).json().items as {
      title: string;
    }[];
    expect(history.map((h) => h.title)).toEqual(
      expect.arrayContaining([
        'Descadastrado',
        'Descadastramento revertido',
        'Consentimento registrado',
        'Consentimento revogado',
      ]),
    );
  });
});

describe('exportação', () => {
  it('exporta CSV (BOM, ";") apenas da instância, com filtros', async () => {
    await create(A, { name: 'Ana', phone: '11987654321', consent: { source: 'Formulário' } });
    await create(A, { name: 'Bruno', phone: '21998765432' });
    await create(B, { name: 'De Outra', phone: '31987651234' });
    const r = await req('GET', `/accounts/${A}/contacts/export?format=csv&consent=GRANTED`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toMatch(
      /attachment; filename="contatos-conta-a-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(r.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const text = r.rawPayload.toString('utf8');
    expect(text).toContain('nome;telefone;origem;consentimento');
    expect(text).toContain('Ana;+5511987654321;Cadastro manual;Autorizado');
    expect(text).not.toContain('Bruno');
    expect(text).not.toContain('De Outra');
  });

  it('exporta XLSX válido', async () => {
    await create(A, { name: 'Ana', phone: '11987654321' });
    const r = await req('GET', `/accounts/${A}/contacts/export?format=xlsx`);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.subarray(0, 2).toString()).toBe('PK'); // contêiner ZIP do XLSX
  });
});
