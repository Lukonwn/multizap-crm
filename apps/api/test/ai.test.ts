import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import type { GatewayClient } from '../src/lib/gateway';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

const KEY = 'sk-or-v1-chave-secreta-de-teste-1234';

/** OpenRouter falsa: responde conforme o caminho e guarda as requisições. */
const calls: { path: string; body: unknown; auth: string | null }[] = [];
let chatResponse: { status: number; body: unknown } = { status: 200, body: {} };
let keyResponse: { status: number; body: unknown } = {
  status: 200,
  body: { data: { label: 'teste', usage: 0.5, limit: null, is_free_tier: false } },
};
const MODELS = {
  data: [
    {
      id: 'openai/gpt-4o-mini',
      name: 'GPT-4o mini',
      context_length: 128000,
      pricing: { prompt: '0.00000015', completion: '0.0000006' },
      supported_parameters: ['temperature', 'max_tokens'],
    },
    { id: 'meta/llama', name: 'Llama', pricing: { prompt: '0', completion: '0' } },
  ],
};
const fakeFetch = (async (url: string, init: RequestInit) => {
  const path = new URL(url).pathname.replace('/api/v1', '');
  const headers = init.headers as Record<string, string>;
  calls.push({
    path,
    body: init.body ? JSON.parse(String(init.body)) : null,
    auth: headers.authorization ?? null,
  });
  const r =
    path === '/models'
      ? { status: 200, body: MODELS }
      : path === '/key'
        ? keyResponse
        : chatResponse;
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { 'content-type': 'application/json' },
  });
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
  await redis.del('multizap:ai:models');
  await gateway.rawQueue.drain(true);
  calls.length = 0;
  chatResponse = {
    status: 200,
    body: {
      model: 'openai/gpt-4o-mini',
      choices: [
        { message: { content: 'Oi! Sou a Bia, como posso ajudar?' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 12, cost: 0.00004 },
    },
  };
  keyResponse = {
    status: 200,
    body: { data: { label: 'teste', usage: 0.5, limit: null, is_free_tier: false } },
  };
  await createAdmin(prisma);
  s = await login(app);
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s), ...(payload && { payload }) });
const saveKey = () => send('PUT', '/ai/settings', { apiKey: KEY });
const persona = async (over: object = {}) =>
  (
    await send('POST', '/ai/personas', {
      name: 'Bia',
      age: 28,
      identity: 'Atendente da Loja Sol.',
      personality: 'Simpática.',
      emojiUsage: 'none',
      ...over,
    })
  ).json().persona;
const agent = async (personaId: string, over: object = {}) =>
  (
    await send('POST', '/ai/agents', {
      name: 'Vendas',
      personaId,
      model: 'openai/gpt-4o-mini',
      temperature: 0.5,
      ...over,
    })
  ).json().agent;

describe('configuração da OpenRouter', () => {
  it('exige login, guarda a chave criptografada e nunca a devolve', async () => {
    expect((await app.inject({ method: 'GET', url: '/ai/settings' })).statusCode).toBe(401);
    expect((await get('/ai/settings')).json()).toMatchObject({
      configured: false,
      canStoreKey: true,
    });
    expect((await saveKey()).statusCode).toBe(200);
    const row = await prisma.aiCredential.findFirstOrThrow();
    expect(Buffer.from(row.keyEnc).toString('latin1')).not.toContain(KEY);
    const settings = await get('/ai/settings');
    expect(settings.json()).toMatchObject({ configured: true, keyLast4: '1234' });
    expect(settings.body).not.toContain(KEY);
    const audits = await prisma.auditLog.findMany();
    expect(JSON.stringify(audits)).not.toContain(KEY);
    expect(audits.map((a) => a.action)).toContain('ai.key_updated');
    expect((await send('PUT', '/ai/settings', { apiKey: 'curta' })).statusCode).toBe(400);
  });

  it('testa a conexão e registra o resultado (sucesso e chave inválida)', async () => {
    expect((await send('POST', '/ai/settings/test')).json().error.code).toBe('AI_NOT_CONFIGURED');
    await saveKey();
    const ok = (await send('POST', '/ai/settings/test')).json();
    expect(ok).toMatchObject({ ok: true, info: { label: 'teste', usageUsd: 0.5 } });
    expect(calls.at(-1)).toMatchObject({ path: '/key', auth: `Bearer ${KEY}` });
    keyResponse = { status: 401, body: { error: { message: `invalid ${KEY}` } } };
    const bad = await send('POST', '/ai/settings/test');
    expect(bad.json()).toMatchObject({ ok: false });
    expect(bad.body).not.toContain(KEY);
    expect((await get('/ai/settings')).json()).toMatchObject({ lastTestOk: false });
    expect(
      await prisma.aiAgentEvent.count({ where: { category: 'OPENROUTER', level: 'error' } }),
    ).toBe(1);
    expect((await send('DELETE', '/ai/settings')).statusCode).toBe(200);
    expect((await get('/ai/settings')).json().configured).toBe(false);
  });

  it('lista modelos com preço por milhão, pesquisa e cache de 1 hora', async () => {
    expect((await get('/ai/models')).json().error.code).toBe('AI_NOT_CONFIGURED');
    await saveKey();
    const r = (await get('/ai/models')).json();
    expect(r.total).toBe(2);
    expect(r.items.find((m: { id: string }) => m.id === 'openai/gpt-4o-mini')).toMatchObject({
      promptPerMillion: 0.15,
      completionPerMillion: 0.6,
      supportsTemperature: true,
    });
    expect((await get('/ai/models?q=llama')).json().items.map((m: { id: string }) => m.id)).toEqual(
      ['meta/llama'],
    );
    expect(calls.filter((c) => c.path === '/models')).toHaveLength(1);
  });
});

describe('personas', () => {
  it('cria, edita com histórico, duplica, salva como template e usa template', async () => {
    const p = await persona({ expressions: ['Prontinho!'] });
    expect(p).toMatchObject({
      name: 'Bia',
      age: 28,
      formality: 'neutral',
      emojiUsage: 'none',
      expressions: ['Prontinho!'],
      isTemplate: false,
    });
    const edited = (
      await send('PATCH', `/ai/personas/${p.id}`, {
        personality: 'Animada.',
        formality: 'informal',
      })
    ).json().persona;
    expect(edited.personality).toBe('Animada.');
    await send('PATCH', `/ai/personas/${p.id}`, { personality: 'Animada.' }); // sem mudança: sem nova revisão
    const revs = (await get(`/ai/personas/${p.id}/revisions`)).json().items;
    expect(revs.map((r: { summary: string }) => r.summary)).toEqual([
      'Alterado: personalidade, formalidade',
      'Persona criada',
    ]);
    expect(revs[0].changedBy).toBe('admin@multizap.local');

    const copy = (await send('POST', `/ai/personas/${p.id}/duplicate`, {})).json().persona;
    expect(copy).toMatchObject({ name: 'Bia (cópia)', personality: 'Animada.', isTemplate: false });
    const tpl = (
      await send('POST', `/ai/personas/${p.id}/duplicate`, {
        asTemplate: true,
        name: 'Modelo atendente',
      })
    ).json().persona;
    expect(tpl.isTemplate).toBe(true);
    const fromTpl = (await send('POST', `/ai/personas/${tpl.id}/duplicate`, {})).json().persona;
    expect(fromTpl).toMatchObject({ name: 'Modelo atendente', isTemplate: false });
    expect((await get('/ai/personas?templates=true')).json().items).toHaveLength(1);
    expect((await get('/ai/personas?templates=false')).json().items).toHaveLength(3);
  });

  it('valida campos e exclui só com confirmação e quando não está em uso', async () => {
    expect((await send('POST', '/ai/personas', { name: 'B' })).statusCode).toBe(400);
    expect(
      (await send('POST', '/ai/personas', { name: 'Ok', emojiUsage: 'sempre' })).statusCode,
    ).toBe(400);
    const p = await persona();
    await agent(p.id);
    expect(
      (await send('DELETE', `/ai/personas/${p.id}`, { confirmName: 'Errado' })).json().error.code,
    ).toBe('CONFIRMATION_MISMATCH');
    expect(
      (await send('DELETE', `/ai/personas/${p.id}`, { confirmName: 'Bia' })).json().error.code,
    ).toBe('PERSONA_IN_USE');
    const free = await persona({ name: 'Livre' });
    expect(
      (await send('DELETE', `/ai/personas/${free.id}`, { confirmName: 'Livre' })).statusCode,
    ).toBe(200);
    expect(await prisma.aiPersona.count()).toBe(1);
  });
});

describe('agentes, instâncias e versões', () => {
  it('não usa template direto; cria com modo revisão humana por padrão', async () => {
    const tpl = await persona({ name: 'Modelo', isTemplate: true });
    expect(
      (await send('POST', '/ai/agents', { name: 'X1', personaId: tpl.id, model: 'm/x' }))
        .statusCode,
    ).toBe(400);
    const p = await persona();
    const a = await agent(p.id);
    expect(a).toMatchObject({
      mode: 'REVIEW',
      status: 'DRAFT',
      memoryEnabled: true,
      personaName: 'Bia',
      publishedVersion: null,
      hasUnpublishedChanges: true,
    });
  });

  it('vincula só dispositivos conectados e respeita um agente ativo por instância', async () => {
    const web = await prisma.account.create({
      data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    });
    const ext = await prisma.account.create({
      data: { name: 'Celular', connectionType: 'EXTERNAL_DEVICE' },
    });
    const p = await persona();
    const a = await agent(p.id);
    expect(
      (await send('PUT', `/ai/agents/${a.id}/accounts`, { accountIds: [ext.id] })).json().error
        .code,
    ).toBe('NOT_WHATSAPP_WEB');
    const linked = (
      await send('PUT', `/ai/agents/${a.id}/accounts`, { accountIds: [web.id] })
    ).json().agent;
    expect(linked.accounts).toEqual([
      expect.objectContaining({ id: web.id, name: 'Loja', status: 'CONNECTED', activeAgent: null }),
    ]);

    await prisma.aiAgent.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
    const b = await agent(p.id, { name: 'Suporte' });
    // B ainda é rascunho: pode vincular, mas vê o agente ativo da instância
    const bLinked = (
      await send('PUT', `/ai/agents/${b.id}/accounts`, { accountIds: [web.id] })
    ).json().agent;
    expect(bLinked.accounts[0].activeAgent).toEqual({ id: a.id, name: 'Vendas' });
    await prisma.aiAgent.update({ where: { id: b.id }, data: { status: 'ACTIVE' } });
    expect(
      (await send('PUT', `/ai/agents/${b.id}/accounts`, { accountIds: [web.id] })).json().error
        .code,
    ).toBe('ACCOUNT_HAS_ACTIVE_AGENT');
    // desvincular funciona
    expect(
      (await send('PUT', `/ai/agents/${a.id}/accounts`, { accountIds: [] })).json().agent.accounts,
    ).toEqual([]);
  });

  it('publica versões, detecta mudanças (inclusive da persona) e restaura', async () => {
    const p = await persona();
    const a = await agent(p.id);
    let pub = (await send('POST', `/ai/agents/${a.id}/publish`, { note: 'Primeira' })).json().agent;
    expect(pub).toMatchObject({ publishedVersion: { number: 1 }, hasUnpublishedChanges: false });
    await send('PATCH', `/ai/personas/${p.id}`, { personality: 'Mudou.' });
    expect((await get(`/ai/agents/${a.id}`)).json().agent.hasUnpublishedChanges).toBe(true);
    await send('PATCH', `/ai/agents/${a.id}`, { model: 'meta/llama', mode: 'AUTO' });
    pub = (await send('POST', `/ai/agents/${a.id}/publish`, {})).json().agent;
    expect(pub.publishedVersion.number).toBe(2);
    const versions = (await get(`/ai/agents/${a.id}/versions`)).json().items;
    expect(
      versions.map((v: { number: number; isPublished: boolean; model: string }) => [
        v.number,
        v.isPublished,
        v.model,
      ]),
    ).toEqual([
      [2, true, 'meta/llama'],
      [1, false, 'openai/gpt-4o-mini'],
    ]);
    const restored = (
      await send('POST', `/ai/agents/${a.id}/versions/${versions[1].id}/restore`)
    ).json();
    expect(restored.restoredFrom).toBe(1);
    expect(restored.agent).toMatchObject({
      model: 'openai/gpt-4o-mini',
      mode: 'REVIEW',
      publishedVersion: { number: 2 },
      hasUnpublishedChanges: true,
    });
    expect((await prisma.auditLog.findMany()).map((x) => x.action)).toEqual(
      expect.arrayContaining(['ai.agent_published', 'ai.agent_restored']),
    );
  });

  it('exclui com confirmação e nunca um agente ativo', async () => {
    const p = await persona();
    const a = await agent(p.id);
    await send('POST', `/ai/agents/${a.id}/publish`, {});
    await prisma.aiAgent.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
    expect(
      (await send('DELETE', `/ai/agents/${a.id}`, { confirmName: 'Vendas' })).json().error.code,
    ).toBe('AGENT_ACTIVE');
    await prisma.aiAgent.update({ where: { id: a.id }, data: { status: 'PAUSED' } });
    expect((await send('DELETE', `/ai/agents/${a.id}`, { confirmName: 'Vendas' })).statusCode).toBe(
      200,
    );
    expect(await prisma.aiAgentVersion.count()).toBe(0);
    expect(await prisma.aiPersona.count()).toBe(1);
  });
});

describe('laboratório', () => {
  it('conversa com o rascunho, usa a persona e as regras fixas, registra tokens e custo e não envia nada real', async () => {
    await saveKey();
    const p = await persona();
    const a = await agent(p.id, { instructions: 'Ofereça o catálogo.' });
    const session = (
      await send('POST', `/ai/agents/${a.id}/test-sessions`, { source: 'draft' })
    ).json().session;
    const r = (
      await send('POST', `/ai/test-sessions/${session.id}/messages`, { text: 'Oi, tudo bem?' })
    ).json();
    expect(r.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(r.messages[1]).toMatchObject({
      content: 'Oi! Sou a Bia, como posso ajudar?',
      debug: { promptTokens: 200, completionTokens: 12, costUsd: 0.00004, costConfirmed: true },
    });

    const chat = calls.find((c) => c.path === '/chat/completions')!;
    const body = chat.body as {
      model: string;
      temperature: number;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.temperature).toBe(0.5);
    expect(body.messages[0]!.content).toContain('Você é Bia, 28 anos.');
    expect(body.messages[0]!.content).toContain('Ofereça o catálogo.');
    expect(body.messages[0]!.content).toContain('não afirme ser humano');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Oi, tudo bem?' });

    // segunda mensagem leva o histórico
    await send('POST', `/ai/test-sessions/${session.id}/messages`, { text: 'Quanto custa?' });
    const second = calls.filter((c) => c.path === '/chat/completions')[1]!.body as {
      messages: unknown[];
    };
    expect(second.messages).toHaveLength(4);

    const usage = await prisma.aiTokenUsage.findMany();
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      context: 'TEST',
      agentId: a.id,
      promptTokens: 200,
      costConfirmed: true,
    });
    const totals = (await get(`/ai/test-sessions/${session.id}`)).json().session.totals;
    expect(totals).toMatchObject({ promptTokens: 400, completionTokens: 24 });
    expect(totals.costUsd).toBeCloseTo(0.00008);

    // nada foi para o gateway (nenhum envio real)
    expect(await gateway.rawQueue.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
  });

  it('sem custo informado, estima pela tabela de preços do modelo', async () => {
    await saveKey();
    chatResponse = {
      status: 200,
      body: {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000 },
      },
    };
    const a = await agent((await persona()).id);
    const session = (await send('POST', `/ai/agents/${a.id}/test-sessions`, {})).json().session;
    const r = (
      await send('POST', `/ai/test-sessions/${session.id}/messages`, { text: 'oi' })
    ).json();
    expect(r.messages[1].debug.costConfirmed).toBe(false);
    expect(r.messages[1].debug.costUsd).toBeCloseTo(1000 * 0.00000015 + 1000 * 0.0000006);
  });

  it('a sessão "publicada" usa a versão publicada, mesmo com o rascunho alterado', async () => {
    await saveKey();
    const p = await persona();
    const a = await agent(p.id);
    expect(
      (await send('POST', `/ai/agents/${a.id}/test-sessions`, { source: 'published' })).json().error
        .code,
    ).toBe('NOT_PUBLISHED');
    await send('POST', `/ai/agents/${a.id}/publish`, {});
    await send('PATCH', `/ai/agents/${a.id}`, { model: 'meta/llama' });
    await send('PATCH', `/ai/personas/${p.id}`, { name: 'Outra' });
    const session = (
      await send('POST', `/ai/agents/${a.id}/test-sessions`, { source: 'published' })
    ).json().session;
    expect(session.versionNumber).toBe(1);
    await send('POST', `/ai/test-sessions/${session.id}/messages`, { text: 'oi' });
    const body = calls.find((c) => c.path === '/chat/completions')!.body as {
      model: string;
      messages: { content: string }[];
    };
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.messages[0]!.content).toContain('Você é Bia');
  });

  it('erro da OpenRouter aparece na conversa e no monitoramento; sem chave avisa o que fazer', async () => {
    const a = await agent((await persona()).id);
    const session = (await send('POST', `/ai/agents/${a.id}/test-sessions`, {})).json().session;
    const noKey = (
      await send('POST', `/ai/test-sessions/${session.id}/messages`, { text: 'oi' })
    ).json();
    expect(noKey.messages[1]).toMatchObject({
      role: 'error',
      debug: { errorCode: 'AI_NOT_CONFIGURED' },
    });
    await saveKey();
    chatResponse = { status: 402, body: { error: { message: 'insufficient credits' } } };
    const r = (
      await send('POST', `/ai/test-sessions/${session.id}/messages`, { text: 'oi' })
    ).json();
    expect(r.messages[1]).toMatchObject({
      role: 'error',
      content: 'Sem créditos suficientes na OpenRouter.',
      debug: { errorCode: 'NO_CREDITS' },
    });
    expect(
      await prisma.aiAgentEvent.count({ where: { agentId: a.id, category: 'OPENROUTER' } }),
    ).toBe(1);
    expect(await prisma.aiTokenUsage.count()).toBe(0);
    // o histórico enviado ao modelo ignora mensagens de erro
    chatResponse = { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };
    await send('POST', `/ai/test-sessions/${session.id}/messages`, { text: 'de novo' });
    const body = calls.filter((c) => c.path === '/chat/completions').at(-1)!.body as {
      messages: { role: string }[];
    };
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'user', 'user']);
  });
});
