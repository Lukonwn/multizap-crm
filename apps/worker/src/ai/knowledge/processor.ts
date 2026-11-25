import type { PrismaClient } from '@multizap/database';
import { recordSystemEvent } from '@multizap/database';
import { chunkText, cleanText, KNOWLEDGE_LIMITS, type Chunk } from '@multizap/ai';
import type { StorageDriver } from '@multizap/storage';
import { streamToBuffer } from '@multizap/storage';
import { ExtractError, extractText } from './extract';
import { fetchPage, LinkError, type SafeFetchOptions } from './safe-fetch';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** Transforma uma fonte (texto, pergunta e resposta, arquivo ou link) em trechos pesquisáveis. */
export class KnowledgeProcessor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageDriver,
    private readonly log: Log = () => undefined,
    private readonly fetchOpts: SafeFetchOptions = {},
  ) {}

  async process(sourceId: string): Promise<void> {
    const src = await this.prisma.aiKnowledgeSource.findUnique({ where: { id: sourceId } });
    if (!src) return;
    // Reserva: só um processamento por vez para a mesma fonte.
    const claimed = await this.prisma.aiKnowledgeSource.updateMany({
      where: {
        id: sourceId,
        OR: [
          { status: { in: ['PENDING', 'ERROR', 'READY'] } },
          // "Processando" há muito tempo: o worker anterior provavelmente caiu no meio.
          { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
        ],
      },
      data: { status: 'PROCESSING', error: null },
    });
    if (claimed.count !== 1) return;

    try {
      let chunks: Chunk[];
      let title: string | null = null;
      if (src.kind === 'QA') {
        const q = cleanText(src.question ?? '');
        const a = cleanText(src.content ?? '');
        if (!q || !a) throw new ExtractError('A pergunta e a resposta são obrigatórias.');
        chunks = [{ title: q.slice(0, 200), content: `Pergunta: ${q}\nResposta: ${a}` }];
      } else if (src.kind === 'TEXT') {
        chunks = chunkText(src.content ?? '');
      } else if (src.kind === 'FILE') {
        if (!src.storageKey || !src.fileName) throw new ExtractError('Arquivo não encontrado.');
        const buf = await streamToBuffer(await this.storage.get(src.storageKey));
        chunks = chunkText(await extractText(buf, src.fileName));
      } else {
        if (!src.url) throw new LinkError('Endereço não informado.');
        const page = await fetchPage(src.url, this.fetchOpts);
        title = page.title;
        const text = cleanText(page.text).slice(0, KNOWLEDGE_LIMITS.maxChars);
        if (!text) throw new LinkError('A página não tem texto.');
        chunks = chunkText(text);
      }
      if (!chunks.length) throw new ExtractError('Nenhum texto encontrado.');

      await this.prisma.$transaction(async (tx) => {
        await tx.aiKnowledgeChunk.deleteMany({ where: { sourceId } });
        await tx.aiKnowledgeChunk.createMany({
          data: chunks.map((c, position) => ({
            sourceId,
            position,
            title: c.title,
            content: c.content,
          })),
        });
        await tx.aiKnowledgeSource.update({
          where: { id: sourceId },
          data: {
            status: 'READY',
            error: null,
            chunkCount: chunks.length,
            processedAt: new Date(),
            ...(title && src.name === src.url && { name: title }),
          },
        });
      });
    } catch (err) {
      const friendly =
        err instanceof ExtractError || err instanceof LinkError
          ? err.message
          : 'Falha inesperada ao processar. Tente reprocessar.';
      if (!(err instanceof ExtractError || err instanceof LinkError))
        this.log('Falha ao processar fonte de conhecimento', { sourceId, err: String(err) });
      await this.prisma.aiKnowledgeSource.update({
        where: { id: sourceId },
        data: { status: 'ERROR', error: friendly.slice(0, 300), chunkCount: 0 },
      });
      await this.prisma.aiKnowledgeChunk.deleteMany({ where: { sourceId } });
      await recordSystemEvent(this.prisma, {
        source: 'worker',
        level: 'warn',
        type: 'ai_knowledge_failed',
        message: `Fonte de conhecimento "${src.name}": ${friendly}`,
        details: { sourceId },
      }).catch(() => undefined);
    }
  }
}
