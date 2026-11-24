import { z } from 'zod';

export const ASSET_KINDS = ['IMAGE', 'BANNER', 'TEXT', 'LINK', 'TEMPLATE', 'FILE'] as const;
export type AssetKindValue = (typeof ASSET_KINDS)[number];
export const FILE_ASSET_KINDS = ['IMAGE', 'BANNER', 'FILE'] as const;
export const CONTENT_ASSET_KINDS = ['TEXT', 'LINK', 'TEMPLATE'] as const;

export const ASSET_KIND_LABEL: Record<AssetKindValue, string> = {
  IMAGE: 'Imagem',
  BANNER: 'Banner',
  TEXT: 'Texto',
  LINK: 'Link',
  TEMPLATE: 'Modelo de mensagem',
  FILE: 'Arquivo',
};

/**
 * Tipos aceitos, identificados pelo CONTEÚDO do arquivo (assinatura), nunca
 * só pela extensão. SVG não é aceito (pode conter scripts).
 */
export const ALLOWED_MIME: Record<string, { ext: string; label: string; image?: boolean }> = {
  'image/jpeg': { ext: 'jpg', label: 'JPEG', image: true },
  'image/png': { ext: 'png', label: 'PNG', image: true },
  'image/webp': { ext: 'webp', label: 'WebP', image: true },
  'image/gif': { ext: 'gif', label: 'GIF', image: true },
  'video/mp4': { ext: 'mp4', label: 'Vídeo MP4' },
  'audio/mpeg': { ext: 'mp3', label: 'Áudio MP3' },
  'audio/ogg': { ext: 'ogg', label: 'Áudio OGG' },
  'application/pdf': { ext: 'pdf', label: 'PDF' },
};

/** Limite de texto de uma mensagem do WhatsApp. */
export const MAX_MESSAGE_LENGTH = 4096;

/** Variáveis disponíveis nos modelos de mensagem (preenchidas por contato nas campanhas). */
export const TEMPLATE_VARIABLES: Record<string, string> = {
  nome: 'Nome completo do contato',
  primeiro_nome: 'Primeiro nome do contato',
  telefone: 'Telefone do contato',
};

const VAR_RE = /{{\s*([a-zA-Z_][\w]*)\s*}}/g;

export function extractVariables(text: string): string[] {
  return [...new Set([...text.matchAll(VAR_RE)].map((m) => m[1]!))];
}

/** Substitui as variáveis; valores ausentes viram texto vazio. */
export function renderTemplate(
  text: string,
  values: Partial<Record<string, string | null | undefined>>,
): string {
  return text.replace(VAR_RE, (_, v: string) => values[v] ?? '');
}

export const SAMPLE_TEMPLATE_VALUES = {
  nome: 'Maria Silva',
  primeiro_nome: 'Maria',
  telefone: '+55 11 98765-4321',
};

const name = z.string().trim().min(1, 'Informe um nome.').max(120);
const folderId = z.string().uuid().nullable().optional();

const messageText = z
  .string()
  .trim()
  .min(1, 'Informe o texto.')
  .max(MAX_MESSAGE_LENGTH, `Máximo de ${MAX_MESSAGE_LENGTH} caracteres.`);

const url = z
  .string()
  .trim()
  .url('Link inválido.')
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'Use um link http:// ou https://.');

const templateText = messageText.superRefine((t, ctx) => {
  const unknown = extractVariables(t).filter((v) => !(v in TEMPLATE_VARIABLES));
  if (unknown.length) {
    ctx.addIssue({
      code: 'custom',
      message: `Variável desconhecida: ${unknown.map((v) => `{{${v}}}`).join(', ')}. Disponíveis: ${Object.keys(
        TEMPLATE_VARIABLES,
      )
        .map((v) => `{{${v}}}`)
        .join(', ')}.`,
    });
  }
});

export const createContentAssetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TEXT'), name, folderId, textContent: messageText }),
  z.object({
    kind: z.literal('LINK'),
    name,
    folderId,
    url,
    description: z.string().trim().max(500).optional().nullable(),
  }),
  z.object({ kind: z.literal('TEMPLATE'), name, folderId, textContent: templateText }),
]);
export type CreateContentAssetInput = z.input<typeof createContentAssetSchema>;

export const updateAssetSchema = z.object({
  name: name.optional(),
  folderId,
  textContent: z.string().optional(),
  url: z.string().optional(),
  description: z.string().trim().max(500).optional().nullable(),
});

/** Revalida o conteúdo conforme o tipo do criativo. */
export function contentSchemaFor(kind: AssetKindValue) {
  if (kind === 'TEMPLATE') return templateText;
  if (kind === 'TEXT') return messageText;
  return null;
}
export const assetUrlSchema = url;

export const folderSchema = z.object({
  name: z.string().trim().min(1, 'Informe um nome.').max(60),
  parentId: z.string().uuid().nullable().optional(),
});

export const assetListQuerySchema = z.object({
  /** "root" = sem pasta; uuid = pasta; ausente = todas. */
  folder: z.union([z.literal('root'), z.string().uuid()]).optional(),
  kind: z.enum(ASSET_KINDS).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(48),
});

export interface AssetFolderDTO {
  id: string;
  name: string;
  parentId: string | null;
  assetCount: number;
  createdAt: string;
}

export interface AssetDTO {
  id: string;
  kind: AssetKindValue;
  name: string;
  folderId: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  textContent: string | null;
  url: string | null;
  description: string | null;
  variables: string[];
  hasFile: boolean;
  hasThumbnail: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssetUsageDTO {
  id: string;
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  createdAt: string;
}
