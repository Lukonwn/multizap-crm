import { z } from 'zod';
import { PHONE_REASON_LABEL, normalizePhone, type CountryCode } from './phone';

export const IMPORT_FIELDS = ['phone', 'name', 'tags', 'notes'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABEL: Record<ImportField, string> = {
  phone: 'Telefone',
  name: 'Nome',
  tags: 'Etiquetas',
  notes: 'Observações',
};

export const IMPORT_STATUS_LABEL: Record<string, string> = {
  UPLOADED: 'Aguardando mapeamento',
  ANALYZING: 'Analisando',
  ANALYZED: 'Aguardando confirmação',
  CONFIRMED: 'Na fila',
  PROCESSING: 'Importando',
  COMPLETED: 'Concluída',
  FAILED: 'Falhou',
  CANCELLED: 'Cancelada',
};

export const IMPORT_ROW_STATUS_LABEL: Record<string, string> = {
  VALID: 'Válido',
  DUPLICATE: 'Duplicado',
  INVALID: 'Inválido',
  OPTED_OUT: 'Descadastrado',
  IMPORTED: 'Importado',
  SKIPPED: 'Ignorado',
};

const column = z.number().int().min(0).max(500).nullable().optional();

export const importMappingSchema = z
  .object({
    hasHeader: z.boolean(),
    columns: z.object({
      phone: z.number().int().min(0).max(500),
      name: column,
      tags: column,
      notes: column,
    }),
    defaultCountry: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .default('BR'),
    consent: z.discriminatedUnion('status', [
      z.object({ status: z.literal('PENDING') }),
      z.object({
        status: z.literal('GRANTED'),
        source: z
          .string()
          .trim()
          .min(5, 'Descreva como o consentimento desta lista foi obtido.')
          .max(300),
      }),
    ]),
    applyTagIds: z.array(z.string().uuid()).max(20).default([]),
    /** Contatos já existentes na instância: ignorar ou atualizar nome/observações/etiquetas. */
    existingPolicy: z.enum(['skip', 'update']).default('skip'),
  })
  .superRefine((m, ctx) => {
    const used = [m.columns.phone, m.columns.name, m.columns.tags, m.columns.notes].filter(
      (c) => c !== null && c !== undefined,
    );
    if (new Set(used).size !== used.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['columns'],
        message: 'Cada coluna só pode ser mapeada para um campo.',
      });
    }
  });
export type ImportMapping = z.infer<typeof importMappingSchema>;
export type ImportMappingInput = z.input<typeof importMappingSchema>;

const strip = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const HEADER_HINTS: Record<ImportField, string[]> = {
  phone: [
    'telefone',
    'phone',
    'celular',
    'whatsapp',
    'whats',
    'numero',
    'fone',
    'tel',
    'mobile',
    'contato',
  ],
  name: ['nome', 'name', 'cliente', 'nomecompleto', 'fullname'],
  tags: ['etiquetas', 'etiqueta', 'tags', 'tag', 'grupo', 'segmento'],
  notes: ['observacoes', 'observacao', 'obs', 'notas', 'notes', 'comentario', 'comentarios'],
};

/** Sugere o mapeamento pelo cabeçalho; sem cabeçalho, pela coluna que mais parece telefone. */
export function suggestMapping(sample: string[][], hasHeader: boolean): ImportMapping['columns'] {
  const result: { phone: number; name: number | null; tags: number | null; notes: number | null } =
    {
      phone: 0,
      name: null,
      tags: null,
      notes: null,
    };
  const width = Math.max(0, ...sample.map((r) => r.length));
  const taken = new Set<number>();
  if (hasHeader && sample[0]) {
    const headers = sample[0].map(strip);
    for (const field of IMPORT_FIELDS) {
      const idx = headers.findIndex(
        (h, i) =>
          !taken.has(i) && HEADER_HINTS[field].some((hint) => h === hint || h.startsWith(hint)),
      );
      if (idx >= 0) {
        (result as Record<string, number | null>)[field] = idx;
        taken.add(idx);
      }
    }
    if (
      taken.has(result.phone) &&
      headers[result.phone] !== undefined &&
      HEADER_HINTS.phone.some((h) => headers[result.phone]!.startsWith(h))
    ) {
      return result;
    }
  }
  // Coluna com mais telefones válidos
  const body = hasHeader ? sample.slice(1) : sample;
  let best = 0;
  let bestScore = -1;
  for (let c = 0; c < width; c++) {
    if (taken.has(c) && c !== result.phone) continue;
    const score = body.filter((r) => r[c] && normalizePhone(r[c]!).ok).length;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  result.phone = best;
  return result;
}

/** Há cabeçalho quando a primeira linha não tem telefone válido e as seguintes têm. */
export function guessHasHeader(sample: string[][]): boolean {
  if (sample.length < 2) return false;
  const hasPhone = (r: string[]) => r.some((c) => normalizePhone(c).ok);
  return !hasPhone(sample[0]!) && sample.slice(1).some(hasPhone);
}

export interface ParsedRow {
  phoneE164: string | null;
  name: string | null;
  tags: string[];
  notes: string | null;
  invalidReason: string | null;
}

/** Interpreta uma linha conforme o mapeamento (validação apenas ESTRUTURAL do telefone). */
export function parseImportRow(
  raw: string[],
  m: Pick<ImportMapping, 'columns' | 'defaultCountry'>,
): ParsedRow {
  const get = (i: number | null | undefined) =>
    i === null || i === undefined ? '' : (raw[i] ?? '').trim();
  const phoneRaw = get(m.columns.phone);
  const name = get(m.columns.name).slice(0, 120) || null;
  const notes = get(m.columns.notes).slice(0, 2000) || null;
  const tags = get(m.columns.tags)
    .split(/[,;|]/)
    .map((t) => t.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 20);
  const r = normalizePhone(phoneRaw, m.defaultCountry as CountryCode);
  return {
    phoneE164: r.ok ? r.e164 : null,
    name,
    tags,
    notes,
    invalidReason: r.ok ? null : PHONE_REASON_LABEL[r.reason],
  };
}

export interface ImportDTO {
  id: string;
  accountId: string;
  accountName?: string;
  fileName: string;
  fileSize: number;
  format: string;
  status: string;
  columns: string[];
  sample: string[][];
  hasHeader: boolean;
  suggested: ImportMapping['columns'] | null;
  mapping: ImportMapping | null;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  existingRows: number;
  invalidRows: number;
  optedOutRows: number;
  importedRows: number;
  updatedRows: number;
  skippedRows: number;
  processedRows: number;
  hasRejectedFile: boolean;
  error: string | null;
  createdAt: string;
  confirmedAt: string | null;
  finishedAt: string | null;
}

export interface ImportRowDTO {
  rowNumber: number;
  raw: string[];
  name: string | null;
  phoneE164: string | null;
  status: string;
  reason: string | null;
}

export const IMPORTS_QUEUE = 'imports';
export type ImportJob = { type: 'analyze'; importId: string } | { type: 'run'; importId: string };

export const MAX_IMPORT_BYTES_DEFAULT = 100 * 1024 * 1024;
