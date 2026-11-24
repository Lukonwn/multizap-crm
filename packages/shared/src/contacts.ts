import { z } from 'zod';
import { normalizePhone } from './phone';

export const CONSENT_STATUSES = ['PENDING', 'GRANTED', 'REVOKED'] as const;
export type ConsentStatusValue = (typeof CONSENT_STATUSES)[number];

export const CONSENT_LABEL: Record<ConsentStatusValue, string> = {
  PENDING: 'Pendente',
  GRANTED: 'Autorizado',
  REVOKED: 'Revogado',
};

export const CONTACT_ORIGINS = ['MANUAL', 'IMPORT', 'INBOUND', 'OTHER'] as const;
export type ContactOriginValue = (typeof CONTACT_ORIGINS)[number];
export const ORIGIN_LABEL: Record<ContactOriginValue, string> = {
  MANUAL: 'Cadastro manual',
  IMPORT: 'Importação',
  INBOUND: 'Mensagem recebida',
  OTHER: 'Outra',
};

const phone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const r = normalizePhone(v);
    if (!r.ok) {
      ctx.addIssue({
        code: 'custom',
        message: 'Telefone inválido. Inclua o DDD (e o código do país, se não for do Brasil).',
      });
      return z.NEVER;
    }
    return r.e164;
  });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const consentSource = z
  .string()
  .trim()
  .min(3, 'Descreva como o consentimento foi obtido.')
  .max(300);

export const createContactSchema = z.object({
  name: optionalText(120),
  phone,
  notes: optionalText(2000),
  tagIds: z.array(z.string().uuid()).max(50).default([]),
  consent: z
    .object({ source: consentSource, evidence: optionalText(1000) })
    .optional()
    .nullable(),
});
export type CreateContactInput = z.input<typeof createContactSchema>;

export const updateContactSchema = z.object({
  name: optionalText(120),
  notes: optionalText(2000),
  tagIds: z.array(z.string().uuid()).max(50).optional(),
});

export const consentActionSchema = z.object({
  action: z.enum(['GRANTED', 'REVOKED']),
  source: consentSource,
  evidence: optionalText(1000),
});

export const optOutSchema = z.object({ reason: optionalText(300) });

/** Reverter descadastramento exige um novo consentimento documentado. */
export const resubscribeSchema = z.object({ source: consentSource, evidence: optionalText(1000) });

export const tagSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome.').max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida.')
    .default('#10b981'),
});

export const contactListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  tagId: z.string().uuid().optional(),
  consent: z.enum(CONSENT_STATUSES).optional(),
  optedOut: z.enum(['true', 'false']).optional(),
  origin: z.enum(CONTACT_ORIGINS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ContactListQuery = z.input<typeof contactListQuerySchema>;

export interface TagDTO {
  id: string;
  name: string;
  color: string;
  contactCount?: number;
}

export interface ContactDTO {
  id: string;
  accountId: string;
  name: string | null;
  phoneE164: string;
  origin: ContactOriginValue;
  originDetail: string | null;
  consentStatus: ConsentStatusValue;
  consentAt: string | null;
  optedOutAt: string | null;
  notes: string | null;
  tags: TagDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface ContactHistoryItem {
  id: string;
  kind: 'consent' | 'audit';
  title: string;
  detail: string | null;
  createdAt: string;
}

export const TAG_COLORS = [
  '#10b981',
  '#38bdf8',
  '#a78bfa',
  '#f472b6',
  '#f59e0b',
  '#ef4444',
  '#94a3b8',
  '#14b8a6',
];
