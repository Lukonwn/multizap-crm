import { z } from 'zod';

/**
 * Ferramentas de processamento de listas. Cada execução é um file_job
 * processado pelo worker; os resultados ficam disponíveis para download.
 */
export const TOOL_IDS = [
  'convert',
  'split',
  'compare',
  'dedupe',
  'extract-phones',
  'group-ddd',
  'group-country',
  'remove-empty',
  'sanitize',
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export interface ToolMeta {
  id: ToolId;
  name: string;
  description: string;
  /** Quantidade de arquivos de entrada. */
  inputs: 1 | 2;
  /** Usa a coluna de telefone (selecionável). */
  phoneColumn: boolean;
  group: 'lists' | 'sanitize';
}

export const TOOLS: Record<ToolId, ToolMeta> = {
  convert: {
    id: 'convert',
    name: 'Conversor CSV/XLSX',
    description: 'Converte listas entre CSV, TXT e XLSX.',
    inputs: 1,
    phoneColumn: false,
    group: 'lists',
  },
  split: {
    id: 'split',
    name: 'Divisor de arquivos',
    description: 'Divide uma lista em partes menores, mantendo o cabeçalho.',
    inputs: 1,
    phoneColumn: false,
    group: 'lists',
  },
  compare: {
    id: 'compare',
    name: 'Comparador de listas',
    description: 'Compara duas listas pelo telefone: só na A, só na B e em ambas.',
    inputs: 2,
    phoneColumn: true,
    group: 'lists',
  },
  dedupe: {
    id: 'dedupe',
    name: 'Removedor de duplicados',
    description: 'Remove linhas repetidas pelo telefone normalizado ou pela linha inteira.',
    inputs: 1,
    phoneColumn: true,
    group: 'lists',
  },
  'extract-phones': {
    id: 'extract-phones',
    name: 'Extrator de telefones',
    description: 'Encontra telefones em qualquer coluna ou texto livre.',
    inputs: 1,
    phoneColumn: false,
    group: 'lists',
  },
  'group-ddd': {
    id: 'group-ddd',
    name: 'Organizador por DDD',
    description: 'Separa números brasileiros por DDD e estado.',
    inputs: 1,
    phoneColumn: true,
    group: 'lists',
  },
  'group-country': {
    id: 'group-country',
    name: 'Organizador por país',
    description: 'Separa números pelo código internacional.',
    inputs: 1,
    phoneColumn: true,
    group: 'lists',
  },
  'remove-empty': {
    id: 'remove-empty',
    name: 'Removedor de linhas vazias',
    description: 'Remove linhas sem conteúdo e espaços sobrando.',
    inputs: 1,
    phoneColumn: false,
    group: 'lists',
  },
  sanitize: {
    id: 'sanitize',
    name: 'Higienizador',
    description:
      'Normaliza, valida a estrutura, identifica DDD e país, detecta duplicados e incompletos e classifica cada registro.',
    inputs: 1,
    phoneColumn: true,
    group: 'sanitize',
  },
};

const outputFormat = z.enum(['csv', 'xlsx']).default('csv');
const country = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .default('BR');
/** Ausente = detecção automática. */
const column = z.number().int().min(0).max(500).optional();
const hasHeader = z.boolean().optional();

const phoneTool = { outputFormat, defaultCountry: country, phoneColumn: column, hasHeader };

export const toolParamsSchemas = {
  convert: z.object({ outputFormat }),
  split: z
    .object({
      outputFormat,
      hasHeader,
      mode: z.enum(['rows', 'parts']).default('rows'),
      size: z.number().int().min(1).max(10_000_000),
    })
    .refine((v) => v.mode !== 'parts' || v.size <= 1000, {
      message: 'No máximo 1.000 partes.',
      path: ['size'],
    }),
  compare: z.object({
    outputFormat,
    defaultCountry: country,
    phoneColumnA: column,
    phoneColumnB: column,
    hasHeaderA: hasHeader,
    hasHeaderB: hasHeader,
  }),
  dedupe: z.object({ ...phoneTool, by: z.enum(['phone', 'row']).default('phone') }),
  'extract-phones': z.object({
    outputFormat,
    defaultCountry: country,
    hasHeader,
    unique: z.boolean().default(true),
  }),
  'group-ddd': z.object(phoneTool),
  'group-country': z.object(phoneTool),
  'remove-empty': z.object({ outputFormat }),
  sanitize: z.object(phoneTool),
} satisfies Record<ToolId, z.ZodTypeAny>;

export type ToolParams<T extends ToolId> = z.infer<(typeof toolParamsSchemas)[T]>;

export const createToolJobSchema = z.object({
  tool: z.enum(TOOL_IDS),
  uploadIds: z.array(z.string().uuid()).min(1).max(2),
  params: z.record(z.unknown()).default({}),
});

export interface ToolUploadDTO {
  id: string;
  fileName: string;
  format: 'csv' | 'txt' | 'xlsx';
  size: number;
  sample: string[][];
  hasHeader: boolean;
  suggestedPhoneColumn: number;
}

export interface ToolOutput {
  key: string;
  name: string;
  rows: number | null;
  contentType: string;
}

export interface ToolJobDTO {
  id: string;
  tool: ToolId;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  inputs: { name: string; size: number }[];
  params: Record<string, unknown>;
  progress: number;
  outputs: { name: string; rows: number | null }[];
  summary: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export const TOOLS_QUEUE = 'file-tools';
export type ToolJobData = { jobId: string };

export const JOB_STATUS_LABEL: Record<ToolJobDTO['status'], string> = {
  QUEUED: 'Na fila',
  RUNNING: 'Processando',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  CANCELLED: 'Cancelado',
};
