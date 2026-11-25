import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, type PrismaClient } from '@multizap/database';
import { AI_KEY_AAD } from '@multizap/shared';
import { CredentialCipher } from '@multizap/shared/crypto';
import { LocalStorage } from '@multizap/storage';
import { GeneratorProcessor } from '../src/ai/generator/processor';

const prisma: PrismaClient = createPrisma(process.env.TEST_DATABASE_URL!);
afterAll(() => prisma.$disconnect());
const cipher = new CredentialCipher(new Map([[1, randomBytes(32)]]), 1);

const truncateAll = async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
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

type Reply = { status: number; content?: string };
let replies: Reply[];
let bodies: { model: string; messages: { role: string; content: unknown }[] }[];

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).endsWith('/chat/completions'))
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  bodies.push(JSON.parse(String(init?.body)));
  const r = replies.shift() ?? { status: 200, content: JSON.stringify(PACKAGE) };
  if (r.status !== 200)
    return new Response(JSON.stringify({ error: { message: 'x' } }), { status: r.status });
  return new Response(
    JSON.stringify({
      model: 'openai/gpt-4o',
      choices: [{ message: { content: r.content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.01 },
    }),
    { status: 200 },
  );
}) as unknown as typeof fetch;

let storage: LocalStorage;
const processor = (over: { cipher?: CredentialCipher | null } = {}) =>
  new GeneratorProcessor({
    prisma,
    storage,
    cipher: over.cipher === undefined ? cipher : over.cipher,
    fetchImpl: fakeFetch,
    fetchOpts: { allowHosts: ['127.0.0.1'] },
  });

const withKey = () =>
  prisma.aiCredential.create({
    data: {
      provider: 'openrouter',
      keyEnc: new Uint8Array(cipher.encrypt('sk-or-test-1234567890', AI_KEY_AAD)),
      keyVersion: 1,
      keyLast4: '7890',
    },
  });

const make = async (
  over: {
    description?: string;
    links?: string[];
    files?: { name: string; kind: 'doc' | 'image'; content: Buffer | string }[];
    targetAgentId?: string;
  } = {},
) => {
  const stored = [];
  for (const f of over.files ?? []) {
    const key = `ai/generator/${randomBytes(4).toString('hex')}-${f.name}`;
    await storage.put(key, Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    stored.push({ name: f.name, key, kind: f.kind, size: 1 });
  }
  return prisma.aiGeneration.create({
    data: {
      model: 'openai/gpt-4o',
      description: over.description ?? 'Loja de cafés especiais.',
      links: over.links ?? [],
      files: stored,
      targetAgentId: over.targetAgentId ?? null,
    },
  });
};
const load = (id: string) => prisma.aiGeneration.findUniqueOrThrow({ where: { id } });
const keysLeft = async () => {
  let n = 0;
  for await (const _ of storage.list('ai/generator/')) n++;
  return n;
};

beforeEach(async () => {
  await truncateAll();
  replies = [];
  bodies = [];
  storage = new LocalStorage(mkdtempSync(join(tmpdir(), 'mz-gen-')));
  await withKey();
});

describe('Gerador de Persona: processamento', () => {
  it('só texto: guarda o pacote, o consumo (tipo gerador) e o custo', async () => {
    const g = await make();
    await processor().process(g.id);
    const r = await load(g.id);
    expect(r).toMatchObject({
      status: 'READY',
      error: null,
      promptTokens: 1000,
      completionTokens: 500,
      costConfirmed: true,
    });
    expect((r.result as typeof PACKAGE).persona.name).toBe('Marina');
    expect(Number(r.costUsd)).toBeCloseTo(0.01, 6);
    const u = await prisma.aiTokenUsage.findFirstOrThrow();
    expect(u).toMatchObject({ context: 'GENERATOR', purpose: 'generator', promptTokens: 1000 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.model).toBe('openai/gpt-4o');
    // nada é criado automaticamente: persona, agente e conhecimento só nascem quando o administrador aplica
    expect(await prisma.aiPersona.count()).toBe(0);
    expect(await prisma.aiAgent.count()).toBe(0);
    expect(await prisma.aiKnowledgeSource.count()).toBe(0);
  });

  it('lê documento, link e imagem; manda a imagem ao modelo e apaga os arquivos do bucket ao terminar', async () => {
    const server = http.createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Sobre</title><p>Fundada em 2015 em Belo Horizonte.</p>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sobre`;
    const g = await make({
      links: [url],
      files: [
        {
          name: 'politicas.txt',
          kind: 'doc',
          content: 'Trocas em até 7 dias com o produto lacrado.',
        },
        { name: 'cardapio.png', kind: 'image', content: Buffer.from([137, 80, 78, 71, 1, 2, 3]) },
      ],
    });
    expect(await keysLeft()).toBe(2);
    await processor().process(g.id);
    server.close();
    expect((await load(g.id)).status).toBe('READY');
    const user = bodies[0]!.messages[1]!.content as {
      type: string;
      text?: string;
      image_url?: { url: string };
    }[];
    expect(user[0]!.text).toContain('Trocas em até 7 dias');
    expect(user[0]!.text).toContain('Fundada em 2015');
    expect(user[1]!.type).toBe('image_url');
    expect(user[1]!.image_url!.url).toBe(
      `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString('base64')}`,
    );
    // os arquivos saem do bucket; só os nomes ficam no registro
    expect(await keysLeft()).toBe(0);
    expect((await load(g.id)).files).toEqual([
      { name: 'politicas.txt', kind: 'doc' },
      { name: 'cardapio.png', kind: 'image' },
    ]);
  });

  it('formato inválido na primeira resposta: pede de novo com o motivo e aproveita a segunda', async () => {
    replies = [{ status: 200, content: 'Claro! Vou montar o pacote para você.' }];
    const g = await make();
    await processor().process(g.id);
    expect((await load(g.id)).status).toBe('READY');
    expect(bodies).toHaveLength(2);
    const last = bodies[1]!.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(String(last.content)).toMatch(/não pôde ser lida/);
    // as duas chamadas entram no consumo e no custo
    expect(await prisma.aiTokenUsage.count()).toBe(2);
    expect((await load(g.id)).promptTokens).toBe(2000);
  });

  it('recusa do modelo nas duas tentativas: erro claro, com o início da resposta e arquivos apagados', async () => {
    const refusal = 'Desculpe, não posso ajudar com esse tipo de conteúdo.';
    replies = [
      { status: 200, content: refusal },
      { status: 200, content: refusal },
    ];
    const g = await make({ files: [{ name: 'a.txt', kind: 'doc', content: 'texto' }] });
    await processor().process(g.id);
    const r = await load(g.id);
    expect(r.status).toBe('ERROR');
    expect(r.error).toMatch(/Tente outro modelo/);
    expect(r.error).toContain('Desculpe, não posso ajudar');
    expect(r.result).toBeNull();
    expect(await keysLeft()).toBe(0);
  });

  it('persona que sugere menor de idade é descartada na hora, sem nova tentativa', async () => {
    replies = [
      {
        status: 200,
        content: JSON.stringify({
          ...PACKAGE,
          persona: { ...PACKAGE.persona, identity: 'Uma colegial travessa' },
        }),
      },
    ];
    const g = await make();
    await processor().process(g.id);
    const r = await load(g.id);
    expect(r.status).toBe('ERROR');
    expect(r.error).toMatch(/menor de idade/);
    expect(bodies).toHaveLength(1);
    expect(r.result).toBeNull();
  });

  it('sem chave, chave recusada ou sem créditos: mensagens claras', async () => {
    await prisma.aiCredential.deleteMany();
    let g = await make();
    await processor().process(g.id);
    expect((await load(g.id)).error).toMatch(/Configure a chave/);

    await withKey();
    for (const [status, text] of [
      [401, /chave da OpenRouter foi recusada/],
      [402, /Sem créditos/],
    ] as const) {
      replies = [{ status }];
      g = await make();
      await processor().process(g.id);
      expect((await load(g.id)).error, String(status)).toMatch(text);
    }
    const noCipher = await make();
    await processor({ cipher: null }).process(noCipher.id);
    expect((await load(noCipher.id)).error).toMatch(/CREDENTIALS_MASTER_KEY/);
  });

  it('link que não pode ser lido não derruba a geração: vira observação no pacote', async () => {
    const g = await make({ links: ['http://169.254.169.254/latest/meta-data'] });
    await new GeneratorProcessor({ prisma, storage, cipher, fetchImpl: fakeFetch }).process(g.id);
    const r = await load(g.id);
    expect(r.status).toBe('READY');
    expect((r.result as { notes: string }).notes).toMatch(/Links não lidos.*não pode ser acessado/);
  });

  it('modo melhorar: o pedido leva a persona e as instruções atuais do agente', async () => {
    const persona = await prisma.aiPersona.create({
      data: { name: 'Marina', toneOfVoice: 'doce' },
    });
    const agent = await prisma.aiAgent.create({
      data: {
        name: 'A',
        personaId: persona.id,
        model: 'm/x-model',
        instructions: 'Atenda bem a todos.',
      },
    });
    const g = await make({ targetAgentId: agent.id });
    await processor().process(g.id);
    const text = String(bodies[0]!.messages[1]!.content);
    expect(text).toContain('AGENTE JÁ EXISTENTE');
    expect(text).toContain('"toneOfVoice":"doce"');
    expect(text).toContain('Atenda bem a todos.');
  });

  it('só um processamento por pedido', async () => {
    const g = await make();
    await prisma.aiGeneration.update({ where: { id: g.id }, data: { status: 'PROCESSING' } });
    await processor().process(g.id);
    expect(bodies).toHaveLength(0);
    expect((await load(g.id)).status).toBe('PROCESSING');
  });

  it('documento corrompido vira erro claro (e os arquivos saem do bucket)', async () => {
    const g = await make({ files: [{ name: 'ruim.pdf', kind: 'doc', content: randomBytes(300) }] });
    await processor().process(g.id);
    const r = await load(g.id);
    expect(r.status).toBe('ERROR');
    expect(r.error).toMatch(/Não foi possível ler o arquivo/);
    expect(bodies).toHaveLength(0);
    expect(await keysLeft()).toBe(0);
  });
});
