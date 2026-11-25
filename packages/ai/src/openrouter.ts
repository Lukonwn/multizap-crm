/**
 * Cliente mínimo da OpenRouter (API compatível com OpenAI).
 * O `fetch` é injetável: nos testes nenhuma chamada sai para a rede.
 * A chave NUNCA aparece em mensagens de erro nem em logs.
 */

export type OpenRouterErrorCode =
  | 'INVALID_KEY'
  | 'NO_CREDITS'
  | 'RATE_LIMIT'
  | 'MODEL_UNAVAILABLE'
  | 'BAD_REQUEST'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK';

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly code: OpenRouterErrorCode,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

/** Parte de uma mensagem com imagem (o modelo precisa aceitar imagens). */
export type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number | null;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Custo informado pela OpenRouter (dólares), quando disponível. */
  costUsd: number | null;
  latencyMs: number;
  finishReason: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  /** Preço por token, em dólares. */
  promptPrice: number | null;
  completionPrice: number | null;
  supportsTemperature: boolean;
  supportsMaxTokens: boolean;
  /** O modelo aceita imagens na entrada. `null` quando a OpenRouter não informa. */
  supportsImages: boolean | null;
  /** O provedor principal aplica moderação de conteúdo. `null` quando não informado. */
  isModerated: boolean | null;
}

export interface KeyInfo {
  label: string | null;
  usageUsd: number | null;
  limitUsd: number | null;
  isFreeTier: boolean | null;
}

export interface OpenRouterOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Enviado como HTTP-Referer (identifica o aplicativo na OpenRouter). */
  appUrl?: string;
  appName?: string;
  timeoutMs?: number;
}

const inputModalities = (m: Record<string, unknown>): string[] | null => {
  const arch = m.architecture as { input_modalities?: unknown } | undefined;
  return Array.isArray(arch?.input_modalities) ? (arch!.input_modalities as string[]) : null;
};
const moderated = (m: Record<string, unknown>): boolean | null => {
  const top = m.top_provider as { is_moderated?: unknown } | undefined;
  return typeof top?.is_moderated === 'boolean' ? top.is_moderated : null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Mensagem segura (sem a chave) a partir da resposta de erro da OpenRouter. */
function errorFrom(status: number, body: unknown, apiKey: string): OpenRouterError {
  const raw =
    (body as { error?: { message?: string } } | null)?.error?.message ??
    (typeof body === 'string' ? body : '');
  const detail = String(raw).replaceAll(apiKey, '***').slice(0, 300);
  if (status === 401 || status === 403)
    return new OpenRouterError(
      'Chave da OpenRouter inválida ou sem permissão.',
      'INVALID_KEY',
      status,
    );
  if (status === 402)
    return new OpenRouterError('Sem créditos suficientes na OpenRouter.', 'NO_CREDITS', status);
  if (status === 429)
    return new OpenRouterError(
      'Limite de requisições da OpenRouter atingido. Tente em instantes.',
      'RATE_LIMIT',
      status,
    );
  if (status === 404 || /model/i.test(detail))
    return new OpenRouterError(
      `Modelo indisponível na OpenRouter${detail ? `: ${detail}` : '.'}`,
      'MODEL_UNAVAILABLE',
      status,
    );
  if (status === 408 || status === 524)
    return new OpenRouterError('A OpenRouter demorou demais para responder.', 'TIMEOUT', status);
  if (status >= 500)
    return new OpenRouterError(
      `O provedor do modelo falhou (${status})${detail ? `: ${detail}` : '.'}`,
      'PROVIDER_ERROR',
      status,
    );
  return new OpenRouterError(
    `Requisição recusada pela OpenRouter (${status})${detail ? `: ${detail}` : '.'}`,
    'BAD_REQUEST',
    status,
  );
}

export class OpenRouterClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly o: OpenRouterOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.baseUrl = (o.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.timeoutMs = o.timeoutMs ?? 60_000;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.o.apiKey}`,
          'content-type': 'application/json',
          'x-title': this.o.appName ?? 'MultiZap CRM',
          ...(this.o.appUrl && { 'http-referer': this.o.appUrl }),
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError')
        throw new OpenRouterError('A OpenRouter demorou demais para responder.', 'TIMEOUT');
      throw new OpenRouterError('Não foi possível conectar à OpenRouter.', 'NETWORK');
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* corpo não-JSON */
    }
    if (!res.ok) throw errorFrom(res.status, body, this.o.apiKey);
    // A OpenRouter pode devolver 200 com erro do provedor no corpo.
    const embedded = (body as { error?: { code?: number; message?: string } } | null)?.error;
    if (embedded) throw errorFrom(Number(embedded.code) || 502, body, this.o.apiKey);
    return body as T;
  }

  /** Informações da chave (serve como teste de conexão). */
  async keyInfo(): Promise<KeyInfo> {
    const r = await this.request<{ data?: Record<string, unknown> }>('/key');
    const d = r.data ?? {};
    return {
      label: typeof d.label === 'string' ? d.label : null,
      usageUsd: num(d.usage),
      limitUsd: num(d.limit),
      isFreeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
    };
  }

  async models(): Promise<ModelInfo[]> {
    const r = await this.request<{ data?: Record<string, unknown>[] }>('/models');
    return (r.data ?? [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => {
        const pricing = (m.pricing ?? {}) as Record<string, unknown>;
        const params = Array.isArray(m.supported_parameters)
          ? (m.supported_parameters as string[])
          : null;
        return {
          id: m.id as string,
          name: typeof m.name === 'string' ? m.name : (m.id as string),
          contextLength: num(m.context_length),
          promptPrice: num(pricing.prompt),
          completionPrice: num(pricing.completion),
          // Sem a lista de parâmetros, assume suporte (a OpenRouter ignora o que não se aplica).
          supportsTemperature: params ? params.includes('temperature') : true,
          supportsMaxTokens: params ? params.includes('max_tokens') : true,
          supportsImages: inputModalities(m)?.includes('image') ?? null,
          isModerated: moderated(m),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const r = await this.request<{
      model?: string;
      choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number | string };
    }>('/chat/completions', {
      method: 'POST',
      body: {
        model: req.model,
        messages: req.messages,
        ...(req.maxTokens && { max_tokens: req.maxTokens }),
        ...(req.temperature !== null &&
          req.temperature !== undefined && { temperature: req.temperature }),
        usage: { include: true },
      },
    });
    const choice = r.choices?.[0];
    const content = choice?.message?.content?.trim() ?? '';
    if (!content)
      throw new OpenRouterError('O modelo não devolveu resposta.', 'PROVIDER_ERROR', 200);
    return {
      content,
      model: r.model ?? req.model,
      promptTokens: r.usage?.prompt_tokens ?? 0,
      completionTokens: r.usage?.completion_tokens ?? 0,
      costUsd: num(r.usage?.cost),
      latencyMs: Date.now() - started,
      finishReason: choice?.finish_reason ?? null,
    };
  }
}

/** Custo estimado pela tabela de preços do modelo (quando a OpenRouter não informa). */
export function estimateCost(
  promptTokens: number,
  completionTokens: number,
  model: Pick<ModelInfo, 'promptPrice' | 'completionPrice'> | null | undefined,
): number | null {
  if (!model || model.promptPrice === null || model.completionPrice === null) return null;
  return promptTokens * model.promptPrice + completionTokens * model.completionPrice;
}
