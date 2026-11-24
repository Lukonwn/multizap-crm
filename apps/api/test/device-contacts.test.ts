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
  A = (await prisma.account.create({ data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB' } }))
    .id;
  B = (await prisma.account.create({ data: { name: 'Suporte', connectionType: 'WHATSAPP_WEB' } }))
    .id;
  await prisma.waIdentity.createMany({
    data: [
      {
        accountId: A,
        jid: '5511900000001@s.whatsapp.net',
        phoneE164: '+5511900000001',
        savedName: 'Ana Souza',
      },
      {
        accountId: A,
        jid: '5511900000002@s.whatsapp.net',
        phoneE164: '+5511900000002',
        pushName: 'Bruno',
      },
      {
        accountId: A,
        jid: '5511900000003@s.whatsapp.net',
        phoneE164: '+5511900000003',
        savedName: 'Carla Dias',
      },
      { accountId: A, jid: '188@lid', lid: '188@lid', pushName: 'Sem telefone' },
      {
        accountId: B,
        jid: '5511911111111@s.whatsapp.net',
        phoneE164: '+5511911111111',
        savedName: 'Outra instância',
      },
    ],
  });
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });
const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: authed(s), payload });

describe('agenda do aparelho', () => {
  it('exige autenticação e isola por instância', async () => {
    expect(
      (await app.inject({ method: 'GET', url: `/accounts/${A}/device-contacts` })).statusCode,
    ).toBe(401);
    const r = (await get(`/accounts/${A}/device-contacts`)).json();
    expect(r.total).toBe(4);
    expect(r.stats).toEqual({ identities: 4, withPhone: 3, withSavedName: 2 });
    expect(JSON.stringify(r)).not.toContain('Outra instância');
    expect((await get(`/accounts/${B}/device-contacts`)).json().total).toBe(1);
    expect(
      (await get('/accounts/00000000-0000-0000-0000-000000000000/device-contacts')).statusCode,
    ).toBe(404);
  });

  it('pesquisa por nome e telefone e marca quem já está em Contatos', async () => {
    await prisma.contact.create({
      data: { accountId: A, phoneE164: '+5511900000001', name: 'Ana CRM' },
    });
    const r = (await get(`/accounts/${A}/device-contacts?q=souza`)).json();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      name: 'Ana Souza',
      phoneE164: '+5511900000001',
      inCrm: true,
    });
    expect((await get(`/accounts/${A}/device-contacts?q=9000000`)).json().total).toBe(3);
  });

  it('importa só o escolhido, com consentimento pendente, sem duplicar nem reativar descadastrados', async () => {
    await prisma.contact.create({
      data: { accountId: A, phoneE164: '+5511900000001', name: 'Ana CRM' },
    });
    await prisma.optOut.create({
      data: { accountId: A, phoneE164: '+5511900000003', source: 'x' },
    });
    const ids = (
      await prisma.waIdentity.findMany({ where: { accountId: A }, orderBy: { jid: 'asc' } })
    ).map((i) => i.id);
    const r = await post(`/accounts/${A}/device-contacts/import`, { ids });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ created: 2, alreadyInCrm: 1, withoutPhone: 1 });

    const all = await prisma.contact.findMany({
      where: { accountId: A },
      orderBy: { phoneE164: 'asc' },
    });
    expect(all.map((c) => [c.phoneE164, c.name])).toEqual([
      ['+5511900000001', 'Ana CRM'], // intacto
      ['+5511900000002', 'Bruno'],
      ['+5511900000003', 'Carla Dias'],
    ]);
    expect(all[1]).toMatchObject({
      consentStatus: 'PENDING',
      origin: 'OTHER',
      originDetail: 'Agenda do aparelho conectado',
      optedOutAt: null,
    });
    expect(all[2]).toMatchObject({ consentStatus: 'REVOKED' }); // descadastro anterior prevalece
    expect(all[2]!.optedOutAt).not.toBeNull();
    expect(await prisma.contact.count({ where: { accountId: B } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'contact.imported_from_device' } })).toBe(
      1,
    );

    // repetir não duplica
    expect((await post(`/accounts/${A}/device-contacts/import`, { ids })).json().created).toBe(0);
  });

  it('não importa identidades de outra instância e valida o corpo', async () => {
    const other = (await prisma.waIdentity.findFirstOrThrow({ where: { accountId: B } })).id;
    const r = (await post(`/accounts/${A}/device-contacts/import`, { ids: [other] })).json();
    expect(r).toEqual({ created: 0, alreadyInCrm: 0, withoutPhone: 0 });
    expect(await prisma.contact.count()).toBe(0);
    expect((await post(`/accounts/${A}/device-contacts/import`, { ids: [] })).statusCode).toBe(400);
    expect((await post(`/accounts/${A}/device-contacts/import`, { ids: ['x'] })).statusCode).toBe(
      400,
    );
    const noCsrf = await app.inject({
      method: 'POST',
      url: `/accounts/${A}/device-contacts/import`,
      headers: authed(s, false),
      payload: { ids: [other] },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});
