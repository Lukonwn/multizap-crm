import type { Prisma, PrismaClient } from '@multizap/database';
import {
  readRows,
  writerToStream,
  type Delimiter,
  type Encoding,
  type FileFormat,
} from '@multizap/files';
import { importMappingSchema, parseImportRow, type ImportMapping } from '@multizap/shared';
import type { StorageDriver } from '@multizap/storage';

const BATCH = 1000;
const RUN_BATCH = 500;

interface ImportOptions {
  encoding: Encoding;
  delimiter: Delimiter | null;
}

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/**
 * Processamento de importações em duas etapas:
 *  1. analyze — lê o arquivo inteiro, classifica cada linha (válida, inválida,
 *     duplicada no arquivo, já existente, descadastrada) e gera o arquivo de
 *     rejeitados. NADA é importado aqui.
 *  2. run — somente após confirmação do administrador. Processa em lotes
 *     transacionais: cada lote marca suas linhas como IMPORTED, de modo que
 *     uma falha/reinício retoma exatamente de onde parou (sem duplicar).
 */
export class ImportProcessor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageDriver,
    private readonly log: Log = () => undefined,
  ) {}

  // ─── Análise ────────────────────────────────────────────────────────────

  async analyze(importId: string): Promise<void> {
    const imp = await this.prisma.import.findUnique({ where: { id: importId } });
    if (!imp || imp.status !== 'ANALYZING') return;
    const mapping = importMappingSchema.parse(imp.mapping);
    const options = imp.options as unknown as ImportOptions;

    await this.prisma.importRow.deleteMany({ where: { importId } });
    const counters = { total: 0, valid: 0, duplicate: 0, existing: 0, invalid: 0, optedOut: 0 };
    const seen = new Map<string, number>();
    let batch: { rowNumber: number; raw: string[] }[] = [];

    const flush = async () => {
      if (!batch.length) return;
      const parsed = batch.map((b) => ({ ...b, p: parseImportRow(b.raw, mapping) }));
      const phones = [...new Set(parsed.map((x) => x.p.phoneE164).filter((p): p is string => !!p))];
      const [existing, optOuts] = await Promise.all([
        this.prisma.contact.findMany({
          where: { accountId: imp.accountId, phoneE164: { in: phones } },
          select: { id: true, phoneE164: true },
        }),
        this.prisma.optOut.findMany({
          where: { accountId: imp.accountId, phoneE164: { in: phones } },
          select: { phoneE164: true },
        }),
      ]);
      const existingMap = new Map(existing.map((c) => [c.phoneE164, c.id]));
      const optedOut = new Set(optOuts.map((o) => o.phoneE164));

      const rows: Prisma.ImportRowCreateManyInput[] = parsed.map(({ rowNumber, raw, p }) => {
        const base = {
          importId,
          rowNumber,
          raw,
          name: p.name,
          phoneE164: p.phoneE164,
          tags: p.tags,
          notes: p.notes,
        };
        if (!p.phoneE164) {
          counters.invalid++;
          return { ...base, status: 'INVALID' as const, reason: p.invalidReason };
        }
        const first = seen.get(p.phoneE164);
        if (first !== undefined) {
          counters.duplicate++;
          return {
            ...base,
            status: 'DUPLICATE' as const,
            reason: `Duplicado no arquivo (linha ${first})`,
          };
        }
        seen.set(p.phoneE164, rowNumber);
        if (optedOut.has(p.phoneE164)) {
          counters.optedOut++;
          return {
            ...base,
            status: 'OPTED_OUT' as const,
            reason: 'Telefone descadastrado nesta instância',
          };
        }
        const existingId = existingMap.get(p.phoneE164);
        if (existingId) {
          counters.existing++;
          if (mapping.existingPolicy === 'skip') {
            counters.duplicate++;
            return {
              ...base,
              status: 'DUPLICATE' as const,
              reason: 'Já cadastrado nesta instância',
              existingContactId: existingId,
            };
          }
          counters.valid++;
          return {
            ...base,
            status: 'VALID' as const,
            reason: 'Será atualizado',
            existingContactId: existingId,
          };
        }
        counters.valid++;
        return { ...base, status: 'VALID' as const };
      });
      await this.prisma.importRow.createMany({ data: rows });
      await this.prisma.import.update({
        where: { id: importId },
        data: { processedRows: counters.total },
      });
      batch = [];
    };

    let lineNo = 0;
    for await (const row of readRows(
      await this.storage.get(imp.fileKey),
      imp.format as FileFormat,
      options,
    )) {
      lineNo++;
      if (mapping.hasHeader && lineNo === 1) continue;
      if (!row.length) continue; // linhas vazias são ignoradas
      counters.total++;
      batch.push({ rowNumber: lineNo, raw: row });
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    const rejectedFileKey = await this.writeRejected(imp.id, imp.fileKey, mapping);
    await this.prisma.import.update({
      where: { id: importId },
      data: {
        status: 'ANALYZED',
        totalRows: counters.total,
        validRows: counters.valid,
        duplicateRows: counters.duplicate,
        existingRows: counters.existing,
        invalidRows: counters.invalid,
        optedOutRows: counters.optedOut,
        processedRows: counters.total,
        rejectedFileKey,
        error: null,
      },
    });
    this.log('Importação analisada', { importId, ...counters });
  }

  /** CSV com as linhas rejeitadas (linha, situação, motivo + colunas originais). */
  private async writeRejected(
    importId: string,
    fileKey: string,
    mapping: ImportMapping,
  ): Promise<string | null> {
    const count = await this.prisma.importRow.count({
      where: { importId, status: { in: ['INVALID', 'DUPLICATE', 'OPTED_OUT'] } },
    });
    if (count === 0) return null;
    const key = fileKey.replace(/\/[^/]+$/, '/rejeitados.csv');
    const { writer, stream } = writerToStream('csv');
    const upload = this.storage.put(key, stream, { contentType: 'text/csv; charset=utf-8' });
    const header = mapping.hasHeader ? ((await this.firstRow(fileKey, importId)) ?? []) : [];
    await writer.write(['linha', 'situacao', 'motivo', ...header]);
    let cursor = 0;
    for (;;) {
      const rows = await this.prisma.importRow.findMany({
        where: {
          importId,
          status: { in: ['INVALID', 'DUPLICATE', 'OPTED_OUT'] },
          rowNumber: { gt: cursor },
        },
        orderBy: { rowNumber: 'asc' },
        take: BATCH,
      });
      if (!rows.length) break;
      for (const r of rows) {
        const situacao = {
          INVALID: 'Inválido',
          DUPLICATE: 'Duplicado',
          OPTED_OUT: 'Descadastrado',
        }[r.status as 'INVALID'];
        await writer.write([r.rowNumber, situacao, r.reason ?? '', ...(r.raw as string[])]);
      }
      cursor = rows[rows.length - 1]!.rowNumber;
    }
    await writer.end();
    await upload;
    return key;
  }

  private async firstRow(fileKey: string, importId: string): Promise<string[] | null> {
    const imp = await this.prisma.import.findUniqueOrThrow({ where: { id: importId } });
    const stream = await this.storage.get(fileKey);
    for await (const row of readRows(
      stream,
      imp.format as FileFormat,
      imp.options as unknown as ImportOptions,
    )) {
      stream.destroy();
      return row;
    }
    return null;
  }

  // ─── Importação (após confirmação) ──────────────────────────────────────

  async run(importId: string): Promise<void> {
    const imp = await this.prisma.import.findUnique({ where: { id: importId } });
    if (!imp || !['CONFIRMED', 'PROCESSING'].includes(imp.status)) return;
    const mapping = importMappingSchema.parse(imp.mapping);
    const { accountId } = imp;
    const startedAt = imp.startedAt ?? new Date();
    await this.prisma.import.update({
      where: { id: importId },
      data: { status: 'PROCESSING', startedAt },
    });

    // Etiquetas aplicadas a todos (validadas pela API como pertencentes à instância).
    const applyTags = await this.prisma.tag.findMany({
      where: { accountId, id: { in: mapping.applyTagIds } },
      select: { id: true },
    });
    const consentGranted = mapping.consent.status === 'GRANTED';
    const consentSource = mapping.consent.status === 'GRANTED' ? mapping.consent.source : null;
    const originDetail = `Importação: ${imp.fileName}`.slice(0, 200);

    for (;;) {
      const rows = await this.prisma.importRow.findMany({
        where: { importId, status: 'VALID' },
        orderBy: { rowNumber: 'asc' },
        take: RUN_BATCH,
      });
      if (!rows.length) break;

      await this.prisma.$transaction(
        async (tx) => {
          const phones = rows.map((r) => r.phoneE164!);
          const [optOuts, existingNow] = await Promise.all([
            tx.optOut.findMany({
              where: { accountId, phoneE164: { in: phones } },
              select: { phoneE164: true },
            }),
            tx.contact.findMany({
              where: { accountId, phoneE164: { in: phones } },
              select: { id: true, phoneE164: true, consentStatus: true, optedOutAt: true },
            }),
          ]);
          const optedOut = new Set(optOuts.map((o) => o.phoneE164));
          const existingMap = new Map(existingNow.map((c) => [c.phoneE164, c]));

          // Nomes de etiquetas vindos do arquivo → garante existência na instância.
          const tagNames = [...new Set(rows.flatMap((r) => r.tags))];
          if (tagNames.length) {
            await tx.tag.createMany({
              data: tagNames.map((name) => ({ accountId, name })),
              skipDuplicates: true,
            });
          }
          const tagRows = tagNames.length
            ? await tx.tag.findMany({
                where: { accountId, name: { in: tagNames } },
                select: { id: true, name: true },
              })
            : [];
          const tagId = new Map(tagRows.map((t) => [t.name, t.id]));

          const toCreate: typeof rows = [];
          const toUpdate: typeof rows = [];
          const skipped: { id: string; status: 'OPTED_OUT' | 'SKIPPED'; reason: string }[] = [];

          for (const r of rows) {
            if (optedOut.has(r.phoneE164!)) {
              skipped.push({
                id: r.id,
                status: 'OPTED_OUT',
                reason: 'Descadastrado após a análise',
              });
            } else if (r.existingContactId) {
              toUpdate.push(r);
            } else if (existingMap.has(r.phoneE164!)) {
              skipped.push({
                id: r.id,
                status: 'SKIPPED',
                reason: 'Cadastrado na instância durante a importação',
              });
            } else {
              toCreate.push(r);
            }
          }

          if (toCreate.length) {
            await tx.contact.createMany({
              data: toCreate.map((r) => ({
                accountId,
                phoneE164: r.phoneE164!,
                name: r.name,
                notes: r.notes,
                origin: 'IMPORT' as const,
                originDetail,
                consentStatus: consentGranted ? ('GRANTED' as const) : ('PENDING' as const),
                consentAt: consentGranted ? new Date() : null,
              })),
              skipDuplicates: true,
            });
          }
          const created = toCreate.length
            ? await tx.contact.findMany({
                where: { accountId, phoneE164: { in: toCreate.map((r) => r.phoneE164!) } },
                select: { id: true, phoneE164: true },
              })
            : [];
          const createdId = new Map(created.map((c) => [c.phoneE164, c.id]));

          for (const r of toUpdate) {
            const current = existingMap.get(r.phoneE164!);
            const data: Prisma.ContactUpdateInput = {};
            if (r.name) data.name = r.name;
            if (r.notes) data.notes = r.notes;
            // Consentimento só evolui de PENDENTE para AUTORIZADO; nunca sobrescreve revogação.
            if (consentGranted && current?.consentStatus === 'PENDING' && !current.optedOutAt) {
              data.consentStatus = 'GRANTED';
              data.consentAt = new Date();
            }
            if (Object.keys(data).length)
              await tx.contact.update({ where: { id: r.existingContactId! }, data });
          }

          const contactOf = (r: (typeof rows)[number]) =>
            r.existingContactId ?? createdId.get(r.phoneE164!)!;
          const processed = [...toCreate, ...toUpdate];

          const links = processed.flatMap((r) => {
            const ids = [
              ...new Set([
                ...r.tags.map((n) => tagId.get(n)!).filter(Boolean),
                ...applyTags.map((t) => t.id),
              ]),
            ];
            return ids.map((tid) => ({ contactId: contactOf(r), tagId: tid }));
          });
          if (links.length) await tx.contactTag.createMany({ data: links, skipDuplicates: true });

          if (consentGranted && consentSource) {
            const grantedIds = [
              ...toCreate.map((r) => ({ r, id: createdId.get(r.phoneE164!)! })),
              ...toUpdate
                .filter(
                  (r) =>
                    existingMap.get(r.phoneE164!)?.consentStatus === 'PENDING' &&
                    !existingMap.get(r.phoneE164!)?.optedOutAt,
                )
                .map((r) => ({ r, id: r.existingContactId! })),
            ];
            if (grantedIds.length) {
              await tx.consentEvent.createMany({
                data: grantedIds.map(({ r, id }) => ({
                  accountId,
                  contactId: id,
                  action: 'GRANTED' as const,
                  source: consentSource,
                  evidence: `${originDetail} (linha ${r.rowNumber})`,
                })),
              });
            }
          }

          for (const r of toCreate) {
            await tx.importRow.update({
              where: { id: r.id },
              data: { status: 'IMPORTED', contactId: contactOf(r), reason: null },
            });
          }
          for (const r of toUpdate) {
            await tx.importRow.update({
              where: { id: r.id },
              data: { status: 'IMPORTED', contactId: r.existingContactId, reason: 'Atualizado' },
            });
          }
          for (const s of skipped) {
            await tx.importRow.update({
              where: { id: s.id },
              data: { status: s.status, reason: s.reason },
            });
          }
          await tx.import.update({
            where: { id: importId },
            data: {
              importedRows: { increment: toCreate.length },
              updatedRows: { increment: toUpdate.length },
              skippedRows: { increment: skipped.length },
            },
          });
        },
        { timeout: 60_000 },
      );
      await this.prisma.import.update({
        where: { id: importId },
        data: {
          processedRows: await this.prisma.importRow.count({
            where: { importId, status: { not: 'VALID' } },
          }),
        },
      });
    }

    const done = await this.prisma.import.update({
      where: { id: importId },
      data: { status: 'COMPLETED', finishedAt: new Date(), processedRows: imp.totalRows },
    });
    await this.prisma.auditLog.create({
      data: {
        action: 'import.completed',
        entityType: 'import',
        entityId: importId,
        accountId,
        details: {
          fileName: imp.fileName,
          imported: done.importedRows,
          updated: done.updatedRows,
          skipped: done.skippedRows,
        },
      },
    });
    this.log('Importação concluída', {
      importId,
      imported: done.importedRows,
      updated: done.updatedRows,
    });
  }

  /** Marca falha definitiva e notifica o administrador. */
  async fail(importId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const imp = await this.prisma.import.findUnique({ where: { id: importId } });
    if (!imp) return;
    await this.prisma.import.update({
      where: { id: importId },
      data: { status: 'FAILED', error: message.slice(0, 500), finishedAt: new Date() },
    });
    await this.prisma.systemNotification.create({
      data: {
        severity: 'ERROR',
        category: 'IMPORT',
        title: 'Falha na importação',
        message: `A importação de "${imp.fileName}" falhou: ${message.slice(0, 200)}`,
        accountId: imp.accountId,
        dedupeKey: `import:${importId}:failed`,
      },
    });
  }
}
