import { z } from 'zod';
import { MAX_MESSAGE_LENGTH, TEMPLATE_VARIABLES, extractVariables, renderTemplate } from './assets';
import { formatPhone } from './phone';

export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'READY',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
] as const;
export type CampaignStatusValue = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatusValue, string> = {
  DRAFT: 'Rascunho',
  SCHEDULED: 'Agendada',
  READY: 'Fila pronta',
  RUNNING: 'Em andamento',
  PAUSED: 'Pausada',
  COMPLETED: 'Concluída',
  CANCELLED: 'Cancelada',
  FAILED: 'Falhou',
};

export const RECIPIENT_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Aguardando',
  SENDING: 'Enviando',
  SENT: 'Enviada',
  DELIVERED: 'Entregue',
  READ: 'Lida',
  FAILED: 'Falhou',
  SKIPPED: 'Pulada',
};

const body = z
  .string()
  .trim()
  .min(1, 'Escreva a mensagem.')
  .max(MAX_MESSAGE_LENGTH, `Máximo de ${MAX_MESSAGE_LENGTH} caracteres.`)
  .superRefine((t, ctx) => {
    const unknown = extractVariables(t).filter((v) => !(v in TEMPLATE_VARIABLES));
    if (unknown.length)
      ctx.addIssue({
        code: 'custom',
        message: `Variável desconhecida: ${unknown.map((v) => `{{${v}}}`).join(', ')}.`,
      });
  });

export const campaignInputSchema = z.object({
  name: z.string().trim().min(2, 'Informe um nome.').max(120),
  body,
  linkUrl: z
    .string()
    .trim()
    .url('Link inválido.')
    .refine((u) => /^https?:\/\//i.test(u), 'Use um link http:// ou https://.')
    .nullable()
    .optional(),
  assetId: z.string().uuid().nullable().optional(),
  templateId: z.string().uuid().nullable().optional(),
  accounts: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        tagIds: z.array(z.string().uuid()).max(20).default([]),
      }),
    )
    .min(1, 'Selecione ao menos uma instância.')
    .max(10)
    .refine((a) => new Set(a.map((x) => x.accountId)).size === a.length, 'Instância repetida.'),
});
export type CampaignInput = z.input<typeof campaignInputSchema>;

export const scheduleSchema = z.object({
  scheduledAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now() + 30_000, 'Escolha uma data e hora futuras.'),
});

export const audiencePreviewSchema = z.object({
  accountId: z.string().uuid(),
  tagIds: z.array(z.string().uuid()).max(20).default([]),
});

/** Valores das variáveis para um contato. */
export function contactVariables(contact: { name: string | null; phoneE164: string }) {
  const name = contact.name?.trim() || '';
  return {
    nome: name,
    primeiro_nome: name.split(/\s+/)[0] ?? '',
    telefone: formatPhone(contact.phoneE164),
  };
}

/** Texto final enviado a um contato: modelo preenchido + link (se não estiver no texto). */
export function buildCampaignMessage(
  campaign: { body: string; linkUrl?: string | null },
  contact: { name: string | null; phoneE164: string },
): string {
  let text = renderTemplate(campaign.body, contactVariables(contact))
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (campaign.linkUrl && !text.includes(campaign.linkUrl)) text = `${text}\n\n${campaign.linkUrl}`;
  return text;
}

export interface CampaignCounters {
  total: number;
  pending: number;
  sending: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
}

export interface CampaignAccountDTO {
  id: string;
  accountId: string;
  accountName: string;
  accountStatus: string;
  tagIds: string[];
  status: CampaignStatusValue;
  counters: CampaignCounters;
}

export interface CampaignDTO {
  id: string;
  name: string;
  status: CampaignStatusValue;
  body: string;
  linkUrl: string | null;
  assetId: string | null;
  asset: { id: string; name: string; hasThumbnail: boolean } | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  accounts: CampaignAccountDTO[];
  counters: CampaignCounters;
}

export interface NextRecipientDTO {
  recipient: {
    id: string;
    contactId: string;
    name: string | null;
    phoneE164: string;
    message: string;
  } | null;
  remaining: number;
  autoSkipped: number;
}

export interface RecipientDTO {
  id: string;
  accountId: string;
  contactId: string;
  name: string | null;
  phoneE164: string;
  status: string;
  error: string | null;
  confirmedAt: string | null;
  sentAt: string | null;
  updatedAt: string;
}

export const CAMPAIGNS_QUEUE = 'campaigns';
export type CampaignJob = { type: 'prepare'; campaignId: string };
