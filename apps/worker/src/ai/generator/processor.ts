import type { PrismaClient } from '@multizap/database';
import {
  GeneratorError,
  OpenRouterClient,
  OpenRouterError,
  buildGeneratorMessages,
  estimateCost,
  parseGeneratorResult,
  type ChatMessage,
  type ChatResult,
  type GeneratorInput,
  type ModelInfo,
} from '@multizap/ai';
import { AI_KEY_AAD, type GeneratorPackage } from '@multizap/shared';
import type { CredentialCipher } from '@multizap/shared/crypto';
import { streamToBuffer, type StorageDriver } from '@multizap/storage';
import { ExtractError, extractText } from '../knowledge/extract';
import { fetchPage, type SafeFetchOptions } from '../knowledge/safe-fetch';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

interface StoredFile {
  name: string;
  key: string;
  kind: 'doc' | 'image';
  mime?: string;
  size?: number;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
const extOf = (n: string) => n.split('.').pop()?.toLowerCase() ?? '';

const OPENROUTER_MESSAGE: Record<string, string> = {
  INVALID_KEY: 'A chave da OpenRouter foi recusada. Confira em Configurações.',
  NO_CREDITS: 'Sem créditos na OpenRouter. Adicione créditos e tente de novo.',
  RATE_LIMIT: 'A OpenRouter limitou as chamadas. Aguarde um instante e tente de novo.',
  MODEL_UNAVAILABLE: 'O modelo escolhido não está disponível. Escolha outro.',
  BAD_REQUEST:
    'O modelo recusou o pedido (talvez não aceite imagens, ou o material é grande demais). Tente outro modelo.',
  TIMEOUT: 'O modelo demorou demais para responder. Tente de novo ou use outro modelo.',
};

export interface GeneratorDeps {
  prisma: PrismaClient;
  storage: StorageDriver;
  cipher: CredentialCipher | null;
  fetchImpl?: typeof fetch;
  appUrl?: string;
  log?: Log;
  fetchOpts?: SafeFetchOptions;
}

/**
 * Gerador de Persona: lê o material (descrição, documentos, links e imagens), pede ao modelo
 * escolhido um pacote (persona, instruções, conhecimento, lacunas) e guarda o resultado para o
 * administrador revisar. Nada é criado aqui: quem aplica é o administrador. Os arquivos enviados
 * são apagados do bucket ao terminar, com sucesso ou erro.
 */
export class GeneratorProcessor {
  private readonly log: Log;

  constructor(private readonly d: GeneratorDeps) {
    this.log = d.log ?? (() => undefined);
  }

  async process(id: string): Promise<void> {
    const { prisma } = this.d;
    const claimed = await prisma.aiGeneration.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PROCESSING', error: null },
    });
    if (claimed.count !== 1) return;
    const gen = await prisma.aiGeneration.findUniqueOrThrow({ where: { id } });
    const files = (gen.files as unknown as StoredFile[]) ?? [];
    try {
      const out = await this.run(gen, files);
      await prisma.aiGeneration.update({
        where: { id },
        data: {
          status: 'READY',
          error: null,
          result: out.pkg as object,
          promptTokens: out.promptTokens,
          completionTokens: out.completionTokens,
          costUsd: out.costUsd,
          costConfirmed: out.costConfirmed,
        },
      });
    } catch (err) {
      const message = this.friendly(err);
      this.log('Geração falhou', { id, err: String(err) });
      await prisma.aiGeneration.update({
        where: { id },
        data: { status: 'ERROR', error: message.slice(0, 600) },
      });
    } finally {
      // As imagens e os arquivos servem só para gerar: saem do bucket.
      for (const f of files) await this.d.storage.delete(f.key).catch(() => undefined);
      await prisma.aiGeneration
        .update({
          where: { id },
          data: { files: files.map(({ name, kind }) => ({ name, kind })) as object },
        })
        .catch(() => undefined);
    }
  }

  private friendly(err: unknown): string {
    if (err instanceof OpenRouterError) return OPENROUTER_MESSAGE[err.code] ?? err.message;
    if (err instanceof GeneratorError)
      return err.excerpt && err.code === 'FORMAT'
        ? `${err.message} Resposta do modelo: "${err.excerpt}"`
        : err.message;
    if (err instanceof ExtractError) return err.message;
    return 'Falha inesperada ao gerar. Tente de novo.';
  }

  private async client(): Promise<OpenRouterClient> {
    const cred = await this.d.prisma.aiCredential.findUnique({ where: { provider: 'openrouter' } });
    if (!cred) throw new ExtractError('Configure a chave da OpenRouter em Configurações.');
    if (!this.d.cipher)
      throw new ExtractError(
        'O worker não tem CREDENTIALS_MASTER_KEY para ler a chave da OpenRouter.',
      );
    let apiKey: string;
    try {
      apiKey = this.d.cipher.decrypt(Buffer.from(cred.keyEnc), AI_KEY_AAD).toString('utf8');
    } catch {
      throw new ExtractError(
        'A chave salva não pôde ser lida. Salve a chave da OpenRouter novamente.',
      );
    }
    // Gerar um pacote completo pode demorar: tempo maior que o do atendimento.
    return new OpenRouterClient({
      apiKey,
      fetchImpl: this.d.fetchImpl,
      appUrl: this.d.appUrl,
      timeoutMs: 240_000,
    });
  }

  private async run(
    gen: {
      model: string;
      description: string;
      links: unknown;
      targetAgentId: string | null;
    },
    files: StoredFile[],
  ) {
    const { prisma, storage } = this.d;
    const client = await this.client();
    const input: GeneratorInput = {
      description: gen.description,
      documents: [],
      links: [],
      images: [],
    };
    const skipped: string[] = [];

    for (const f of files) {
      const buf = await streamToBuffer(await storage.get(f.key));
      if (f.kind === 'image') {
        const mime = f.mime ?? MIME[extOf(f.name)] ?? 'image/png';
        input.images.push({
          name: f.name,
          dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        });
      } else {
        input.documents.push({ name: f.name, text: await extractText(buf, f.name) });
      }
    }
    for (const url of (gen.links as string[]) ?? []) {
      try {
        const page = await fetchPage(url, this.d.fetchOpts);
        input.links.push({ url, title: page.title, text: page.text });
      } catch (err) {
        skipped.push(`${url}: ${(err as Error).message}`);
      }
    }
    if (gen.targetAgentId) {
      const agent = await prisma.aiAgent.findUnique({
        where: { id: gen.targetAgentId },
        include: { persona: true },
      });
      if (agent) {
        const { id: _id, createdAt: _c, updatedAt: _u, isTemplate: _t, ...persona } = agent.persona;
        input.existing = { persona, instructions: agent.instructions };
      }
    }

    const messages: ChatMessage[] = buildGeneratorMessages(input);
    let promptTokens = 0;
    let completionTokens = 0;
    let cost: number | null = 0;
    let confirmed = true;
    const account = async (r: ChatResult) => {
      promptTokens += r.promptTokens;
      completionTokens += r.completionTokens;
      let c = r.costUsd;
      if (c === null) {
        confirmed = false;
        const models = await client.models().catch(() => [] as ModelInfo[]);
        c = estimateCost(
          r.promptTokens,
          r.completionTokens,
          models.find((m) => m.id === gen.model),
        );
      }
      cost = c === null || cost === null ? null : cost + c;
      await prisma.aiTokenUsage.create({
        data: {
          context: 'GENERATOR',
          purpose: 'generator',
          model: r.model,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          costUsd: c,
          costConfirmed: r.costUsd !== null,
          latencyMs: r.latencyMs,
        },
      });
    };

    const ask = async (msgs: ChatMessage[]) => {
      const r = await client.chat({
        model: gen.model,
        messages: msgs,
        maxTokens: 7000,
        temperature: 0.7,
      });
      await account(r);
      return r.content;
    };

    let reply = await ask(messages);
    let pkg: GeneratorPackage;
    try {
      pkg = parseGeneratorResult(reply);
    } catch (err) {
      // Uma segunda chance: o modelo costuma corrigir o formato quando vê o motivo.
      if (!(err instanceof GeneratorError) || err.code !== 'FORMAT') throw err;
      reply = await ask([
        ...messages,
        { role: 'assistant', content: reply },
        {
          role: 'user',
          content: `Sua resposta não pôde ser lida: ${err.message} Responda de novo APENAS com o JSON válido, no formato pedido, sem texto fora do JSON.`,
        },
      ]);
      pkg = parseGeneratorResult(reply);
    }
    if (skipped.length)
      pkg = {
        ...pkg,
        notes: [pkg.notes, `Links não lidos: ${skipped.join('; ')}`].filter(Boolean).join('\n'),
      };
    return { pkg, promptTokens, completionTokens, costUsd: cost, costConfirmed: confirmed };
  }
}
