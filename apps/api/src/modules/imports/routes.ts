import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Import } from '@multizap/database';
import {
  FORMAT_CONTENT_TYPE,
  detectFormat,
  sniff,
  type Delimiter,
  type Encoding,
} from '@multizap/files';
import {
  guessHasHeader,
  importMappingSchema,
  suggestMapping,
  type ImportDTO,
  type ImportMapping,
  type ImportRowDTO,
} from '@multizap/shared';
import { requireAccount } from '../../lib/accounts';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';

interface StoredOptions {
  encoding: Encoding;
  delimiter: Delimiter | null;
  sample: string[][];
  hasHeaderGuess: boolean;
}

const importParams = z.object({
  accountId: z.string().uuid(),
  id: z.string().uuid('Importação inválida.'),
});

/** Importações que bloqueiam o reenvio do mesmo arquivo (prevenção de duplicidade). */
const BLOCKING_STATUSES = [
  'ANALYZING',
  'ANALYZED',
  'CONFIRMED',
  'PROCESSING',
  'COMPLETED',
] as const;

export function toImportDTO(i: Import & { account?: { name: string } }): ImportDTO {
  const opts = (i.options ?? {}) as Partial<StoredOptions>;
  const mapping = importMappingSchema.safeParse(i.mapping);
  const sample = opts.sample ?? [];
  const hasHeader = mapping.success ? mapping.data.hasHeader : (opts.hasHeaderGuess ?? false);
  return {
    id: i.id,
    accountId: i.accountId,
    accountName: i.account?.name,
    fileName: i.fileName,
    fileSize: Number(i.fileSize),
    format: i.format,
    status: i.status,
    columns: (i.columns as string[]) ?? [],
    sample,
    hasHeader,
    suggested: sample.length ? suggestMapping(sample, hasHeader) : null,
    mapping: mapping.success ? mapping.data : null,
    totalRows: i.totalRows,
    validRows: i.validRows,
    duplicateRows: i.duplicateRows,
    existingRows: i.existingRows,
    invalidRows: i.invalidRows,
    optedOutRows: i.optedOutRows,
    importedRows: i.importedRows,
    updatedRows: i.updatedRows,
    skippedRows: i.skippedRows,
    processedRows: i.processedRows,
    hasRejectedFile: !!i.rejectedFileKey,
    error: i.error,
    createdAt: i.createdAt.toISOString(),
    confirmedAt: i.confirmedAt?.toISOString() ?? null,
    finishedAt: i.finishedAt?.toISOString() ?? null,
  };
}

export async function importRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  const services = () => {
    if (!app.storage || !app.importQueue) {
      throw new AppError(
        503,
        'STORAGE_UNAVAILABLE',
        'Armazenamento de arquivos ou fila de processamento não configurados.',
      );
    }
    return { storage: app.storage, queue: app.importQueue };
  };

  const loadImport = async (req: FastifyRequest) => {
    const account = await requireAccount(app, req);
    const { id } = parse(importParams, req.params);
    const imp = await prisma.import.findFirst({ where: { id, accountId: account.id } });
    if (!imp) throw Errors.notFound('Importação não encontrada.');
    return { account, imp };
  };

  // 1–3. Envio do arquivo para a instância de destino + detecção de colunas.
  app.post('/accounts/:accountId/imports', auth, async (req, reply) => {
    const account = await requireAccount(app, req);
    const { storage } = services();
    const file = await req.file().catch(() => undefined);
    if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Selecione um arquivo.');
    const format = detectFormat(file.filename);
    if (!format) {
      file.file.resume();
      throw new AppError(
        400,
        'UNSUPPORTED_FORMAT',
        'Formato não suportado. Envie um arquivo CSV, TXT ou XLSX.',
      );
    }

    const id = randomUUID();
    const key = `imports/${account.id}/${id}/original.${format}`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    await storage.put(key, file.file.pipe(meter), { contentType: FORMAT_CONTENT_TYPE[format] });
    if (file.file.truncated) {
      await storage.delete(key);
      throw new AppError(
        413,
        'FILE_TOO_LARGE',
        `Arquivo maior que o limite de ${Math.round(app.config.maxImportBytes / 1024 / 1024)} MB.`,
      );
    }
    if (size === 0) {
      await storage.delete(key);
      throw new AppError(400, 'EMPTY_FILE', 'O arquivo está vazio.');
    }
    const fileHash = hash.digest('hex');

    const previous = await prisma.import.findFirst({
      where: { accountId: account.id, fileHash, status: { in: [...BLOCKING_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    });
    if (previous) {
      await storage.delete(key);
      throw new AppError(
        409,
        'DUPLICATE_IMPORT',
        `Este arquivo já foi enviado para esta instância em ${previous.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`,
        { importId: [previous.id] },
      );
    }

    let sniffed;
    try {
      sniffed = await sniff(() => storage.get(key), format);
    } catch {
      await storage.delete(key);
      throw new AppError(
        400,
        'UNREADABLE_FILE',
        'Não foi possível ler o arquivo. Verifique se ele não está corrompido.',
      );
    }
    if (!sniffed.sample.length) {
      await storage.delete(key);
      throw new AppError(
        400,
        'EMPTY_FILE',
        'Nenhuma linha com conteúdo foi encontrada no arquivo.',
      );
    }
    const hasHeaderGuess = guessHasHeader(sniffed.sample);
    const imp = await prisma.import.create({
      data: {
        id,
        accountId: account.id,
        fileName: file.filename.slice(0, 200),
        fileKey: key,
        fileHash,
        fileSize: BigInt(size),
        format,
        status: 'UPLOADED',
        columns: sniffed.sample[0] ?? [],
        options: {
          encoding: sniffed.encoding,
          delimiter: sniffed.delimiter,
          sample: sniffed.sample.slice(0, 20),
          hasHeaderGuess,
        },
      },
    });
    await audit(prisma, req, {
      action: 'import.uploaded',
      actorId: req.auth!.user.id,
      entityType: 'import',
      entityId: imp.id,
      accountId: account.id,
      details: { fileName: imp.fileName, size },
    });
    reply.code(201);
    return { import: toImportDTO(imp) };
  });

  app.get('/accounts/:accountId/imports', auth, async (req) => {
    const account = await requireAccount(app, req);
    const items = await prisma.import.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: items.map(toImportDTO) };
  });

  app.get('/accounts/:accountId/imports/:id', auth, async (req) => {
    const { imp } = await loadImport(req);
    return { import: toImportDTO(imp) };
  });

  // 4–8. Mapeamento → análise assíncrona (duplicados, formatos inválidos, resumo).
  app.post('/accounts/:accountId/imports/:id/analyze', auth, async (req, reply) => {
    const { account, imp } = await loadImport(req);
    const { queue } = services();
    const mapping: ImportMapping = parse(
      importMappingSchema,
      (req.body as { mapping?: unknown })?.mapping,
    );
    const width = Math.max(
      0,
      ...(((imp.options as Partial<StoredOptions>).sample ?? []) as string[][]).map(
        (r) => r.length,
      ),
    );
    for (const [field, col] of Object.entries(mapping.columns)) {
      if (col !== null && col !== undefined && col >= width) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Dados inválidos.', {
          [`columns.${field}`]: ['Coluna inexistente no arquivo.'],
        });
      }
    }
    if (mapping.applyTagIds.length) {
      const n = await prisma.tag.count({
        where: { accountId: account.id, id: { in: mapping.applyTagIds } },
      });
      if (n !== new Set(mapping.applyTagIds).size)
        throw new AppError(400, 'INVALID_TAGS', 'Etiqueta não encontrada nesta instância.');
    }
    const r = await prisma.import.updateMany({
      where: { id: imp.id, status: { in: ['UPLOADED', 'ANALYZED'] } },
      data: { status: 'ANALYZING', mapping, processedRows: 0, error: null },
    });
    if (!r.count)
      throw new AppError(409, 'INVALID_STATE', 'Esta importação não pode mais ser reanalisada.');
    await queue.add({ type: 'analyze', importId: imp.id });
    reply.code(202);
    return { ok: true };
  });

  // 5. Pré-visualização das linhas classificadas.
  app.get('/accounts/:accountId/imports/:id/rows', auth, async (req) => {
    const { imp } = await loadImport(req);
    const q = parse(
      z.object({
        status: z
          .enum(['VALID', 'DUPLICATE', 'INVALID', 'OPTED_OUT', 'IMPORTED', 'SKIPPED'])
          .optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const where = { importId: imp.id, ...(q.status && { status: q.status }) };
    const [rows, total] = await Promise.all([
      prisma.importRow.findMany({
        where,
        orderBy: { rowNumber: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.importRow.count({ where }),
    ]);
    const items: ImportRowDTO[] = rows.map((r) => ({
      rowNumber: r.rowNumber,
      raw: r.raw as string[],
      name: r.name,
      phoneE164: r.phoneE164,
      status: r.status,
      reason: r.reason,
    }));
    return { items, total };
  });

  // 9–10. Confirmação explícita → importação assíncrona.
  app.post('/accounts/:accountId/imports/:id/confirm', auth, async (req, reply) => {
    const { account, imp } = await loadImport(req);
    const { queue } = services();
    if (imp.status === 'ANALYZED' && imp.validRows === 0) {
      throw new AppError(400, 'NOTHING_TO_IMPORT', 'Não há registros válidos para importar.');
    }
    // Transição atômica: impede confirmação dupla.
    const r = await prisma.import.updateMany({
      where: { id: imp.id, status: 'ANALYZED' },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), processedRows: 0 },
    });
    if (!r.count)
      throw new AppError(
        409,
        'INVALID_STATE',
        'A importação precisa estar analisada e ainda não confirmada.',
      );
    await queue.add({ type: 'run', importId: imp.id });
    await audit(prisma, req, {
      action: 'import.confirmed',
      actorId: req.auth!.user.id,
      entityType: 'import',
      entityId: imp.id,
      accountId: account.id,
      details: { fileName: imp.fileName, validRows: imp.validRows },
    });
    reply.code(202);
    return { ok: true };
  });

  app.post('/accounts/:accountId/imports/:id/cancel', auth, async (req) => {
    const { account, imp } = await loadImport(req);
    const r = await prisma.import.updateMany({
      where: { id: imp.id, status: { in: ['UPLOADED', 'ANALYZED', 'FAILED'] } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    if (!r.count)
      throw new AppError(
        409,
        'INVALID_STATE',
        'Esta importação não pode ser cancelada no estado atual.',
      );
    await audit(prisma, req, {
      action: 'import.cancelled',
      actorId: req.auth!.user.id,
      entityType: 'import',
      entityId: imp.id,
      accountId: account.id,
    });
    return { ok: true };
  });

  app.get('/accounts/:accountId/imports/:id/rejected', auth, async (req, reply) => {
    const { imp } = await loadImport(req);
    const { storage } = services();
    if (!imp.rejectedFileKey)
      throw Errors.notFound('Não há registros rejeitados nesta importação.');
    const base =
      imp.fileName
        .replace(/\.[^.]+$/, '')
        .normalize('NFD')
        .replace(/[^\w-]+/g, '-')
        .slice(0, 60) || 'lista';
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${base}-rejeitados.csv"`)
      .header('cache-control', 'no-store');
    return reply.send(await storage.get(imp.rejectedFileKey));
  });
}
