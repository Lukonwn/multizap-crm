import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import { HEARTBEAT_KEYS, type AiAnalyticsDTO, type AiHealthDTO } from '@multizap/shared';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

let keyCalls = 0;
let keyUsage = 3;
const fakeFetch = (async (url: string) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/key')) {
    keyCalls++;
    return new Response(
      JSON.stringify({ data: { label: 'x', usage: keyUsage, limit: 10, is_free_tier: false } }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}) as unknown as typeof fetch;

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let s: Session;

beforeAll(async () => {
  ({ app, prisma, redis } = await setupTestApp({}, { aiFetch: fakeFetch }));
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await redis.del('multizap:ai:keyinfo');
  await redis.del(HEARTBEAT_KEYS.worker);
  await redis.del(HEARTBEAT_KEYS.gateway);
  keyCalls = 0;
  keyUsage = 3;
  await createAdmin(prisma);
  s = await login(app);
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });
const send = (method: 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s), ...(payload && { payload }) });
const ago = (ms: number) => new Date(Date.now() - ms);
const DAY = 24 * 3_600_000;

async function seed() {
  const account = await prisma.account.create({
    data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
  });
  const other = await prisma.account.create({
    data: { name: 'Outra', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
  });
  const persona = await prisma.aiPersona.create({ data: { name: 'Ana' } });
  const A = await prisma.aiAgent.create({
    data: { name: 'Vendas', personaId: persona.id, model: 'm/x-model', status: 'ACTIVE' },
  });
  const B = await prisma.aiAgent.create({
    data: { name: 'Suporte', personaId: persona.id, model: 'm/x-model' },
  });
  const convs: Awaited<ReturnType<typeof prisma.conversation.create>>[] = [];
  for (let i = 0; i < 3; i++)
    convs.push(
      await prisma.conversation.create({
        data: {
          accountId: account.id,
          remoteJid: `55119777700${i}0@s.whatsapp.net`,
          lastMessageAt: new Date(),
        },
      }),
    );
  let n = 0;
  const draft = async (
    conv: (typeof convs)[number],
    over: Record<string, unknown>,
    inboundAt = ago(5 * 60_000),
  ) => {
    const m = await prisma.message.create({
      data: {
        accountId: account.id,
        conversationId: conv.id,
        providerMessageId: `in-${n++}`,
        direction: 'INBOUND',
        type: 'text',
        body: 'oi',
        status: 'RECEIVED',
        sentAt: inboundAt,
      },
    });
    return prisma.aiDraft.create({
      data: {
        conversationId: conv.id,
        agentId: A.id,
        inboundMessageId: m.id,
        body: 'Resposta',
        createdAt: new Date(inboundAt.getTime() + 2000),
        ...over,
      } as never,
    });
  };
  const t0 = ago(5 * 60_000);
  await draft(
    convs[0]!,
    {
      status: 'SENT',
      autoSent: true,
      sentBody: 'Resposta',
      decidedAt: new Date(t0.getTime() + 10_000),
      sources: [{ sourceId: 's1', name: 'Cardápio', snippet: 'x' }],
    },
    t0,
  );
  const d2 = await draft(
    convs[0]!,
    {
      status: 'SENT',
      sentBody: 'Resposta',
      sources: [
        { sourceId: 's1', name: 'Cardápio', snippet: 'x' },
        { sourceId: 's2', name: 'Políticas', snippet: 'y' },
      ],
    },
    ago(4 * 60_000),
  );
  await prisma.aiDraft.update({
    where: { id: d2.id },
    data: { decidedAt: new Date(d2.createdAt.getTime() + 60_000) },
  });
  const d3 = await draft(
    convs[1]!,
    { status: 'SENT', sentBody: 'Resposta editada' },
    ago(3 * 60_000),
  );
  await prisma.aiDraft.update({
    where: { id: d3.id },
    data: { decidedAt: new Date(d3.createdAt.getTime() + 120_000) },
  });
  await draft(convs[1]!, { status: 'DISCARDED' }, ago(2 * 60_000));
  await draft(convs[2]!, { status: 'PENDING' }, ago(60_000));
  // fora da janela de 30 dias
  await draft(
    convs[2]!,
    { status: 'SENT', autoSent: true, createdAt: ago(60 * DAY) },
    ago(60 * DAY),
  );

  const usage = (
    context: 'LIVE' | 'TEST' | 'GENERATOR',
    cost: number | null,
    over: Record<string, unknown> = {},
  ) =>
    prisma.aiTokenUsage.create({
      data: {
        agentId: A.id,
        accountId: account.id,
        context,
        model: 'm/x-model',
        promptTokens: 100,
        completionTokens: 10,
        costUsd: cost,
        ...over,
      } as never,
    });
  await usage('LIVE', 0.01, { purpose: 'reply' });
  await usage('LIVE', 0.01, { purpose: 'reply' });
  await usage('LIVE', 0.005, { purpose: 'memory' });
  await usage('TEST', 0.002);
  await usage('GENERATOR', 0.05, { agentId: null, accountId: null });
  await usage('LIVE', 9, { createdAt: ago(60 * DAY) }); // fora da janela

  await prisma.aiConversationState.create({
    data: { conversationId: convs[0]!.id, paused: true, pausedBy: 'human', pausedAt: new Date() },
  });
  await prisma.aiConversationState.create({
    data: {
      conversationId: convs[1]!.id,
      paused: true,
      pausedBy: 'minor',
      pausedReason: 'x',
      pausedAt: new Date(),
    },
  });
  await prisma.aiConversationState.create({
    data: {
      conversationId: convs[2]!.id,
      paused: true,
      pausedBy: 'admin',
      pausedAt: ago(60 * DAY),
    },
  });

  const item = await prisma.aiDeliverable.create({
    data: { code: 'guia', name: 'Guia', kind: 'TEXT', text: 'x' },
  });
  const dl = (status: 'SENT' | 'AWAITING_PAYMENT' | 'FAILED', conv: (typeof convs)[number]) =>
    prisma.aiDelivery.create({
      data: {
        conversationId: conv.id,
        deliverableId: item.id,
        itemName: 'Guia',
        itemCode: 'guia',
        agentId: A.id,
        status,
        ...(status === 'SENT' && { sentAt: new Date() }),
      },
    });
  const sent = await dl('SENT', convs[0]!);
  const waiting = await dl('AWAITING_PAYMENT', convs[1]!);
  await dl('FAILED', convs[2]!);
  await prisma.aiPayment.create({
    data: {
      deliveryId: sent.id,
      reference: 'MZ-AAAAAA',
      amountCents: 4990,
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      confirmedBy: 'admin',
    },
  });
  await prisma.aiPayment.create({
    data: { deliveryId: waiting.id, reference: 'MZ-BBBBBB', amountCents: 2000 },
  });
  return { account, other, A, B, convs };
}

describe('métricas da IA', () => {
  it('exige login e valida o período', async () => {
    expect((await app.inject({ method: 'GET', url: '/ai/analytics' })).statusCode).toBe(401);
    expect((await get('/ai/analytics?days=0')).statusCode).toBe(400);
    expect((await get('/ai/analytics?agentId=x')).statusCode).toBe(400);
  });

  it('sem dados: zeros e nulos honestos (nada inventado), com um ponto por dia', async () => {
    const r = (await get('/ai/analytics?days=7')).json() as AiAnalyticsDTO;
    expect(r.daily).toHaveLength(7);
    expect(r.totals).toMatchObject({
      replies: 0,
      conversations: 0,
      approvalRate: null,
      editedRate: null,
      knowledgeUseRate: null,
      responseSeconds: { median: null, p90: null },
    });
    expect(r.costPerReply).toBeNull();
    expect(r.deliveries.conversion).toBeNull();
    expect(r.usage.live).toMatchObject({ calls: 0, costUsd: null });
  });

  it('calcula cada número dos registros reais (e ignora o que está fora do período)', async () => {
    await seed();
    const r = (await get('/ai/analytics?days=30')).json() as AiAnalyticsDTO;
    expect(r.days).toBe(30);
    expect(r.daily).toHaveLength(30);
    expect(r.totals).toMatchObject({
      conversations: 3,
      replies: 5,
      autoSent: 1,
      approved: 2,
      discarded: 1,
      pending: 1,
    });
    expect(r.totals.approvalRate).toBeCloseTo(2 / 3, 6);
    expect(r.totals.editedRate).toBeCloseTo(1 / 2, 6);
    expect(r.totals.knowledgeUseRate).toBeCloseTo(2 / 5, 6);
    expect(r.totals.responseSeconds.median).toBeCloseTo(10, 0); // a resposta automática saiu em ~10 s
    expect(r.totals.reviewSeconds.median).toBeCloseTo(90, 0); // aprovações em 60 s e 120 s
    expect(r.totals.paused).toEqual({ human: 1, minor: 1 }); // o de 60 dias atrás não entra
    expect(r.usage.live.calls).toBe(3);
    expect(r.usage.live.costUsd).toBeCloseTo(0.025, 6);
    expect(r.usage.test.costUsd).toBeCloseTo(0.002, 6);
    expect(r.usage.generator).toMatchObject({ calls: 1 });
    expect(r.usage.generator.costUsd).toBeCloseTo(0.05, 6);
    expect(r.costPerReply).toBeCloseTo(0.025 / 5, 6);
    expect(r.perAgent).toHaveLength(1);
    expect(r.perAgent[0]).toMatchObject({
      name: 'Vendas',
      replies: 5,
      promptTokens: 300,
      completionTokens: 30,
    });
    expect(r.topSources).toEqual([
      { name: 'Cardápio', uses: 2 },
      { name: 'Políticas', uses: 1 },
    ]);
    expect(r.deliveries.byStatus).toEqual({ SENT: 1, AWAITING_PAYMENT: 1, FAILED: 1 });
    expect(r.deliveries.payments).toEqual({ created: 2, confirmed: 1, revenueCents: 4990 });
    expect(r.deliveries.conversion).toBeCloseTo(1 / 2, 6);
    // a série diária bate com os totais
    expect(r.daily.reduce((a, d) => a + d.replies, 0)).toBe(5);
    expect(r.daily.reduce((a, d) => a + d.autoSent, 0)).toBe(1);
    expect(r.daily.reduce((a, d) => a + d.deliveries, 0)).toBe(1);
    expect(r.daily.reduce((a, d) => a + d.costUsd, 0)).toBeCloseTo(0.025, 6);
    expect(r.daily.at(-1)!.replies).toBe(5);
  });

  it('período maior inclui o que estava fora; filtros por agente e instância', async () => {
    const w = await seed();
    const wide = (await get('/ai/analytics?days=90')).json() as AiAnalyticsDTO;
    expect(wide.totals.replies).toBe(6);
    expect(wide.usage.live.calls).toBe(4);
    const other = (await get(`/ai/analytics?agentId=${w.B.id}`)).json() as AiAnalyticsDTO;
    expect(other.totals.replies).toBe(0);
    expect(other.usage.live.calls).toBe(0);
    expect(other.deliveries.byStatus).toEqual({});
    const noAcct = (await get(`/ai/analytics?accountId=${w.other.id}`)).json() as AiAnalyticsDTO;
    expect(noAcct.totals.replies).toBe(0);
    expect(noAcct.usage.live.calls).toBe(0);
    const mine = (
      await get(`/ai/analytics?agentId=${w.A.id}&accountId=${w.account.id}`)
    ).json() as AiAnalyticsDTO;
    expect(mine.totals.replies).toBe(5);
    expect(mine.usage.live.calls).toBe(3);
  });
});

describe('saúde da IA', () => {
  const health = async () => (await get('/ai/health')).json() as AiHealthDTO;

  it('exige login', async () => {
    expect((await app.inject({ method: 'GET', url: '/ai/health' })).statusCode).toBe(401);
  });

  it('instalação vazia: sem alertas, sem agentes e com as 3 filas da IA', async () => {
    const h = await health();
    expect(h.alerts).toEqual([]);
    expect(h.agents).toEqual([]);
    expect(h.key).toMatchObject({ configured: false, remainingUsd: null });
    expect(h.queues.map((q) => q.name).sort()).toEqual([
      'ai-generator',
      'ai-inbound',
      'ai-knowledge',
    ]);
    expect(h.services).toEqual({ worker: false, gateway: false });
  });

  it('agente ativo sem chave, sem worker e sem gateway: alertas de erro com onde resolver', async () => {
    await seed();
    const h = await health();
    const texts = h.alerts.map((a) => a.text).join(' | ');
    expect(texts).toMatch(/chave da OpenRouter não está configurada/);
    expect(texts).toMatch(/worker não está respondendo/);
    expect(texts).toMatch(/gateway não está respondendo/);
    expect(h.alerts.find((a) => /chave/.test(a.text))).toMatchObject({
      level: 'error',
      href: '/ai/configuracoes',
    });
    expect(h.agents.find((a) => a.name === 'Vendas')).toMatchObject({
      status: 'ACTIVE',
      pendingDrafts: 1,
    });
  });

  it('serviços no ar e chave configurada: alertas somem; saldo vem da OpenRouter e fica em cache', async () => {
    await seed();
    await send('PUT', '/ai/settings', { apiKey: 'sk-or-chave-de-teste-1234' });
    await redis.set(HEARTBEAT_KEYS.worker, '1', 'EX', 60);
    await redis.set(HEARTBEAT_KEYS.gateway, '1', 'EX', 60);
    const h = await health();
    expect(h.key).toMatchObject({ configured: true, usageUsd: 3, limitUsd: 10, remainingUsd: 7 });
    expect(h.services).toEqual({ worker: true, gateway: true });
    expect(h.alerts.some((a) => /worker|gateway|chave/.test(a.text))).toBe(false);
    const calls = keyCalls;
    await health();
    expect(keyCalls).toBe(calls); // segunda leitura vem do cache
  });

  it('créditos quase no fim geram aviso', async () => {
    await send('PUT', '/ai/settings', { apiKey: 'sk-or-chave-de-teste-1234' });
    keyUsage = 9.6;
    const h = await health();
    expect(h.key.remainingUsd).toBeCloseTo(0.4, 6);
    expect(h.alerts.find((a) => /Créditos/.test(a.text))).toMatchObject({ level: 'warning' });
  });

  it('agente parado por erro, fontes com problema, entregas, pagamento declarado e menor travado viram alertas e contagens', async () => {
    const w = await seed();
    await prisma.aiAgent.update({ where: { id: w.B.id }, data: { status: 'ERROR' } });
    await prisma.aiAgentEvent.create({
      data: { agentId: w.B.id, category: 'OPENROUTER', level: 'error', message: 'Chave recusada' },
    });
    await prisma.aiKnowledgeSource.create({
      data: { name: 'Quebrada', kind: 'TEXT', content: 'x', status: 'ERROR', error: 'falhou' },
    });
    const stuck = await prisma.aiKnowledgeSource.create({
      data: { name: 'Presa', kind: 'TEXT', content: 'x', status: 'PROCESSING' },
    });
    await prisma.$executeRaw`UPDATE ai_knowledge_sources SET updated_at = now() - interval '30 minutes' WHERE id = ${stuck.id}::uuid`;
    await prisma.aiPayment.updateMany({
      where: { reference: 'MZ-BBBBBB' },
      data: { claimedAt: new Date() },
    });
    const h = await health();
    expect(h.agents.find((a) => a.name === 'Suporte')).toMatchObject({
      status: 'ERROR',
      lastError: { message: 'Chave recusada' },
    });
    expect(h.issues).toEqual({
      sourcesWithError: 1,
      sourcesStuck: 1,
      deliveriesFailed7d: 1,
      deliveriesBlocked7d: 0,
      paymentsClaimed: 1,
      minorLocksOpen: 1,
    });
    const texts = h.alerts.map((a) => a.text).join(' | ');
    expect(texts).toMatch(/"Suporte" parou por erro/);
    expect(texts).toMatch(/1 fonte\(s\) de conhecimento com erro/);
    expect(texts).toMatch(/presas em "processando"/);
    expect(texts).toMatch(/1 entrega\(s\) falharam/);
    expect(texts).toMatch(/dizem que pagaram/);
    expect(texts).toMatch(/travada\(s\) por possível menor/);
    expect(h.events[0]).toMatchObject({
      agentName: 'Suporte',
      category: 'OPENROUTER',
      level: 'error',
    });
  });

  it('reativar o agente resolve o alerta de agente parado', async () => {
    const w = await seed();
    await prisma.aiAgent.update({ where: { id: w.B.id }, data: { status: 'ERROR' } });
    await prisma.systemNotification.create({
      data: {
        severity: 'ERROR',
        category: 'INTEGRATION',
        title: 'IA parada por erro da OpenRouter',
        message: 'x',
        dedupeKey: `ai-agent-error:${w.B.id}`,
      },
    });
    // B precisa de versão publicada, chave e instância para ativar
    const v = await prisma.aiAgentVersion.create({
      data: { agentId: w.B.id, number: 1, snapshot: {} },
    });
    await prisma.aiAgent.update({ where: { id: w.B.id }, data: { publishedVersionId: v.id } });
    await prisma.aiAgentAccount.create({ data: { agentId: w.B.id, accountId: w.other.id } });
    await send('PUT', '/ai/settings', { apiKey: 'sk-or-chave-de-teste-1234' });
    expect((await send('POST', `/ai/agents/${w.B.id}/activate`)).statusCode).toBe(200);
    expect(
      (
        await prisma.systemNotification.findFirstOrThrow({
          where: { dedupeKey: `ai-agent-error:${w.B.id}` },
        })
      ).resolvedAt,
    ).not.toBeNull();
  });
});
