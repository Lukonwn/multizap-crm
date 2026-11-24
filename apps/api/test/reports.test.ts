import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { computeDailyMetrics, storeDailyMetrics, type PrismaClient } from '@multizap/database';
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

const TZ = 'America/Sao_Paulo';
const at = (iso: string) => new Date(iso);

/** Cenário com datas fixas (passado), para resultados determinísticos. */
async function seed() {
  A = (
    await prisma.account.create({
      data: {
        name: 'Vendas',
        connectionType: 'WHATSAPP_WEB',
        createdAt: at('2026-10-01T12:00:00Z'),
      },
    })
  ).id;
  B = (
    await prisma.account.create({
      data: {
        name: 'Suporte',
        connectionType: 'WHATSAPP_WEB',
        createdAt: at('2026-10-01T12:00:00Z'),
      },
    })
  ).id;
  const ana = await prisma.contact.create({
    data: {
      accountId: A,
      phoneE164: '+5511900000001',
      consentStatus: 'GRANTED',
      createdAt: at('2026-11-02T15:00:00Z'),
    },
  });
  const bia = await prisma.contact.create({
    data: {
      accountId: A,
      phoneE164: '+5511900000002',
      consentStatus: 'GRANTED',
      createdAt: at('2026-11-02T15:00:00Z'),
    },
  });
  await prisma.contact.create({
    data: {
      accountId: B,
      phoneE164: '+5511900000003',
      consentStatus: 'REVOKED',
      optedOutAt: at('2026-11-05T15:00:00Z'),
      createdAt: at('2026-10-20T15:00:00Z'),
    },
  });
  await prisma.consentEvent.createMany({
    data: [
      {
        accountId: A,
        contactId: ana.id,
        action: 'GRANTED',
        source: 'x',
        createdAt: at('2026-11-02T15:00:00Z'),
      },
      {
        accountId: A,
        contactId: bia.id,
        action: 'GRANTED',
        source: 'x',
        createdAt: at('2026-11-02T15:00:00Z'),
      },
    ],
  });
  await prisma.optOut.create({
    data: {
      accountId: B,
      phoneE164: '+5511900000003',
      source: 'x',
      createdAt: at('2026-11-05T15:00:00Z'),
    },
  });

  const camp = await prisma.campaign.create({
    data: {
      name: 'Novembro',
      status: 'COMPLETED',
      body: 'Oi',
      createdAt: at('2026-11-03T12:00:00Z'),
      completedAt: at('2026-11-04T12:00:00Z'),
    },
  });
  const ca = await prisma.campaignAccount.create({
    data: {
      campaignId: camp.id,
      accountId: A,
      status: 'COMPLETED',
      createdAt: at('2026-11-03T12:00:00Z'),
    },
  });
  const rAna = await prisma.campaignRecipient.create({
    data: {
      campaignAccountId: ca.id,
      accountId: A,
      contactId: ana.id,
      phoneE164: ana.phoneE164,
      status: 'READ',
      sentAt: at('2026-11-04T13:00:00Z'),
    },
  });
  const rBia = await prisma.campaignRecipient.create({
    data: {
      campaignAccountId: ca.id,
      accountId: A,
      contactId: bia.id,
      phoneE164: bia.phoneE164,
      status: 'DELIVERED',
      sentAt: at('2026-11-04T13:05:00Z'),
    },
  });
  await prisma.campaignRecipient.create({
    data: {
      campaignAccountId: ca.id,
      accountId: A,
      contactId: (
        await prisma.contact.create({
          data: {
            accountId: A,
            phoneE164: '+5511900000009',
            consentStatus: 'GRANTED',
            createdAt: at('2026-10-10T12:00:00Z'),
          },
        })
      ).id,
      phoneE164: '+5511900000009',
      status: 'FAILED',
      error: 'x',
      updatedAt: at('2026-11-04T13:10:00Z'),
    },
  });
  const conv = await prisma.conversation.create({
    data: { accountId: A, contactId: ana.id, remoteJid: '5511900000001@s.whatsapp.net' },
  });
  const conv2 = await prisma.conversation.create({
    data: { accountId: A, contactId: bia.id, remoteJid: '5511900000002@s.whatsapp.net' },
  });
  await prisma.message.createMany({
    data: [
      {
        accountId: A,
        conversationId: conv.id,
        providerMessageId: 'o1',
        direction: 'OUTBOUND',
        status: 'READ',
        campaignRecipientId: rAna.id,
        sentAt: at('2026-11-04T13:00:00Z'),
      },
      {
        accountId: A,
        conversationId: conv2.id,
        providerMessageId: 'o2',
        direction: 'OUTBOUND',
        status: 'DELIVERED',
        campaignRecipientId: rBia.id,
        sentAt: at('2026-11-04T13:05:00Z'),
      },
      // resposta da Ana 1h depois (conta como resposta à campanha)
      {
        accountId: A,
        conversationId: conv.id,
        providerMessageId: 'i1',
        direction: 'INBOUND',
        status: 'RECEIVED',
        sentAt: at('2026-11-04T14:00:00Z'),
      },
      // 02:30 UTC do dia 10 = 23:30 do dia 9 em São Paulo
      {
        accountId: A,
        conversationId: conv.id,
        providerMessageId: 'i2',
        direction: 'INBOUND',
        status: 'RECEIVED',
        sentAt: at('2026-11-10T02:30:00Z'),
      },
      // período anterior (outubro)
      {
        accountId: A,
        conversationId: conv.id,
        providerMessageId: 'o0',
        direction: 'OUTBOUND',
        status: 'SENT',
        sentAt: at('2026-10-25T12:00:00Z'),
      },
    ],
  });
}

beforeEach(async () => {
  await resetDb(prisma);
  await createAdmin(prisma);
  s = await login(app);
  await seed();
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });

describe('relatórios', () => {
  it('totais, série diária no fuso de São Paulo e comparação com o período anterior', async () => {
    const r = await get('/reports/summary?from=2026-11-01&to=2026-11-15');
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.timezone).toBe(TZ);
    expect(d.totals).toMatchObject({
      contactsCreated: 2,
      consentsGranted: 2,
      optOuts: 1,
      campaignsCreated: 1,
      campaignsCompleted: 1,
      messagesSent: 2,
      messagesDelivered: 2,
      messagesRead: 1,
      messagesFailed: 1,
      messagesReceived: 2,
    });
    expect(d.previousRange).toEqual({ from: '2026-10-17', to: '2026-10-31' });
    expect(d.previous).toMatchObject({ messagesSent: 1, contactsCreated: 1, messagesReceived: 0 });
    expect(d.series).toHaveLength(15);
    expect(d.series.find((p: { date: string }) => p.date === '2026-11-09').received).toBe(1);
    expect(d.series.find((p: { date: string }) => p.date === '2026-11-10').received).toBe(0);
    expect(d.series.find((p: { date: string }) => p.date === '2026-11-04')).toMatchObject({
      sent: 2,
      delivered: 2,
      read: 1,
      failed: 1,
      received: 1,
    });
    expect(d.snapshot).toEqual({ contacts: 4, authorized: 3, optedOut: 1 });
  });

  it('desempenho das campanhas inclui respostas recebidas após o envio', async () => {
    const d = (await get('/reports/summary?from=2026-11-01&to=2026-11-15')).json();
    expect(d.campaigns).toEqual([
      expect.objectContaining({
        name: 'Novembro',
        recipients: 3,
        sent: 2,
        delivered: 2,
        read: 1,
        failed: 1,
        replied: 1,
      }),
    ]);
  });

  it('filtra por instância', async () => {
    const a = (await get(`/reports/summary?from=2026-11-01&to=2026-11-15&accountId=${A}`)).json();
    const b = (await get(`/reports/summary?from=2026-11-01&to=2026-11-15&accountId=${B}`)).json();
    expect(a.totals.messagesSent).toBe(2);
    expect(b.totals).toMatchObject({ messagesSent: 0, optOuts: 1, campaignsCreated: 0 });
    expect(b.snapshot).toEqual({ contacts: 1, authorized: 0, optedOut: 1 });
    expect(b.byAccount.map((x: { accountName: string }) => x.accountName)).toEqual(['Suporte']);
    expect(b.campaigns).toEqual([]);
  });

  it('métricas consolidadas (daily_metrics) produzem o mesmo resultado que o cálculo ao vivo', async () => {
    const live = (await get('/reports/summary?from=2026-11-01&to=2026-11-15')).json();
    await storeDailyMetrics(
      prisma,
      await computeDailyMetrics(prisma, '2026-10-17', '2026-11-15', TZ),
    );
    // altera a fonte: o relatório deve usar o consolidado para dias encerrados
    await prisma.message.deleteMany({ where: { providerMessageId: 'i2' } });
    const stored = (await get('/reports/summary?from=2026-11-01&to=2026-11-15')).json();
    expect(stored.totals).toEqual(live.totals);
    expect(stored.series).toEqual(live.series);
    expect(await prisma.dailyMetric.count()).toBe(30 * 2);
    // o cálculo ao vivo (sem consolidado) já reflete a exclusão
    expect(
      (await computeDailyMetrics(prisma, '2026-11-09', '2026-11-09', TZ)).reduce(
        (n, r) => n + r.messagesReceived,
        0,
      ),
    ).toBe(0);
  });

  it('valida o período', async () => {
    expect((await get('/reports/summary?from=2026-11-15&to=2026-11-01')).statusCode).toBe(400);
    expect((await get('/reports/summary?from=2025-01-01&to=2026-11-01')).statusCode).toBe(400);
    expect((await get('/reports/summary?from=ontem&to=2026-11-01')).statusCode).toBe(400);
  });

  it('exporta CSV e XLSX', async () => {
    const csv = await get('/reports/export?from=2026-11-01&to=2026-11-15&format=csv');
    expect(csv.headers['content-disposition']).toContain('relatorio-2026-11-01-a-2026-11-15.csv');
    const text = csv.rawPayload.toString('utf8');
    expect(text).toContain('data;instancia;Contatos cadastrados');
    expect(text).toContain('2026-11-04;Vendas;0;0;0;2;2;1;1;1');
    expect(text.trim().split('\r\n').at(-1)).toBe('TOTAL;Todas as instâncias;2;2;1;2;2;1;1;2');
    const xlsx = await get('/reports/export?from=2026-11-01&to=2026-11-15&format=xlsx');
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });
});
