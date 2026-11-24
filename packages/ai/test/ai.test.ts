import { describe, expect, it } from 'vitest';
import {
  FIXED_RULES,
  OpenRouterClient,
  OpenRouterError,
  buildMessages,
  buildSystemPrompt,
  estimateCost,
} from '../src';

const KEY = 'sk-or-v1-segredo-de-teste';

/** fetch falso que registra as chamadas e devolve a resposta configurada. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('cliente OpenRouter', () => {
  it('envia a conversa com cabeçalhos certos e lê resposta, tokens e custo', async () => {
    const f = fakeFetch(200, {
      model: 'openai/gpt-4o-mini',
      choices: [{ message: { content: ' Olá! Como posso ajudar? ' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 9, cost: 0.000045 },
    });
    const c = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: f.impl,
      appUrl: 'https://painel.exemplo',
    });
    const r = await c.chat({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'oi' }],
      temperature: 0.4,
      maxTokens: 300,
    });
    expect(r).toMatchObject({
      content: 'Olá! Como posso ajudar?',
      promptTokens: 120,
      completionTokens: 9,
      costUsd: 0.000045,
      finishReason: 'stop',
    });
    const call = f.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers['http-referer']).toBe('https://painel.exemplo');
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'oi' }],
      max_tokens: 300,
      temperature: 0.4,
      usage: { include: true },
    });
  });

  it('não envia temperatura quando não configurada', async () => {
    const f = fakeFetch(200, { choices: [{ message: { content: 'ok' } }] });
    await new OpenRouterClient({ apiKey: KEY, fetchImpl: f.impl }).chat({
      model: 'm',
      messages: [],
      temperature: null,
    });
    expect(JSON.parse(String(f.calls[0]!.init.body))).not.toHaveProperty('temperature');
  });

  it('traduz os erros e nunca expõe a chave', async () => {
    const cases: [number, unknown, string][] = [
      [401, { error: { message: `bad key ${KEY}` } }, 'INVALID_KEY'],
      [402, { error: { message: 'insufficient credits' } }, 'NO_CREDITS'],
      [429, {}, 'RATE_LIMIT'],
      [404, { error: { message: 'No endpoints found for x/y' } }, 'MODEL_UNAVAILABLE'],
      [502, { error: { message: `upstream ${KEY}` } }, 'PROVIDER_ERROR'],
      [400, { error: { message: 'invalid json' } }, 'BAD_REQUEST'],
    ];
    for (const [status, body, code] of cases) {
      const f = fakeFetch(status, body);
      const err = await new OpenRouterClient({ apiKey: KEY, fetchImpl: f.impl })
        .chat({ model: 'm', messages: [] })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OpenRouterError);
      expect((err as OpenRouterError).code).toBe(code);
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it('erro do provedor dentro de resposta 200 e resposta vazia viram erro', async () => {
    const embedded = fakeFetch(200, { error: { code: 503, message: 'provider down' } });
    await expect(
      new OpenRouterClient({ apiKey: KEY, fetchImpl: embedded.impl }).chat({
        model: 'm',
        messages: [],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const empty = fakeFetch(200, { choices: [{ message: { content: '' } }] });
    await expect(
      new OpenRouterClient({ apiKey: KEY, fetchImpl: empty.impl }).chat({
        model: 'm',
        messages: [],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('falha de rede vira erro de conexão', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      new OpenRouterClient({ apiKey: KEY, fetchImpl: impl }).keyInfo(),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('lê informações da chave e a lista de modelos com preços', async () => {
    const k = fakeFetch(200, {
      data: { label: 'MultiZap', usage: 1.25, limit: null, is_free_tier: false },
    });
    expect(await new OpenRouterClient({ apiKey: KEY, fetchImpl: k.impl }).keyInfo()).toEqual({
      label: 'MultiZap',
      usageUsd: 1.25,
      limitUsd: null,
      isFreeTier: false,
    });
    const m = fakeFetch(200, {
      data: [
        {
          id: 'z/model',
          name: 'Z',
          context_length: 8000,
          pricing: { prompt: '0.000001', completion: '0.000002' },
          supported_parameters: ['max_tokens'],
        },
        { id: 'a/model', name: 'A', pricing: { prompt: '0', completion: '0' } },
      ],
    });
    const list = await new OpenRouterClient({ apiKey: KEY, fetchImpl: m.impl }).models();
    expect(list.map((x) => x.id)).toEqual(['a/model', 'z/model']);
    expect(list[1]).toMatchObject({
      contextLength: 8000,
      promptPrice: 0.000001,
      completionPrice: 0.000002,
      supportsTemperature: false,
      supportsMaxTokens: true,
    });
    expect(list[0]).toMatchObject({ supportsTemperature: true, promptPrice: 0 });
  });

  it('estima o custo pela tabela de preços', () => {
    expect(
      estimateCost(1000, 500, { promptPrice: 0.000001, completionPrice: 0.000002 }),
    ).toBeCloseTo(0.002);
    expect(estimateCost(10, 10, { promptPrice: null, completionPrice: 0.1 })).toBeNull();
    expect(estimateCost(10, 10, null)).toBeNull();
  });
});

describe('montagem do prompt', () => {
  const persona = {
    name: 'Bia',
    age: 28,
    identity: 'Atendente da Loja Sol.',
    personality: 'Simpática e objetiva.',
    formality: 'informal',
    emojiUsage: 'none',
    responseLength: 'short',
    expressions: ['Prontinho!', 'Imagina!'],
    restrictedTopics: 'Política e religião.',
  };

  it('inclui persona, estilo, instruções do agente e as regras fixas', () => {
    const p = buildSystemPrompt(persona, {
      name: 'Vendas',
      instructions: 'Ofereça o catálogo de verão.',
    });
    expect(p).toContain('Você é Bia, 28 anos. Atendente da Loja Sol.');
    expect(p).toContain('Personalidade: Simpática e objetiva.');
    expect(p).toContain('Não use emojis.');
    expect(p).toContain('mensagens curtas');
    expect(p).toContain('Expressões características: Prontinho!; Imagina!');
    expect(p).toContain('NÃO deve tratar');
    expect(p).toContain('Ofereça o catálogo de verão.');
    for (const rule of FIXED_RULES) expect(p).toContain(rule);
    expect(p).toContain('não afirme ser humano');
  });

  it('acrescenta memória e conhecimento quando houver, e omite campos vazios', () => {
    const p = buildSystemPrompt(
      { name: 'Leo', biography: '  ' },
      { name: 'A' },
      {
        contactName: 'Joana',
        memory: 'Prefere entrega à tarde.',
        knowledge: [{ title: 'Horário', text: 'Seg a sex, 9h às 18h.' }],
      },
    );
    expect(p).not.toContain('Biografia');
    expect(p).toContain('Nome do contato: Joana.');
    expect(p).toContain('Prefere entrega à tarde.');
    expect(p).toContain('[1] Horário\nSeg a sex, 9h às 18h.');
    expect(p).toContain('não invente');
  });

  it('mensagens: sistema primeiro e só as últimas da conversa', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `m${i}`,
    }));
    const msgs = buildMessages(persona, { name: 'A' }, history, {}, 10);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs).toHaveLength(11);
    expect(msgs[1]!.content).toBe('m20');
    expect(msgs.at(-1)!.content).toBe('m29');
  });
});
