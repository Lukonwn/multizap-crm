import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import { HEARTBEAT_KEYS } from '@multizap/shared';
import type { GatewayClient } from '../src/lib/gateway';
import type { CampaignQueue } from '../src/lib/queues';
import { CampaignPreparer } from '../../worker/src/campaigns/preparer';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let gateway: GatewayClient;
let campaignQueue: CampaignQueue;
let preparer: CampaignPreparer;
let s: Session;
let A: string;
let B: string;
let vip: string;

beforeAll(async () => {
  ({ app, prisma, redis, gateway, campaignQueue } = await setupTestApp());
  preparer = new CampaignPreparer(prisma);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await gateway.rawQueue.drain(true);
  await campaignQueue.queue.drain(true);
  await redis.set(HEARTBEAT_KEYS.gateway, '1', 'EX', 60);
  await createAdmin(prisma);
  s = await login(app);
  A = (
    await prisma.account.create({
      data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    })
  ).id;
  B = (
    await prisma.account.create({
      data: { name: 'Suporte', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    })
  ).id;
  vip = (await prisma.tag.create({ data: { accountId: A, name: 'vip' } })).id;
  const ana = await prisma.contact.create({
    data: {
      accountId: A,
      name: 'Ana Souza',
      phoneE164: '+5511900000001',
      consentStatus: 'GRANTED',
    },
  });
  await prisma.contactTag.create({ data: { contactId: ana.id, tagId: vip } });
  const bia = await prisma.contact.create({
    data: { accountId: A, name: 'Bia', phoneE164: '+5511900000002', consentStatus: 'GRANTED' },
  });
  await prisma.contactTag.create({ data: { contactId: bia.id, tagId: vip } });
  await prisma.contact.create({
    data: { accountId: A, name: 'Caio', phoneE164: '+5511900000003', consentStatus: 'PENDING' },
  });
  await prisma.contact.create({
    data: {
      accountId: A,
      name: 'Davi',
      phoneE164: '+5511900000004',
      consentStatus: 'REVOKED',
      optedOutAt: new Date(),
    },
  });
  await prisma.contact.create({
    data: { accountId: B, name: 'Eva', phoneE164: '+5511900000005', consentStatus: 'GRANTED' },
  });
});

const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s, method !== 'GET'), payload });
const base = () => ({
  name: 'Black Friday',
  body: 'Olá, {{primeiro_nome}}! Até 50% off.',
  linkUrl: 'https://loja.example.com',
  accounts: [
    { accountId: A, tagIds: [vip] },
    { accountId: B, tagIds: [] },
  ],
});
const gatewayJobs = async () => (await gateway.rawQueue.getJobs(['waiting'])).map((j) => j.data);

async function readyCampaign() {
  const c = (await req('POST', '/campaigns', base())).json().campaign;
  expect((await req('POST', `/campaigns/${c.id}/prepare`)).statusCode).toBe(202);
  await preparer.prepare(c.id);
  return (await req('GET', `/campaigns/${c.id}`)).json().campaign;
}

describe('construtor de campanhas', () => {
  it('cria rascunho multicontas e registra o uso dos criativos', async () => {
    const img = await prisma.asset.create({ data: { kind: 'IMAGE', name: 'banner' } });
    const tpl = await prisma.asset.create({
      data: { kind: 'TEMPLATE', name: 'modelo', textContent: 'Olá {{nome}}' },
    });
    const r = await req('POST', '/campaigns', { ...base(), assetId: img.id, templateId: tpl.id });
    expect(r.statusCode).toBe(201);
    const c = r.json().campaign;
    expect(c).toMatchObject({
      status: 'DRAFT',
      accounts: [
        { accountName: 'Suporte', tagIds: [] },
        { accountName: 'Vendas', tagIds: [vip] },
      ],
    });
    expect(await prisma.assetUsage.count({ where: { campaignId: c.id } })).toBe(2);
  });

  it('recusa aparelho apenas cadastrado, etiqueta de outra instância, criativo inválido e variável desconhecida', async () => {
    const ext = (
      await prisma.account.create({
        data: { name: 'Ext', connectionType: 'EXTERNAL_DEVICE', phoneE164: '+5511999999999' },
      })
    ).id;
    expect(
      (
        await req('POST', '/campaigns', { ...base(), accounts: [{ accountId: ext, tagIds: [] }] })
      ).json().error.code,
    ).toBe('CHANNEL_CANNOT_SEND');
    expect(
      (
        await req('POST', '/campaigns', { ...base(), accounts: [{ accountId: B, tagIds: [vip] }] })
      ).json().error.code,
    ).toBe('INVALID_TAGS');
    const pdf = await prisma.asset.create({ data: { kind: 'FILE', name: 'pdf' } });
    expect(
      (await req('POST', '/campaigns', { ...base(), assetId: pdf.id })).json().error.code,
    ).toBe('INVALID_ASSET');
    expect((await req('POST', '/campaigns', { ...base(), body: 'Oi {{cupom}}' })).statusCode).toBe(
      400,
    );
  });

  it('pré-visualiza o público elegível (consentimento e descadastro)', async () => {
    const all = (
      await req('POST', '/campaigns/audience-preview', { accountId: A, tagIds: [] })
    ).json();
    expect(all).toMatchObject({ eligible: 2, total: 4, excludedOptedOut: 1, excludedNoConsent: 1 });
    expect(all.sample.name).toBe('Ana Souza');
    expect(
      (await req('POST', '/campaigns/audience-preview', { accountId: A, tagIds: [vip] })).json()
        .eligible,
    ).toBe(2);
  });

  it('só edita rascunhos; exclui rascunho; duplica', async () => {
    const c = (await req('POST', '/campaigns', base())).json().campaign;
    expect(
      (await req('PATCH', `/campaigns/${c.id}`, { ...base(), name: 'Novo nome' })).json().campaign
        .name,
    ).toBe('Novo nome');
    const dup = (await req('POST', `/campaigns/${c.id}/duplicate`)).json().campaign;
    expect(dup).toMatchObject({ name: 'Novo nome (cópia)', status: 'DRAFT' });
    await req('POST', `/campaigns/${c.id}/schedule`, {
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect((await req('PATCH', `/campaigns/${c.id}`, base())).json().error.code).toBe('NOT_DRAFT');
    expect((await req('DELETE', `/campaigns/${c.id}`)).json().error.code).toBe('CANNOT_DELETE');
    expect((await req('DELETE', `/campaigns/${dup.id}`)).statusCode).toBe(200);
  });
});

describe('agendamento e fila', () => {
  it('agenda para o futuro (sem enviar) e recusa datas passadas', async () => {
    const c = (await req('POST', '/campaigns', base())).json().campaign;
    expect(
      (
        await req('POST', `/campaigns/${c.id}/schedule`, {
          scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const r = await req('POST', `/campaigns/${c.id}/schedule`, { scheduledAt: when });
    expect(r.json().campaign).toMatchObject({ status: 'SCHEDULED', scheduledAt: when });
    expect(await gatewayJobs()).toEqual([]);
    expect((await req('POST', `/campaigns/${c.id}/unschedule`)).json().campaign.status).toBe(
      'DRAFT',
    );
  });

  it('preparar agora monta a fila com contatos elegíveis de cada instância', async () => {
    const c = await readyCampaign();
    expect(c.status).toBe('READY');
    expect(c.counters).toMatchObject({ total: 3, pending: 3, sent: 0 });
    expect(
      Object.fromEntries(
        c.accounts.map((a: { accountName: string; counters: { total: number } }) => [
          a.accountName,
          a.counters.total,
        ]),
      ),
    ).toEqual({ Vendas: 2, Suporte: 1 });
    expect(await prisma.message.count()).toBe(0);
  });
});

describe('envio assistido', () => {
  it('mostra o próximo destinatário com a mensagem personalizada', async () => {
    const c = await readyCampaign();
    const next = (await req('GET', `/campaigns/${c.id}/next?accountId=${A}`)).json();
    expect(next.remaining).toBe(2);
    expect(next.recipient.message).toBe('Olá, Ana! Até 50% off.\n\nhttps://loja.example.com');
  });

  it('pula automaticamente quem se descadastrou depois da preparação', async () => {
    const c = await readyCampaign();
    await prisma.contact.updateMany({
      where: { phoneE164: '+5511900000001' },
      data: { optedOutAt: new Date(), consentStatus: 'REVOKED' },
    });
    const next = (await req('GET', `/campaigns/${c.id}/next?accountId=${A}`)).json();
    expect(next).toMatchObject({ autoSkipped: 1, recipient: { name: 'Bia' } });
  });

  it('cada envio exige confirmação e é enviado ao gateway uma única vez', async () => {
    const c = await readyCampaign();
    const next = (await req('GET', `/campaigns/${c.id}/next?accountId=${A}`)).json();
    const send = () => req('POST', `/campaigns/${c.id}/recipients/${next.recipient.id}/send`);
    expect((await send()).statusCode).toBe(202);
    expect((await send()).json().error.code).toBe('ALREADY_CONFIRMED');
    expect(await gatewayJobs()).toEqual([
      { type: 'send-campaign-message', accountId: A, recipientId: next.recipient.id },
    ]);
    // o confirmado sai da fila de "próximos"
    const after = (await req('GET', `/campaigns/${c.id}/next?accountId=${A}`)).json();
    expect(after.recipient.name).toBe('Bia');
    expect(await prisma.auditLog.count({ where: { action: 'campaign.message_confirmed' } })).toBe(
      1,
    );
  });

  it('bloqueia envio com instância desconectada, campanha pausada ou pausa global', async () => {
    const c = await readyCampaign();
    const rid = (await req('GET', `/campaigns/${c.id}/next?accountId=${A}`)).json().recipient.id;
    const send = () => req('POST', `/campaigns/${c.id}/recipients/${rid}/send`);
    await prisma.account.update({ where: { id: A }, data: { status: 'DISCONNECTED' } });
    expect((await send()).json().error.code).toBe('ACCOUNT_NOT_CONNECTED');
    await prisma.account.update({ where: { id: A }, data: { status: 'CONNECTED' } });

    expect((await req('POST', `/campaigns/${c.id}/pause`)).json().campaign.status).toBe('PAUSED');
    expect((await send()).json().error.code).toBe('CAMPAIGN_NOT_ACTIVE');
    expect((await req('POST', `/campaigns/${c.id}/resume`)).json().campaign.status).toBe('READY');

    await prisma.systemSetting.create({ data: { key: 'operations_paused', value: true } });
    expect((await send()).json().error.code).toBe('OPERATIONS_PAUSED');
    expect(await gatewayJobs()).toEqual([]);
  });

  it('pular, cancelar (pendentes saem da fila) e tentar novamente após falha', async () => {
    const c = await readyCampaign();
    const first = (await req('GET', `/campaigns/${c.id}/next?accountId=${B}`)).json().recipient;
    expect(
      (
        await req('POST', `/campaigns/${c.id}/recipients/${first.id}/skip`, {
          reason: 'Cliente pediu outro canal',
        })
      ).statusCode,
    ).toBe(200);
    const childB = (await req('GET', `/campaigns/${c.id}`))
      .json()
      .campaign.accounts.find((a: { accountId: string }) => a.accountId === B);
    expect(childB).toMatchObject({ status: 'COMPLETED', counters: { skipped: 1 } });

    const rA = await prisma.campaignRecipient.findFirstOrThrow({ where: { accountId: A } });
    await prisma.campaignRecipient.update({
      where: { id: rA.id },
      data: { status: 'FAILED', error: 'x' },
    });
    expect((await req('POST', `/campaigns/${c.id}/recipients/${rA.id}/retry`)).statusCode).toBe(
      200,
    );
    expect(
      (await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: rA.id } })).status,
    ).toBe('PENDING');

    const cancelled = (await req('POST', `/campaigns/${c.id}/cancel`)).json().campaign;
    expect(cancelled.status).toBe('CANCELLED');
    expect(await prisma.campaignRecipient.count({ where: { status: 'PENDING' } })).toBe(0);
    const recips = (await req('GET', `/campaigns/${c.id}/recipients?status=SKIPPED`)).json();
    expect(recips.total).toBe(3);
  });
});
