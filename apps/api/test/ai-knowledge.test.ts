import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import type { LocalStorage } from '@multizap/storage';
import type { AiKnowledgeSourceDTO } from '@multizap/shared';
import type { KnowledgeQueue } from '../src/lib/queues';
import {
  authed,
  createAdmin,
  login,
  multipart,
  resetDb,
  setupTestApp,
  type Session,
} from './helpers';

const chatBodies: { messages: { role: string; content: string }[] }[] = [];
const fakeFetch = (async (url: string, init: RequestInit) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/chat/completions')) {
    chatBodies.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        model: 'openai/gpt-4o-mini',
        choices: [{ message: { content: 'O pacote custa R$ 42.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 8, cost: 0.0001 },
      }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
}) as unknown as typeof fetch;

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let storage: LocalStorage;
let knowledgeQueue: KnowledgeQueue;
let s: Session;

beforeAll(async () => {
  ({ app, prisma, redis, storage, knowledgeQueue } = (await setupTestApp(
    {},
    { aiFetch: fakeFetch },
  )) as never);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await knowledgeQueue.queue.drain(true);
  chatBodies.length = 0;
  await createAdmin(prisma);
  s = await login(app);
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s), ...(payload && { payload }) });
const upload = (name: string, content: Buffer | string, fields: Record<string, string> = {}) => {
  const mp = multipart(name, content, fields);
  return app.inject({
    method: 'POST',
    url: '/ai/knowledge/file',
    headers: { ...authed(s), 'content-type': mp.contentType },
    payload: mp.body,
  });
};
const jobs = async () =>
  (await knowledgeQueue.queue.getJobs(['waiting', 'delayed', 'active'])).map(
    (j) => j.data.sourceId,
  );

describe('fontes de conhecimento', () => {
  it('exige login', async () => {
    expect((await app.inject({ method: 'GET', url: '/ai/knowledge' })).statusCode).toBe(401);
  });

  it('cria texto, pergunta e resposta e link, e enfileira cada um para processamento', async () => {
    const t = await send('POST', '/ai/knowledge/text', {
      name: 'Políticas',
      content: 'Aceitamos trocas em até 7 dias.',
    });
    expect(t.statusCode).toBe(201);
    expect(t.json().source).toMatchObject({
      kind: 'TEXT',
      status: 'PENDING',
      name: 'Políticas',
      agents: [],
    });

    const qa = await send('POST', '/ai/knowledge/qa', {
      question: 'Qual o prazo de entrega?',
      answer: 'Até 3 dias úteis.',
    });
    expect(qa.json().source).toMatchObject({
      kind: 'QA',
      name: 'Qual o prazo de entrega?',
      question: 'Qual o prazo de entrega?',
    });

    const link = await send('POST', '/ai/knowledge/link', { url: 'https://exemplo.com.br/sobre' });
    expect(link.json().source).toMatchObject({
      kind: 'LINK',
      url: 'https://exemplo.com.br/sobre',
      name: 'https://exemplo.com.br/sobre',
    });

    expect((await jobs()).sort()).toEqual([t, qa, link].map((r) => r.json().source.id).sort());
    const audits = (await prisma.auditLog.findMany()).filter(
      (a) => a.action === 'ai.knowledge_created',
    );
    expect(audits).toHaveLength(3);
  });

  it('valida entradas: texto curto, pergunta sem resposta, link inválido ou não http', async () => {
    expect(
      (await send('POST', '/ai/knowledge/text', { name: 'X', content: 'curto' })).statusCode,
    ).toBe(400);
    expect(
      (await send('POST', '/ai/knowledge/qa', { question: 'Pergunta?', answer: '' })).statusCode,
    ).toBe(400);
    expect((await send('POST', '/ai/knowledge/link', { url: 'não é link' })).statusCode).toBe(400);
    expect(
      (await send('POST', '/ai/knowledge/link', { url: 'ftp://exemplo.com/x' })).statusCode,
    ).toBe(400);
    expect(
      (await send('POST', '/ai/knowledge/link', { url: 'file:///etc/passwd' })).statusCode,
    ).toBe(400);
    expect(await prisma.aiKnowledgeSource.count()).toBe(0);
  });

  it('arquivo: guarda no bucket, registra dados e enfileira; recusa formato, vazio e grande demais', async () => {
    const ok = await upload('catalogo.pdf', Buffer.from('%PDF-1.4 conteudo'), {
      name: 'Catálogo 2026',
    });
    expect(ok.statusCode).toBe(201);
    const src = ok.json().source as AiKnowledgeSourceDTO;
    expect(src).toMatchObject({
      kind: 'FILE',
      name: 'Catálogo 2026',
      fileName: 'catalogo.pdf',
      status: 'PENDING',
    });
    const row = await prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: src.id } });
    expect(row.storageKey).toMatch(/^ai\/knowledge\/.+\.pdf$/);
    expect(await storage.exists(row.storageKey!)).toBe(true);
    expect(await jobs()).toEqual([src.id]);

    expect((await upload('virus.exe', 'x')).json().error.code).toBe('UNSUPPORTED_FORMAT');
    expect((await upload('vazio.txt', '')).json().error.code).toBe('EMPTY_FILE');
    const big = await upload('grande.txt', Buffer.alloc(10 * 1024 * 1024 + 10, 97));
    expect(big.statusCode).toBe(413);
    // nada ficou para trás no bucket nem no banco
    expect(await prisma.aiKnowledgeSource.count()).toBe(1);
    let leftovers = 0;
    for await (const _ of storage.list('ai/knowledge/')) leftovers++;
    expect(leftovers).toBe(1);
  });

  it('lista com filtros e detalhe com trechos', async () => {
    const a = (
      await send('POST', '/ai/knowledge/text', {
        name: 'Frete',
        content: 'Frete grátis acima de R$ 200.',
      })
    ).json().source;
    await send('POST', '/ai/knowledge/qa', {
      question: 'Aceitam pix?',
      answer: 'Sim, com 5% de desconto.',
    });
    await prisma.aiKnowledgeSource.update({
      where: { id: a.id },
      data: { status: 'READY', chunkCount: 1 },
    });
    await prisma.aiKnowledgeChunk.create({
      data: {
        sourceId: a.id,
        position: 0,
        title: 'Frete',
        content: 'Frete grátis acima de R$ 200.',
      },
    });
    expect((await get('/ai/knowledge')).json().items).toHaveLength(2);
    expect((await get('/ai/knowledge?kind=QA')).json().items).toHaveLength(1);
    expect(
      (await get('/ai/knowledge?status=READY')).json().items.map((i: { name: string }) => i.name),
    ).toEqual(['Frete']);
    expect((await get('/ai/knowledge?q=fre')).json().items).toHaveLength(1);
    const d = (await get(`/ai/knowledge/${a.id}`)).json();
    expect(d.source).toMatchObject({ name: 'Frete', content: 'Frete grátis acima de R$ 200.' });
    expect(d.chunks).toHaveLength(1);
    expect((await get('/ai/knowledge/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('editar o nome ou desligar não reprocessa; mudar o conteúdo reprocessa; arquivo não tem conteúdo editável', async () => {
    const t = (
      await send('POST', '/ai/knowledge/text', {
        name: 'Horários',
        content: 'Abrimos das 9h às 18h.',
      })
    ).json().source;
    await prisma.aiKnowledgeSource.update({ where: { id: t.id }, data: { status: 'READY' } });
    await knowledgeQueue.queue.drain(true);

    let r = await send('PATCH', `/ai/knowledge/${t.id}`, {
      name: 'Horário de atendimento',
      enabled: false,
    });
    expect(r.json().source).toMatchObject({
      name: 'Horário de atendimento',
      enabled: false,
      status: 'READY',
    });
    expect(await jobs()).toEqual([]);

    r = await send('PATCH', `/ai/knowledge/${t.id}`, { content: 'Abrimos das 8h às 20h.' });
    expect(r.json().source).toMatchObject({ status: 'PENDING' });
    expect(await jobs()).toEqual([t.id]);

    const f = (await upload('a.txt', 'Conteúdo do arquivo')).json().source;
    r = await send('PATCH', `/ai/knowledge/${f.id}`, { content: 'novo' });
    expect(r.json().error.code).toBe('NOT_EDITABLE');
    r = await send('PATCH', `/ai/knowledge/${t.id}`, { question: 'isso é texto, não QA' });
    expect(r.json().error.code).toBe('NOT_EDITABLE');
  });

  it('reprocessar: só quando não está na fila; marca como pendente e enfileira', async () => {
    const t = (
      await send('POST', '/ai/knowledge/text', { name: 'Tx', content: 'Texto de exemplo longo.' })
    ).json().source;
    expect((await send('POST', `/ai/knowledge/${t.id}/reprocess`)).json().error.code).toBe(
      'ALREADY_QUEUED',
    );
    await prisma.aiKnowledgeSource.update({
      where: { id: t.id },
      data: { status: 'ERROR', error: 'falhou' },
    });
    await knowledgeQueue.queue.drain(true);
    const r = await send('POST', `/ai/knowledge/${t.id}/reprocess`);
    expect(r.statusCode).toBe(202);
    expect(await prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject(
      { status: 'PENDING', error: null },
    );
    expect(await jobs()).toEqual([t.id]);
  });

  it('exclui com confirmação do nome, apagando trechos, vínculos e o arquivo do bucket', async () => {
    const f = (await upload('manual.txt', 'Texto do manual de uso.', { name: 'Manual' })).json()
      .source;
    const key = (await prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: f.id } }))
      .storageKey!;
    await prisma.aiKnowledgeChunk.create({ data: { sourceId: f.id, position: 0, content: 'x' } });
    const persona = (await send('POST', '/ai/personas', { name: 'Pe' })).json().persona;
    const agent = (
      await send('POST', '/ai/agents', { name: 'Ag', personaId: persona.id, model: 'm/x-model' })
    ).json().agent;
    await send('PUT', `/ai/agents/${agent.id}/knowledge`, { sourceIds: [f.id] });

    expect(
      (await send('DELETE', `/ai/knowledge/${f.id}`, { confirmName: 'errado' })).json().error.code,
    ).toBe('NAME_MISMATCH');
    expect(await storage.exists(key)).toBe(true);
    expect(
      (await send('DELETE', `/ai/knowledge/${f.id}`, { confirmName: 'Manual' })).statusCode,
    ).toBe(200);
    expect(await prisma.aiKnowledgeSource.count()).toBe(0);
    expect(await prisma.aiKnowledgeChunk.count()).toBe(0);
    expect(await prisma.aiAgentKnowledge.count()).toBe(0);
    expect(await storage.exists(key)).toBe(false);
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain(
      'ai.knowledge_deleted',
    );
  });

  it('limite de fontes', async () => {
    await prisma.aiKnowledgeSource.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({
        name: `F${i}`,
        kind: 'TEXT' as const,
        content: 'x',
      })),
    });
    const r = await send('POST', '/ai/knowledge/text', {
      name: 'Mais uma',
      content: 'Texto de exemplo longo.',
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('KNOWLEDGE_LIMIT');
  });
});

describe('conhecimento de cada agente', () => {
  const setup = async () => {
    const persona = (await send('POST', '/ai/personas', { name: 'Bia' })).json().persona;
    const agent = (
      await send('POST', '/ai/agents', {
        name: 'Vendas',
        personaId: persona.id,
        model: 'openai/gpt-4o-mini',
      })
    ).json().agent;
    const src = await prisma.aiKnowledgeSource.create({
      data: { name: 'Catálogo', kind: 'TEXT', content: 'x', status: 'READY', chunkCount: 1 },
    });
    await prisma.aiKnowledgeChunk.create({
      data: {
        sourceId: src.id,
        position: 0,
        title: 'Café',
        content: 'O café Bourbon amarelo custa R$ 42 o pacote de 250g.',
      },
    });
    return { agent, src };
  };

  it('liga e desliga fontes; mostra em quais agentes cada fonte está', async () => {
    const { agent, src } = await setup();
    expect((await get(`/ai/agents/${agent.id}/knowledge`)).json().sourceIds).toEqual([]);
    expect(
      (
        await send('PUT', `/ai/agents/${agent.id}/knowledge`, { sourceIds: [src.id, src.id] })
      ).json().sourceIds,
    ).toEqual([src.id]);
    expect((await get(`/ai/agents/${agent.id}/knowledge`)).json().sourceIds).toEqual([src.id]);
    expect((await get('/ai/knowledge')).json().items[0].agents).toEqual([
      { id: agent.id, name: 'Vendas' },
    ]);
    await send('PUT', `/ai/agents/${agent.id}/knowledge`, { sourceIds: [] });
    expect((await get(`/ai/agents/${agent.id}/knowledge`)).json().sourceIds).toEqual([]);
    expect(
      (
        await send('PUT', `/ai/agents/${agent.id}/knowledge`, {
          sourceIds: ['00000000-0000-4000-8000-000000000000'],
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await send('PUT', '/ai/agents/00000000-0000-4000-8000-000000000000/knowledge', {
          sourceIds: [],
        })
      ).statusCode,
    ).toBe(404);
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain(
      'ai.agent_knowledge_updated',
    );
  });

  it('o laboratório usa a base: o prompt leva o trecho e a resposta mostra de onde veio', async () => {
    const { agent, src } = await setup();
    await send('PUT', '/ai/settings', { apiKey: 'sk-or-chave-de-teste-1234' });
    await send('PUT', `/ai/agents/${agent.id}/knowledge`, { sourceIds: [src.id] });
    const session = (
      await send('POST', `/ai/agents/${agent.id}/test-sessions`, { source: 'draft' })
    ).json().session;
    const r = await send('POST', `/ai/test-sessions/${session.id}/messages`, {
      text: 'Quanto custa o café bourbon?',
    });
    const reply = r.json().messages[1];
    expect(reply.role).toBe('assistant');
    expect(reply.debug.knowledge).toEqual([
      expect.objectContaining({ sourceId: src.id, name: 'Catálogo' }),
    ]);
    expect(reply.debug.systemPrompt).toContain('R$ 42 o pacote');
    expect(chatBodies[0]!.messages[0]!.content).toContain('R$ 42 o pacote');

    // pergunta fora da base: sem trechos, e o agente é instruído a não inventar
    const fresh = (
      await send('POST', `/ai/agents/${agent.id}/test-sessions`, { source: 'draft' })
    ).json().session;
    const r2 = await send('POST', `/ai/test-sessions/${fresh.id}/messages`, {
      text: 'Vocês têm filial em Recife?',
    });
    expect(r2.json().messages[1].debug.knowledge).toEqual([]);
    expect(chatBodies[1]!.messages[0]!.content).toMatch(/não traz nada sobre esta mensagem/);
  });
});
