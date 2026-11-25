import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import type { LocalStorage } from '@multizap/storage';
import type { AiConversationDTO, AiModelDTO } from '@multizap/shared';
import type { GeneratorQueue, KnowledgeQueue } from '../src/lib/queues';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

const MODELS = {
  data: [
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      architecture: { input_modalities: ['text', 'image'] },
      top_provider: { is_moderated: true },
      pricing: { prompt: '0.0000025', completion: '0.00001' },
    },
    {
      id: 'meta/llama-text',
      name: 'Llama texto',
      architecture: { input_modalities: ['text'] },
      top_provider: { is_moderated: false },
      pricing: { prompt: '0', completion: '0' },
    },
  ],
};
const fakeFetch = (async (url: string) => {
  const path = new URL(url).pathname;
  const body = path.endsWith('/models') ? MODELS : { data: { label: 'x', usage: 0 } };
  return new Response(JSON.stringify(body), { status: 200 });
}) as unknown as typeof fetch;

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let storage: LocalStorage;
let generatorQueue: GeneratorQueue;
let knowledgeQueue: KnowledgeQueue;
let s: Session;

beforeAll(async () => {
  ({ app, prisma, redis, storage, generatorQueue, knowledgeQueue } = (await setupTestApp(
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
  await redis.del('multizap:ai:models');
  // o bucket de teste é compartilhado entre os casos: começa sempre vazio
  for await (const o of storage.list('ai/generator/')) await storage.delete(o.key);
  await generatorQueue.queue.drain(true);
  await knowledgeQueue.queue.drain(true);
  await createAdmin(prisma);
  s = await login(app);
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s), ...(payload && { payload }) });
const saveKey = () => send('PUT', '/ai/settings', { apiKey: 'sk-or-chave-de-teste-1234' });

/** multipart com vários arquivos e campos. */
function form(
  fields: Record<string, string>,
  files: { name: string; content: Buffer | string }[] = [],
) {
  const boundary = `----mzg${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
const create = (
  fields: Record<string, string>,
  files: { name: string; content: Buffer | string }[] = [],
) => {
  const mp = form(fields, files);
  return app.inject({
    method: 'POST',
    url: '/ai/generator',
    headers: { ...authed(s), 'content-type': mp.contentType },
    payload: mp.body,
  });
};
const base = {
  description: 'Loja de cafés especiais com entrega para todo o Brasil.',
  model: 'openai/gpt-4o',
};
const keysLeft = async () => {
  let n = 0;
  for await (const _ of storage.list('ai/generator/')) n++;
  return n;
};

const PACKAGE = {
  persona: {
    name: 'Marina',
    age: 28,
    identity: 'Atendente da Casa do Café',
    toneOfVoice: 'Acolhedor e direto',
    formality: 'informal',
    emojiUsage: 'low',
    responseLength: 'short',
    expressions: ['Boa pedida!'],
    openingMessages: ['Oi! Como posso ajudar?'],
  },
  agentInstructions: 'Atenda com simpatia e use a base de conhecimento.',
  knowledge: {
    texts: [{ name: 'Cardápio', content: 'Café Bourbon R$ 42; Catuaí R$ 38 (250g).' }],
    qa: [{ question: 'Aceitam pix?', answer: 'Sim, com 5% de desconto.' }],
  },
  gaps: ['Qual o horário de atendimento?'],
  notes: null,
};
const readyGeneration = (over: object = {}) =>
  prisma.aiGeneration.create({
    data: {
      model: 'openai/gpt-4o',
      description: 'x'.repeat(20),
      status: 'READY',
      result: PACKAGE,
      ...over,
    },
  });

describe('Gerador de Persona: pedido', () => {
  it('exige login', async () => {
    expect((await app.inject({ method: 'GET', url: '/ai/generator' })).statusCode).toBe(401);
  });

  it('cria o pedido com documento, imagem e links: guarda no bucket, enfileira e audita', async () => {
    await saveKey();
    const r = await create({ ...base, links: JSON.stringify(['https://loja.com.br/sobre']) }, [
      { name: 'politicas.txt', content: 'Trocas em até 7 dias.' },
      { name: 'cardapio.png', content: Buffer.from([137, 80, 78, 71, 9, 9]) },
    ]);
    expect(r.statusCode).toBe(202);
    const g = r.json().generation;
    expect(g).toMatchObject({
      status: 'PENDING',
      model: 'openai/gpt-4o',
      links: ['https://loja.com.br/sobre'],
      files: [
        { name: 'politicas.txt', kind: 'doc' },
        { name: 'cardapio.png', kind: 'image' },
      ],
    });
    expect(JSON.stringify(g)).not.toContain('ai/generator/'); // chaves do bucket nunca vão ao painel
    expect(await keysLeft()).toBe(2);
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: g.id } });
    expect((row.files as { key: string; mime: string }[]).map((f) => f.mime)).toEqual([
      'application/octet-stream',
      'image/png',
    ]);
    const jobs = await generatorQueue.queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.map((j) => j.data)).toEqual([{ generationId: g.id }]);
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain(
      'ai.generator_requested',
    );
  });

  it('só texto também funciona; links podem vir um por linha', async () => {
    await saveKey();
    const r = await create({ ...base, links: 'https://a.com\nhttps://b.com' });
    expect(r.statusCode).toBe(202);
    expect(r.json().generation.links).toEqual(['https://a.com', 'https://b.com']);
  });

  it('sem chave da OpenRouter: recusa e não deixa arquivos nem registro', async () => {
    const r = await create(base, [{ name: 'a.txt', content: 'texto' }]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('AI_NOT_CONFIGURED');
    expect(await keysLeft()).toBe(0);
    expect(await prisma.aiGeneration.count()).toBe(0);
  });

  it('valida: descrição curta, modelo, formato, links, quantidades e tamanhos (sem restos no bucket)', async () => {
    await saveKey();
    const bad = async (
      fields: Record<string, string>,
      files: { name: string; content: Buffer | string }[],
      code: number,
      text?: RegExp,
    ) => {
      const r = await create(fields, files);
      expect(r.statusCode, JSON.stringify(r.json())).toBe(code);
      if (text) expect(JSON.stringify(r.json())).toMatch(text);
      expect(await keysLeft()).toBe(0);
      expect(await prisma.aiGeneration.count()).toBe(0);
    };
    await bad({ ...base, description: 'curta' }, [{ name: 'a.txt', content: 'x' }], 400);
    await bad({ description: base.description }, [], 400);
    await bad(base, [{ name: 'virus.exe', content: 'x' }], 400, /Formato não suportado/);
    await bad(
      { ...base, links: JSON.stringify(['ftp://x.com']) },
      [{ name: 'a.txt', content: 'x' }],
      400,
    );
    await bad({ ...base, links: JSON.stringify(['não é link']) }, [], 400);
    await bad(
      {
        ...base,
        links: JSON.stringify(['https://1.com', 'https://2.com', 'https://3.com', 'https://4.com']),
      },
      [],
      400,
    );
    await bad(base, [{ name: 'vazio.txt', content: '' }], 400, /vazio/);
    await bad(
      base,
      Array.from({ length: 5 }, (_, i) => ({ name: `d${i}.txt`, content: 'texto' })),
      400,
      /Máximo de 4 documentos/,
    );
    await bad(
      base,
      Array.from({ length: 7 }, (_, i) => ({ name: `i${i}.png`, content: Buffer.from([1, 2, 3]) })),
      400,
      /Máximo de 6 imagens/,
    );
    await bad(
      base,
      [{ name: 'grande.png', content: Buffer.alloc(4 * 1024 * 1024 + 10, 1) }],
      413,
      /Imagem grande demais/,
    );
    await bad({ ...base, targetAgentId: '00000000-0000-4000-8000-000000000000' }, [], 404);
  });

  it('modelo que não aceita imagem é recusado quando a lista de modelos já foi carregada', async () => {
    await saveKey();
    await get('/ai/models'); // o painel carrega a lista ao escolher o modelo
    const r = await create({ ...base, model: 'meta/llama-text' }, [
      { name: 'x.png', content: Buffer.from([1, 2, 3]) },
    ]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('MODEL_NO_IMAGES');
    expect(await keysLeft()).toBe(0);
    // sem imagem, o mesmo modelo é aceito; com modelo que aceita imagem, também
    expect((await create({ ...base, model: 'meta/llama-text' })).statusCode).toBe(202);
    expect(
      (await create(base, [{ name: 'x.png', content: Buffer.from([1, 2, 3]) }])).statusCode,
    ).toBe(202);
  });

  it('no máximo duas gerações ao mesmo tempo (custam dinheiro)', async () => {
    await saveKey();
    expect((await create(base)).statusCode).toBe(202);
    expect((await create(base)).statusCode).toBe(202);
    const r = await create(base);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('GENERATOR_BUSY');
  });

  it('lista (sem o pacote), detalhe (com o pacote) e exclusão', async () => {
    await saveKey();
    const g = await readyGeneration();
    expect((await get('/ai/generator')).json().items[0].result).toBeNull();
    const d = (await get(`/ai/generator/${g.id}`)).json().generation;
    expect(d.result.persona.name).toBe('Marina');
    expect((await send('DELETE', `/ai/generator/${g.id}`)).statusCode).toBe(200);
    expect(await prisma.aiGeneration.count()).toBe(0);
    const busy = await prisma.aiGeneration.create({
      data: { model: 'm/x-model', description: 'x'.repeat(20), status: 'PROCESSING' },
    });
    expect((await send('DELETE', `/ai/generator/${busy.id}`)).json().error.code).toBe(
      'IN_PROGRESS',
    );
  });

  it('modelos mostram "aceita imagem" e "moderado" quando a OpenRouter informa', async () => {
    await saveKey();
    const items = (await get('/ai/models')).json().items as AiModelDTO[];
    expect(items.find((m) => m.id === 'openai/gpt-4o')).toMatchObject({
      supportsImages: true,
      isModerated: true,
    });
    expect(items.find((m) => m.id === 'meta/llama-text')).toMatchObject({
      supportsImages: false,
      isModerated: false,
    });
  });
});

describe('Gerador de Persona: aplicar o pacote', () => {
  it('novo: cria persona, agente (rascunho, revisão humana, inativo) e conhecimento ligado, e enfileira as fontes', async () => {
    const g = await readyGeneration();
    const r = await send('POST', `/ai/generator/${g.id}/apply`, {
      package: PACKAGE,
      mode: 'new',
      agentName: 'Atendente da Marina',
      agentModel: 'openai/gpt-4o-mini',
    });
    expect(r.statusCode).toBe(200);
    const out = r.json();
    expect(out).toMatchObject({ knowledgeCount: 2, agentActive: false });
    const agent = await prisma.aiAgent.findUniqueOrThrow({
      where: { id: out.agentId },
      include: { persona: true },
    });
    expect(agent).toMatchObject({
      name: 'Atendente da Marina',
      model: 'openai/gpt-4o-mini',
      status: 'DRAFT',
      mode: 'REVIEW',
      instructions: 'Atenda com simpatia e use a base de conhecimento.',
      publishedVersionId: null,
    });
    expect(agent.persona).toMatchObject({
      name: 'Marina',
      age: 28,
      isTemplate: false,
      toneOfVoice: 'Acolhedor e direto',
    });
    expect(agent.persona.expressions).toEqual(['Boa pedida!']);
    expect((await prisma.aiPersonaRevision.findFirstOrThrow()).summary).toMatch(
      /Gerador de Persona/,
    );
    const sources = await prisma.aiKnowledgeSource.findMany({ orderBy: { kind: 'asc' } });
    expect(sources.map((x) => [x.kind, x.status, x.name])).toEqual([
      ['TEXT', 'PENDING', 'Cardápio'],
      ['QA', 'PENDING', 'Aceitam pix?'],
    ]);
    expect(await prisma.aiAgentKnowledge.count({ where: { agentId: out.agentId } })).toBe(2);
    const jobs = await knowledgeQueue.queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.map((j) => j.data.sourceId).sort()).toEqual(sources.map((x) => x.id).sort());
    expect(
      (await prisma.aiGeneration.findUniqueOrThrow({ where: { id: g.id } })).appliedAt,
    ).not.toBeNull();
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain(
      'ai.generator_applied',
    );
    // não aplica duas vezes
    const again = await send('POST', `/ai/generator/${g.id}/apply`, {
      package: PACKAGE,
      mode: 'new',
      agentName: 'Outro',
      agentModel: 'm/x-model',
    });
    expect(again.json().error.code).toBe('ALREADY_APPLIED');
    expect(await prisma.aiAgent.count()).toBe(1);
  });

  it('aplica o que o administrador editou na revisão (não o que o modelo devolveu)', async () => {
    const g = await readyGeneration();
    const edited = {
      ...PACKAGE,
      persona: { ...PACKAGE.persona, name: 'Mari' },
      knowledge: { texts: [], qa: [PACKAGE.knowledge.qa[0]!] },
    };
    const r = await send('POST', `/ai/generator/${g.id}/apply`, {
      package: edited,
      mode: 'new',
      agentName: 'Mari',
      agentModel: 'm/x-model',
    });
    expect(r.json().knowledgeCount).toBe(1);
    expect((await prisma.aiPersona.findFirstOrThrow()).name).toBe('Mari');
  });

  it('melhorar: atualiza só o que veio preenchido, as instruções e soma conhecimento; nada é publicado', async () => {
    const persona = await prisma.aiPersona.create({
      data: {
        name: 'Marina',
        age: 30,
        toneOfVoice: 'doce',
        rules: 'Nunca prometa descontos.',
        expressions: ['Oi!'],
      },
    });
    const agent = await prisma.aiAgent.create({
      data: {
        name: 'Atendente',
        personaId: persona.id,
        model: 'm/x-model',
        instructions: 'Antigas.',
        status: 'ACTIVE',
      },
    });
    const g = await readyGeneration({ targetAgentId: agent.id });
    const pkg = {
      ...PACKAGE,
      persona: { ...PACKAGE.persona, rules: '', allowedTopics: 'Cafés e acessórios' },
    };
    const r = await send('POST', `/ai/generator/${g.id}/apply`, {
      package: pkg,
      mode: 'improve',
      agentId: agent.id,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ agentActive: true, knowledgeCount: 2 });
    const p = await prisma.aiPersona.findUniqueOrThrow({ where: { id: persona.id } });
    expect(p).toMatchObject({
      toneOfVoice: 'Acolhedor e direto', // melhorado
      allowedTopics: 'Cafés e acessórios', // novo
      rules: 'Nunca prometa descontos.', // veio vazio: preservado
    });
    expect(p.expressions).toEqual(['Boa pedida!']);
    const a = await prisma.aiAgent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(a).toMatchObject({
      instructions: pkg.agentInstructions,
      status: 'ACTIVE',
      publishedVersionId: null,
    });
    expect((await prisma.aiPersonaRevision.findFirstOrThrow()).summary).toMatch(
      /Alterado pelo Gerador de Persona: .*tom de voz/,
    );
    expect(await prisma.aiAgentKnowledge.count({ where: { agentId: agent.id } })).toBe(2);
    expect(await prisma.aiAgentVersion.count()).toBe(0);
  });

  it('melhorar com seções desmarcadas não mexe nelas', async () => {
    const persona = await prisma.aiPersona.create({
      data: { name: 'Marina', toneOfVoice: 'doce' },
    });
    const agent = await prisma.aiAgent.create({
      data: {
        name: 'Atendente',
        personaId: persona.id,
        model: 'm/x-model',
        instructions: 'Antigas.',
      },
    });
    const g = await readyGeneration();
    await send('POST', `/ai/generator/${g.id}/apply`, {
      package: PACKAGE,
      mode: 'improve',
      agentId: agent.id,
      sections: { persona: false, instructions: false, knowledge: true },
    });
    expect(
      (await prisma.aiPersona.findUniqueOrThrow({ where: { id: persona.id } })).toneOfVoice,
    ).toBe('doce');
    expect((await prisma.aiAgent.findUniqueOrThrow({ where: { id: agent.id } })).instructions).toBe(
      'Antigas.',
    );
    expect(await prisma.aiAgentKnowledge.count()).toBe(2);
    expect(await prisma.aiPersonaRevision.count()).toBe(0);
  });

  it('recusas: pacote ainda não pronto, termo que sugere menor, persona menor de 18, limite de fontes, campos faltando', async () => {
    const pending = await prisma.aiGeneration.create({
      data: { model: 'm/x-model', description: 'x'.repeat(20) },
    });
    const apply = (id: string, body: object) => send('POST', `/ai/generator/${id}/apply`, body);
    const ok = { package: PACKAGE, mode: 'new', agentName: 'Ag', agentModel: 'm/x-model' };
    expect((await apply(pending.id, ok)).json().error.code).toBe('NOT_READY');

    const g = await readyGeneration();
    const minor = {
      ...ok,
      package: { ...PACKAGE, agentInstructions: 'Fale como uma colegial travessa.' },
    };
    expect((await apply(g.id, minor)).json().error.code).toBe('MINOR_TERM');
    const young = { ...ok, package: { ...PACKAGE, persona: { ...PACKAGE.persona, age: 17 } } };
    expect((await apply(g.id, young)).statusCode).toBe(400);
    expect((await apply(g.id, { ...ok, agentName: undefined })).statusCode).toBe(400);
    expect((await apply(g.id, { package: PACKAGE, mode: 'improve' })).statusCode).toBe(400);
    expect((await apply('00000000-0000-4000-8000-000000000000', ok)).statusCode).toBe(404);

    await prisma.aiKnowledgeSource.createMany({
      data: Array.from({ length: 199 }, (_, i) => ({
        name: `F${i}`,
        kind: 'TEXT' as const,
        content: 'x',
      })),
    });
    expect((await apply(g.id, ok)).json().error.code).toBe('KNOWLEDGE_LIMIT');
    // nada foi criado nas recusas
    expect(await prisma.aiAgent.count()).toBe(0);
    expect(await prisma.aiPersona.count()).toBe(0);
    expect(
      (await prisma.aiGeneration.findUniqueOrThrow({ where: { id: g.id } })).appliedAt,
    ).toBeNull();
  });
});

describe('proteção de menor de idade na API', () => {
  it('persona: idade abaixo de 18 e termos que sugerem menor não são salvos (criar e editar)', async () => {
    expect((await send('POST', '/ai/personas', { name: 'Lia', age: 17 })).statusCode).toBe(400);
    expect((await send('POST', '/ai/personas', { name: 'Lia', age: 18 })).statusCode).toBe(201);
    const bad = await send('POST', '/ai/personas', {
      name: 'Lia',
      identity: 'Uma colegial travessa',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('MINOR_TERM');
    const p = (await send('POST', '/ai/personas', { name: 'Ana', age: 30 })).json().persona;
    expect((await send('PATCH', `/ai/personas/${p.id}`, { age: 16 })).statusCode).toBe(400);
    expect(
      (await send('PATCH', `/ai/personas/${p.id}`, { traits: 'novinha e safada' })).json().error
        .code,
    ).toBe('MINOR_TERM');
    expect((await send('PATCH', `/ai/personas/${p.id}`, { traits: 'simpática' })).statusCode).toBe(
      200,
    );
    // loja infantil não é bloqueada
    expect(
      (await send('POST', '/ai/personas', { name: 'Bia', identity: 'Atendente de moda infantil' }))
        .statusCode,
    ).toBe(201);
  });

  it('agente: instruções com termo que sugere menor não são salvas', async () => {
    const persona = (await send('POST', '/ai/personas', { name: 'Ana' })).json().persona;
    const r = await send('POST', '/ai/agents', {
      name: 'Ag',
      personaId: persona.id,
      model: 'm/x-model',
      instructions: 'responda como ninfetinha',
    });
    expect(r.json().error.code).toBe('MINOR_TERM');
    const a = (
      await send('POST', '/ai/agents', { name: 'Ag', personaId: persona.id, model: 'm/x-model' })
    ).json().agent;
    expect(
      (await send('PATCH', `/ai/agents/${a.id}`, { instructions: 'finja ser colegial' })).json()
        .error.code,
    ).toBe('MINOR_TERM');
  });

  it('portão de idade: desligado por padrão, liga e desliga na hora (sem nova publicação)', async () => {
    const persona = (await send('POST', '/ai/personas', { name: 'Ana' })).json().persona;
    const a = (
      await send('POST', '/ai/agents', { name: 'Ag', personaId: persona.id, model: 'm/x-model' })
    ).json().agent;
    expect(a.ageGate).toBe(false);
    await send('POST', `/ai/agents/${a.id}/publish`, {});
    const on = (await send('PATCH', `/ai/agents/${a.id}`, { ageGate: true })).json().agent;
    expect(on).toMatchObject({ ageGate: true, hasUnpublishedChanges: false });
    expect(
      (await send('PATCH', `/ai/agents/${a.id}`, { ageGate: false })).json().agent.ageGate,
    ).toBe(false);
  });

  describe('conversa travada por sinal de menor', () => {
    const lockedWorld = async () => {
      const account = await prisma.account.create({
        data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
      });
      const conv = await prisma.conversation.create({
        data: {
          accountId: account.id,
          remoteJid: '5511977776666@s.whatsapp.net',
          phoneE164: '+5511977776666',
          lastMessageAt: new Date(),
        },
      });
      const persona = (await send('POST', '/ai/personas', { name: 'Ana' })).json().persona;
      const agent = (
        await send('POST', '/ai/agents', { name: 'Ag', personaId: persona.id, model: 'm/x-model' })
      ).json().agent;
      await send('PUT', `/ai/agents/${agent.id}/accounts`, { accountIds: [account.id] });
      await prisma.aiConversationState.create({
        data: {
          conversationId: conv.id,
          paused: true,
          pausedBy: 'minor',
          pausedReason: 'Possível menor de idade (idade): "tenho 15 anos"',
          pausedAt: new Date(),
        },
      });
      return { account, conv, agent };
    };

    it('aparece como travada e só é liberada com confirmação explícita (retomar ou reiniciar)', async () => {
      const w = await lockedWorld();
      await prisma.aiAgent.update({ where: { id: w.agent.id }, data: { status: 'ACTIVE' } });
      const items = (await get('/ai/conversations')).json().items as AiConversationDTO[];
      expect(items[0]).toMatchObject({ state: 'paused', minorLock: true, pausedBy: 'minor' });

      for (const body of [{ paused: false }, { resetContext: true }]) {
        const r = await send('PUT', `/ai/conversations/${w.conv.id}/state`, body);
        expect(r.statusCode, JSON.stringify(body)).toBe(409);
        expect(r.json().error.code).toBe('MINOR_LOCK');
      }
      expect((await prisma.aiConversationState.findFirstOrThrow()).paused).toBe(true);

      const ok = await send('PUT', `/ai/conversations/${w.conv.id}/state`, {
        paused: false,
        confirmMinor: true,
      });
      expect(ok.statusCode).toBe(200);
      expect((await prisma.aiConversationState.findFirstOrThrow()).paused).toBe(false);
      expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain(
        'ai.conversation_minor_released',
      );
    });

    it('pausar manualmente e outras ações continuam livres; só a liberação exige confirmação', async () => {
      const w = await lockedWorld();
      expect(
        (await send('PUT', `/ai/conversations/${w.conv.id}/state`, { enabled: true })).statusCode,
      ).toBe(200);
      expect(
        (await send('PUT', `/ai/conversations/${w.conv.id}/state`, { paused: true })).statusCode,
      ).toBe(200);
    });

    it('responder pela Central não troca a trava de menor por "pessoa respondeu"', async () => {
      const w = await lockedWorld();
      await prisma.aiAgent.update({ where: { id: w.agent.id }, data: { status: 'ACTIVE' } });
      await redis.set('multizap:heartbeat:gateway', '1', 'EX', 60).catch(() => undefined);
      await send('POST', `/conversations/${w.conv.id}/messages`, { text: 'Oi' });
      expect((await prisma.aiConversationState.findFirstOrThrow()).pausedBy).toBe('minor');
    });
  });
});
