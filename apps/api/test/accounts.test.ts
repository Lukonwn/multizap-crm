import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import { HEARTBEAT_KEYS, MAX_ACCOUNTS, gatewayKeys } from '@multizap/shared';
import type { GatewayClient } from '../src/lib/gateway';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let gateway: GatewayClient;
let s: Session;

beforeAll(async () => {
  ({ app, prisma, redis, gateway } = await setupTestApp());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await gateway.rawQueue.drain(true);
  await redis.set(HEARTBEAT_KEYS.gateway, '1', 'EX', 60);
  await createAdmin(prisma);
  s = await login(app);
});

const post = (url: string, payload?: object) =>
  app.inject({ method: 'POST', url, headers: authed(s), payload });
const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });
const create = (payload: object) => post('/accounts', payload);
const jobs = async () => (await gateway.rawQueue.getJobs(['waiting'])).map((j) => j.data);

describe('cadastro de instâncias', () => {
  it('cadastra instância de dispositivo conectado como "Não configurada"', async () => {
    const r = await create({ name: 'Vendas', connectionType: 'WHATSAPP_WEB' });
    expect(r.statusCode).toBe(201);
    expect(r.json().account).toMatchObject({
      name: 'Vendas',
      status: 'NOT_CONFIGURED',
      connectionType: 'WHATSAPP_WEB',
      integration: null,
    });
    expect(await prisma.auditLog.count({ where: { action: 'account.created' } })).toBe(1);
    expect(await prisma.connectionEvent.count({ where: { type: 'created' } })).toBe(1);
  });

  it('aparelho externo exige telefone e normaliza para E.164', async () => {
    const bad = await create({ name: 'Celular', connectionType: 'EXTERNAL_DEVICE' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields.phone).toBeDefined();
    const ok = await create({
      name: 'Celular',
      connectionType: 'EXTERNAL_DEVICE',
      phone: '(11) 98765-4321',
    });
    expect(ok.json().account.phoneE164).toBe('+5511987654321');
  });

  it(`permite exatamente ${MAX_ACCOUNTS} instâncias, mesmo com requisições simultâneas`, async () => {
    const results = await Promise.all(
      Array.from({ length: 13 }, (_, i) =>
        create({ name: `Instância ${i + 1}`, connectionType: 'WHATSAPP_WEB' }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(MAX_ACCOUNTS);
    const rejected = results.filter((r) => r.statusCode === 409);
    expect(rejected).toHaveLength(3);
    expect(rejected[0]!.json().error.code).toBe('ACCOUNT_LIMIT');
    expect(await prisma.account.count()).toBe(MAX_ACCOUNTS);
  });

  it('lista, detalha com capacidades e edita', async () => {
    const id = (await create({ name: 'Suporte', connectionType: 'WHATSAPP_WEB' })).json().account
      .id;
    const list = await get('/accounts');
    expect(list.json()).toMatchObject({ limit: MAX_ACCOUNTS, items: [{ id }] });
    const detail = await get(`/accounts/${id}`);
    expect(detail.json().capabilities).toMatchObject({ qrPairing: true, pairingCode: true });
    const upd = await app.inject({
      method: 'PATCH',
      url: `/accounts/${id}`,
      headers: authed(s),
      payload: { name: 'Suporte 2' },
    });
    expect(upd.json().account.name).toBe('Suporte 2');
  });

  it('não permite editar o telefone de um dispositivo conectado', async () => {
    const id = (await create({ name: 'Conta A', connectionType: 'WHATSAPP_WEB' })).json().account
      .id;
    const r = await app.inject({
      method: 'PATCH',
      url: `/accounts/${id}`,
      headers: authed(s),
      payload: { phone: '11987654321' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('PHONE_FROM_PAIRING');
  });

  it('aparelho externo não oferece pareamento', async () => {
    const id = (
      await create({ name: 'Ext', connectionType: 'EXTERNAL_DEVICE', phone: '11987654321' })
    ).json().account.id;
    expect((await get(`/accounts/${id}`)).json().capabilities).toMatchObject({
      qrPairing: false,
      sendMessage: false,
    });
    const r = await post(`/accounts/${id}/pairing`, { method: 'qr' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NOT_SUPPORTED');
  });

  it('retorna 404 para instância inexistente e 400 para id inválido', async () => {
    expect((await get('/accounts/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await get('/accounts/nao-e-uuid')).statusCode).toBe(400);
  });

  it('exige autenticação e CSRF', async () => {
    expect((await app.inject({ method: 'GET', url: '/accounts' })).statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: authed(s, false),
      payload: { name: 'X', connectionType: 'WHATSAPP_WEB' },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('pareamento', () => {
  it('QR Code: envia comando ao gateway e expõe o estado inicial', async () => {
    const id = (await create({ name: 'Conta A', connectionType: 'WHATSAPP_WEB' })).json().account
      .id;
    const r = await post(`/accounts/${id}/pairing`, { method: 'qr' });
    expect(r.statusCode).toBe(202);
    expect(await jobs()).toEqual([{ type: 'start-pairing', accountId: id, method: 'qr' }]);
    const st = await get(`/accounts/${id}/pairing`);
    expect(st.json().state).toMatchObject({ kind: 'starting', method: 'qr' });
  });

  it('número de telefone: normaliza o número antes de enviar ao gateway', async () => {
    const id = (await create({ name: 'Conta A', connectionType: 'WHATSAPP_WEB' })).json().account
      .id;
    await post(`/accounts/${id}/pairing`, { method: 'pairing-code', phone: '11 98765-4321' });
    expect(await jobs()).toEqual([
      { type: 'start-pairing', accountId: id, method: 'pairing-code', phoneE164: '+5511987654321' },
    ]);
    const bad = await post(`/accounts/${id}/pairing`, { method: 'pairing-code', phone: '123' });
    expect(bad.statusCode).toBe(400);
  });

  it('reflete o estado publicado pelo gateway (QR / código)', async () => {
    const id = (await create({ name: 'Conta A', connectionType: 'WHATSAPP_WEB' })).json().account
      .id;
    await redis.set(
      gatewayKeys.pairing(id),
      JSON.stringify({
        kind: 'pairing-code',
        code: 'ABCD1234',
        phoneE164: '+5511987654321',
        expiresAt: Date.now() + 60_000,
        at: Date.now(),
      }),
    );
    const st = await get(`/accounts/${id}/pairing`);
    expect(st.json().state).toMatchObject({ kind: 'pairing-code', code: 'ABCD1234' });
  });

  it('retorna 503 quando o gateway está fora do ar', async () => {
    await redis.del(HEARTBEAT_KEYS.gateway);
    const id = (await create({ name: 'Conta A', connectionType: 'WHATSAPP_WEB' })).json().account
      .id;
    const r = await post(`/accounts/${id}/pairing`, { method: 'qr' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('GATEWAY_UNAVAILABLE');
    expect(await jobs()).toEqual([]);
  });

  it('impede novo pareamento de instância já conectada ou desativada', async () => {
    const id = (await create({ name: 'Conta A', connectionType: 'WHATSAPP_WEB' })).json().account
      .id;
    await prisma.account.update({ where: { id }, data: { status: 'CONNECTED' } });
    expect((await post(`/accounts/${id}/pairing`, { method: 'qr' })).json().error.code).toBe(
      'ALREADY_CONNECTED',
    );
    await prisma.account.update({
      where: { id },
      data: { status: 'NOT_CONFIGURED', disabledAt: new Date() },
    });
    expect((await post(`/accounts/${id}/pairing`, { method: 'qr' })).json().error.code).toBe(
      'ACCOUNT_DISABLED',
    );
  });

  it('cancela o pareamento', async () => {
    const id = (await create({ name: 'Conta A', connectionType: 'WHATSAPP_WEB' })).json().account
      .id;
    await post(`/accounts/${id}/pairing`, { method: 'qr' });
    const r = await app.inject({
      method: 'DELETE',
      url: `/accounts/${id}/pairing`,
      headers: authed(s),
    });
    expect(r.statusCode).toBe(200);
    expect((await jobs()).map((j) => j.type)).toContain('cancel-pairing');
    expect((await get(`/accounts/${id}/pairing`)).json().state).toBeNull();
  });
});

describe('operação e remoção (ações manuais)', () => {
  async function pairedAccount() {
    const id = (await create({ name: 'Loja Centro', connectionType: 'WHATSAPP_WEB' })).json()
      .account.id;
    await prisma.integration.create({
      data: {
        accountId: id,
        provider: 'whatsapp-web',
        pairedAt: new Date(),
        credentialsEnc: new Uint8Array([1, 2, 3]),
      },
    });
    await prisma.integrationKey.create({
      data: { accountId: id, type: 'session', keyId: 'k', valueEnc: new Uint8Array([4]) },
    });
    await prisma.account.update({ where: { id }, data: { status: 'CONNECTED' } });
    return id;
  }

  it('desativar preserva as credenciais e reativar solicita reconexão', async () => {
    const id = await pairedAccount();
    const off = await post(`/accounts/${id}/disable`);
    expect(off.json().account.status).toBe('DISABLED');
    expect((await jobs()).map((j) => j.type)).toEqual(['stop']);
    expect(
      (await prisma.integration.findUniqueOrThrow({ where: { accountId: id } })).credentialsEnc,
    ).not.toBeNull();

    const on = await post(`/accounts/${id}/enable`);
    expect(on.json().account.status).toBe('DISCONNECTED');
    expect((await jobs()).map((j) => j.type)).toContain('reconnect');
  });

  it('remover conexão exige digitar o nome da instância', async () => {
    const id = await pairedAccount();
    const wrong = await post(`/accounts/${id}/remove-connection`, { confirmName: 'outro nome' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('CONFIRMATION_MISMATCH');
    expect(await jobs()).toEqual([]);
    const ok = await post(`/accounts/${id}/remove-connection`, { confirmName: 'Loja Centro' });
    expect(ok.statusCode).toBe(202);
    expect(await jobs()).toEqual([{ type: 'remove', accountId: id }]);
  });

  it('sem gateway ativo, remover conexão apaga as credenciais diretamente', async () => {
    const id = await pairedAccount();
    await redis.del(HEARTBEAT_KEYS.gateway);
    await post(`/accounts/${id}/remove-connection`, { confirmName: 'Loja Centro' });
    const integ = await prisma.integration.findUniqueOrThrow({ where: { accountId: id } });
    expect(integ.credentialsEnc).toBeNull();
    expect(integ.pairedAt).toBeNull();
    expect(await prisma.integrationKey.count({ where: { accountId: id } })).toBe(0);
    expect((await prisma.account.findUniqueOrThrow({ where: { id } })).statusReason).toBe(
      'removed_by_admin',
    );
  });

  it('reconectar exige sessão pareada e não se aplica a "Requer novo pareamento"', async () => {
    const fresh = (await create({ name: 'Nova', connectionType: 'WHATSAPP_WEB' })).json().account
      .id;
    expect((await post(`/accounts/${fresh}/reconnect`)).json().error.code).toBe('NOT_PAIRED');
    const id = await pairedAccount();
    await prisma.account.update({ where: { id }, data: { status: 'NEEDS_REPAIR' } });
    expect((await post(`/accounts/${id}/reconnect`)).json().error.code).toBe('NEEDS_REPAIR');
    await prisma.account.update({ where: { id }, data: { status: 'ATTENTION' } });
    expect((await post(`/accounts/${id}/reconnect`)).statusCode).toBe(202);
  });

  it('excluir instância exige confirmação, desvincula e remove todos os dados', async () => {
    const id = await pairedAccount();
    const del = (confirmName: string) =>
      app.inject({
        method: 'DELETE',
        url: `/accounts/${id}`,
        headers: authed(s),
        payload: { confirmName },
      });
    expect((await del('errado')).statusCode).toBe(400);
    expect((await del('Loja Centro')).statusCode).toBe(200);
    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.integration.count()).toBe(0);
    expect(await prisma.integrationKey.count()).toBe(0);
    expect(await jobs()).toEqual([{ type: 'remove', accountId: id }]);
    expect(await prisma.auditLog.count({ where: { action: 'account.deleted' } })).toBe(1);
  });

  it('histórico de eventos é isolado por instância', async () => {
    const a = (await create({ name: 'Conta A', connectionType: 'WHATSAPP_WEB' })).json().account.id;
    const b = (await create({ name: 'Conta B', connectionType: 'WHATSAPP_WEB' })).json().account.id;
    await prisma.connectionEvent.create({
      data: { accountId: a, type: 'connected', message: 'só de A' },
    });
    const evB = (await get(`/accounts/${b}/events`)).json().items as { message: string }[];
    expect(evB.map((e) => e.message)).not.toContain('só de A');
    const evA = (await get(`/accounts/${a}/events`)).json().items as { message: string }[];
    expect(evA.map((e) => e.message)).toContain('só de A');
  });
});

describe('dashboard e notificações', () => {
  it('resume instâncias, contatos, campanhas, atividades e alertas reais', async () => {
    const a = (await create({ name: 'Conta A', connectionType: 'WHATSAPP_WEB' })).json().account.id;
    await create({ name: 'Conta B', connectionType: 'EXTERNAL_DEVICE', phone: '11987654321' });
    await prisma.account.update({ where: { id: a }, data: { status: 'CONNECTED' } });
    await prisma.contact.createMany({
      data: [
        { accountId: a, phoneE164: '+5511900000001', consentStatus: 'GRANTED' },
        {
          accountId: a,
          phoneE164: '+5511900000002',
          consentStatus: 'GRANTED',
          optedOutAt: new Date(),
        },
        { accountId: a, phoneE164: '+5511900000003' },
      ],
    });
    await prisma.campaign.createMany({
      data: [
        { name: 'c1', status: 'SCHEDULED' },
        { name: 'c2', status: 'COMPLETED' },
        { name: 'c3' },
      ],
    });
    await prisma.connectionEvent.create({
      data: { accountId: a, type: 'paired', message: 'Dispositivo pareado e conectado.' },
    });
    await prisma.systemNotification.create({
      data: {
        severity: 'ERROR',
        category: 'CONNECTION',
        title: 'Alerta',
        message: 'm',
        accountId: a,
      },
    });

    const r = await get('/dashboard/summary');
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.accounts.total).toBe(2);
    expect(d.accounts.byStatus.CONNECTED).toBe(1);
    expect(d.contacts).toEqual({ total: 3, consented: 1 });
    expect(d.campaigns).toEqual({ total: 3, scheduled: 1, completed: 1 });
    expect(d.connections).toHaveLength(2);
    expect(
      d.activity.some(
        (x: { type: string; accountName: string }) =>
          x.type === 'paired' && x.accountName === 'Conta A',
      ),
    ).toBe(true);
    expect(d.activity.some((x: { type: string }) => x.type === 'account.created')).toBe(true);
    expect(d.alerts).toHaveLength(1);
  });

  it('lista e marca notificações como lidas', async () => {
    const n = await prisma.systemNotification.create({
      data: { severity: 'WARNING', category: 'CONNECTION', title: 'T', message: 'M' },
    });
    await prisma.systemNotification.create({
      data: {
        severity: 'INFO',
        category: 'SYSTEM',
        title: 'Resolvida',
        message: 'M',
        resolvedAt: new Date(),
      },
    });
    const list = await get('/notifications');
    expect(list.json()).toMatchObject({ unread: 1, items: [{ id: n.id }] });
    expect((await post(`/notifications/${n.id}/read`)).statusCode).toBe(200);
    expect((await get('/notifications')).json().unread).toBe(0);
  });
});
