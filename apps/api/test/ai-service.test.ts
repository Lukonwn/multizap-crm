import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import { HEARTBEAT_KEYS, type AiConversationDTO, type AiDraftDTO } from '@multizap/shared';
import type { GatewayClient } from '../src/lib/gateway';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

const fakeFetch = (async (url: string) => {
  const path = new URL(url).pathname;
  const body = path.endsWith('/models') ? { data: [] } : { data: { label: 'x', usage: 0 } };
  return new Response(JSON.stringify(body), { status: 200 });
}) as unknown as typeof fetch;

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let gateway: GatewayClient;
let s: Session;

beforeAll(async () => {
  ({ app, prisma, redis, gateway } = await setupTestApp({}, { aiFetch: fakeFetch }));
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

const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s), ...(payload && { payload }) });

/** Instância conectada, conversa com mensagem do contato e agente publicado ligado à instância. */
async function world(opts: { publish?: boolean; key?: boolean } = {}) {
  const account = await prisma.account.create({
    data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
  });
  const conv = await prisma.conversation.create({
    data: {
      accountId: account.id,
      remoteJid: '5511977776666@s.whatsapp.net',
      phoneE164: '+5511977776666',
      title: 'Cliente',
      lastMessageAt: new Date(),
      lastMessagePreview: 'Oi',
    },
  });
  const inbound = await prisma.message.create({
    data: {
      accountId: account.id,
      conversationId: conv.id,
      providerMessageId: 'in-1',
      direction: 'INBOUND',
      type: 'text',
      body: 'Quero um café',
      status: 'RECEIVED',
      sentAt: new Date(),
    },
  });
  const persona = (await send('POST', '/ai/personas', { name: 'Bia' })).json().persona;
  const agent = (
    await send('POST', '/ai/agents', {
      name: 'Vendas',
      personaId: persona.id,
      model: 'openai/gpt-4o-mini',
    })
  ).json().agent;
  await send('PUT', `/ai/agents/${agent.id}/accounts`, { accountIds: [account.id] });
  if (opts.key !== false)
    await send('PUT', '/ai/settings', { apiKey: 'sk-or-chave-de-teste-1234' });
  if (opts.publish !== false) await send('POST', `/ai/agents/${agent.id}/publish`, {});
  return { account, conv, inbound, agent };
}

const draftFor = (w: Awaited<ReturnType<typeof world>>, body = 'Claro! Qual café?') =>
  prisma.aiDraft.create({
    data: {
      conversationId: w.conv.id,
      agentId: w.agent.id,
      inboundMessageId: w.inbound.id,
      body,
    },
  });

describe('ativar e pausar agentes', () => {
  it('só ativa com versão publicada, chave e instância; pausa e reativa', async () => {
    const w = await world({ publish: false });
    let r = await send('POST', `/ai/agents/${w.agent.id}/activate`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NOT_PUBLISHED');

    await send('POST', `/ai/agents/${w.agent.id}/publish`, {});
    await prisma.aiCredential.deleteMany();
    r = await send('POST', `/ai/agents/${w.agent.id}/activate`);
    expect(r.json().error.code).toBe('AI_NOT_CONFIGURED');

    await send('PUT', '/ai/settings', { apiKey: 'sk-or-chave-de-teste-1234' });
    await send('PUT', `/ai/agents/${w.agent.id}/accounts`, { accountIds: [] });
    r = await send('POST', `/ai/agents/${w.agent.id}/activate`);
    expect(r.json().error.code).toBe('NO_ACCOUNTS');

    await send('PUT', `/ai/agents/${w.agent.id}/accounts`, { accountIds: [w.account.id] });
    r = await send('POST', `/ai/agents/${w.agent.id}/activate`);
    expect(r.statusCode).toBe(200);
    expect((await get(`/ai/agents/${w.agent.id}`)).json().agent.status).toBe('ACTIVE');

    expect((await send('POST', `/ai/agents/${w.agent.id}/pause`)).statusCode).toBe(200);
    expect((await get(`/ai/agents/${w.agent.id}`)).json().agent.status).toBe('PAUSED');
    expect((await send('POST', `/ai/agents/${w.agent.id}/pause`)).statusCode).toBe(409);
    expect((await send('POST', `/ai/agents/${w.agent.id}/activate`)).statusCode).toBe(200);
    const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['ai.agent_activated', 'ai.agent_paused']));
  });

  it('uma instância não pode ter dois agentes ativos', async () => {
    const w = await world();
    await send('POST', `/ai/agents/${w.agent.id}/activate`);
    const persona = (await send('POST', '/ai/personas', { name: 'Outra' })).json().persona;
    const other = (
      await send('POST', '/ai/agents', { name: 'Outro', personaId: persona.id, model: 'm/x-model' })
    ).json().agent;
    await send('PUT', `/ai/agents/${other.id}/accounts`, { accountIds: [w.account.id] });
    await send('POST', `/ai/agents/${other.id}/publish`, {});
    const r = await send('POST', `/ai/agents/${other.id}/activate`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('ACCOUNT_HAS_ACTIVE_AGENT');
  });

  it('ajustes operacionais (intervalo, digitando, limite) valem sem nova publicação', async () => {
    const w = await world();
    const before = (await get(`/ai/agents/${w.agent.id}`)).json().agent;
    expect(before).toMatchObject({
      minIntervalSeconds: 8,
      showTyping: true,
      maxRepliesPerHour: 10,
    });
    const r = await send('PATCH', `/ai/agents/${w.agent.id}`, {
      minIntervalSeconds: 20,
      showTyping: false,
      maxRepliesPerHour: 5,
    });
    expect(r.json().agent).toMatchObject({
      minIntervalSeconds: 20,
      showTyping: false,
      maxRepliesPerHour: 5,
      hasUnpublishedChanges: false,
    });
    expect(
      (await send('PATCH', `/ai/agents/${w.agent.id}`, { minIntervalSeconds: 999 })).statusCode,
    ).toBe(400);
  });
});

describe('rascunhos da IA (revisão humana)', () => {
  it('lista, aprova com edição e envia pelo gateway marcando a mensagem como da IA', async () => {
    const w = await world();
    const d = await draftFor(w);
    const list = (await get('/ai/drafts')).json().items as AiDraftDTO[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      body: 'Claro! Qual café?',
      inboundText: 'Quero um café',
      agentName: 'Vendas',
    });

    const r = await send('POST', `/ai/drafts/${d.id}/approve`, {
      text: 'Claro! Qual café você prefere?',
    });
    expect(r.statusCode).toBe(202);
    const msg = await prisma.message.findFirstOrThrow({
      where: { direction: 'OUTBOUND' },
      include: { aiLink: true },
    });
    expect(msg).toMatchObject({ status: 'PENDING', body: 'Claro! Qual café você prefere?' });
    expect(msg.aiLink).toMatchObject({ agentId: w.agent.id, source: 'review' });
    const jobs = await gateway.rawQueue.getJobs(['waiting', 'delayed']);
    expect(jobs.map((j) => j.data)).toEqual([
      { type: 'send-reply', accountId: w.account.id, messageId: msg.id },
    ]);
    expect(await prisma.aiDraft.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
      status: 'SENT',
      sentBody: 'Claro! Qual café você prefere?',
      messageId: msg.id,
    });
    // segundo clique não envia de novo
    expect((await send('POST', `/ai/drafts/${d.id}/approve`)).statusCode).toBe(409);
    expect(await prisma.message.count({ where: { direction: 'OUTBOUND' } })).toBe(1);
  });

  it('descarta; respeita descadastro e instância desconectada ao aprovar', async () => {
    const w = await world();
    const d = await draftFor(w);
    expect((await send('POST', `/ai/drafts/${d.id}/discard`)).statusCode).toBe(200);
    expect((await send('POST', `/ai/drafts/${d.id}/discard`)).statusCode).toBe(409);
    expect((await get('/ai/drafts')).json().items).toHaveLength(0);

    const m2 = await prisma.message.create({
      data: {
        accountId: w.account.id,
        conversationId: w.conv.id,
        providerMessageId: 'in-2',
        direction: 'INBOUND',
        type: 'text',
        body: 'Mais um',
        status: 'RECEIVED',
        sentAt: new Date(),
      },
    });
    const d2 = await prisma.aiDraft.create({
      data: { conversationId: w.conv.id, agentId: w.agent.id, inboundMessageId: m2.id, body: 'x' },
    });
    await prisma.optOut.create({
      data: {
        accountId: w.account.id,
        phoneE164: '+5511977776666',
        source: 'keyword',
        createdAt: new Date(Date.now() + 5000),
      },
    });
    let r = await send('POST', `/ai/drafts/${d2.id}/approve`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('REPLY_NOT_ALLOWED');
    await prisma.optOut.deleteMany();
    await prisma.account.update({ where: { id: w.account.id }, data: { status: 'DISCONNECTED' } });
    r = await send('POST', `/ai/drafts/${d2.id}/approve`);
    expect(r.json().error.code).toBe('REPLY_NOT_ALLOWED');
    // o rascunho continua pendente (nada foi consumido)
    expect((await prisma.aiDraft.findUniqueOrThrow({ where: { id: d2.id } })).status).toBe(
      'PENDING',
    );
    expect(await gateway.rawQueue.getJobs(['waiting', 'delayed'])).toHaveLength(0);
  });
});

describe('controle da IA por conversa', () => {
  it('lista com estado, pausa, retoma e libera após campanha', async () => {
    const w = await world();
    await send('POST', `/ai/agents/${w.agent.id}/activate`);
    let items = (await get('/ai/conversations')).json().items as AiConversationDTO[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: 'serving', agentName: 'Vendas', accountName: 'Loja' });

    await draftFor(w);
    items = (await get('/ai/conversations?filter=review')).json().items;
    expect(items[0]).toMatchObject({ state: 'review', pendingDrafts: 1 });

    await prisma.aiDraft.deleteMany();
    expect(
      (await send('PUT', `/ai/conversations/${w.conv.id}/state`, { paused: true })).statusCode,
    ).toBe(200);
    items = (await get('/ai/conversations?filter=paused')).json().items;
    expect(items[0]).toMatchObject({
      state: 'paused',
      pausedBy: 'admin',
      reason: 'IA pausada pelo administrador',
    });
    expect((await get('/ai/conversations?filter=serving')).json().items).toHaveLength(0);

    await send('PUT', `/ai/conversations/${w.conv.id}/state`, { paused: false, enabled: true });
    items = (await get('/ai/conversations')).json().items;
    expect(items[0]).toMatchObject({ state: 'serving', enabledOverride: true });
    expect((await send('PUT', `/ai/conversations/${w.conv.id}/state`, {})).statusCode).toBe(400);
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toEqual(
      expect.arrayContaining(['ai.conversation_paused', 'ai.conversation_resumed']),
    );
  });

  it('conversas de instâncias sem agente ativo não aparecem', async () => {
    await world();
    expect((await get('/ai/conversations')).json().items).toHaveLength(0);
  });

  it('quando uma pessoa responde pela Central, a IA pausa naquela conversa', async () => {
    const w = await world();
    await send('POST', `/ai/agents/${w.agent.id}/activate`);
    const r = await send('POST', `/conversations/${w.conv.id}/messages`, {
      text: 'Oi, sou o João',
    });
    expect(r.statusCode).toBe(202);
    const st = await prisma.aiConversationState.findFirstOrThrow();
    expect(st).toMatchObject({ paused: true, pausedBy: 'human' });
  });

  it('resposta manual em instância sem IA não cria estado', async () => {
    const w = await world();
    await send('POST', `/conversations/${w.conv.id}/messages`, { text: 'Oi' });
    expect(await prisma.aiConversationState.count()).toBe(0);
  });
});

describe('consumo', () => {
  it('separa uso real e testes, com custo somente do que tem preço', async () => {
    const w = await world();
    await prisma.aiTokenUsage.createMany({
      data: [
        {
          agentId: w.agent.id,
          accountId: w.account.id,
          context: 'LIVE',
          purpose: 'reply',
          model: 'm',
          promptTokens: 100,
          completionTokens: 10,
          costUsd: 0.001,
        },
        {
          agentId: w.agent.id,
          accountId: w.account.id,
          context: 'LIVE',
          purpose: 'memory',
          model: 'm',
          promptTokens: 50,
          completionTokens: 5,
          costUsd: 0.0005,
        },
        {
          agentId: w.agent.id,
          context: 'TEST',
          model: 'm',
          promptTokens: 20,
          completionTokens: 2,
          costUsd: null,
        },
      ],
    });
    const u = (await get(`/ai/usage?agentId=${w.agent.id}`)).json();
    expect(u.live).toMatchObject({ replies: 1, promptTokens: 150, completionTokens: 15 });
    expect(u.live.costUsd).toBeCloseTo(0.0015, 6);
    expect(u.test).toMatchObject({ calls: 1, promptTokens: 20, costUsd: null });
    expect((await get(`/ai/usage?accountId=${w.account.id}`)).json().test.calls).toBe(0);
  });
});
