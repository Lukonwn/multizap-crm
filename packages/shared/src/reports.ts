import { z } from 'zod';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');

export const reportQuerySchema = z
  .object({
    from: day,
    to: day,
    accountId: z.string().uuid().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'A data inicial deve ser anterior à final.', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366, { message: 'Período máximo de 1 ano.', path: ['to'] });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export interface ReportTotals {
  contactsCreated: number;
  consentsGranted: number;
  optOuts: number;
  campaignsCreated: number;
  campaignsCompleted: number;
  messagesSent: number;
  messagesDelivered: number;
  messagesRead: number;
  messagesFailed: number;
  messagesReceived: number;
}

export interface ReportSeriesPoint {
  date: string;
  sent: number;
  delivered: number;
  read: number;
  received: number;
  failed: number;
}

export interface ReportCampaignRow {
  id: string;
  name: string;
  status: string;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  replied: number;
}

export interface ReportDTO {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  timezone: string;
  totals: ReportTotals;
  previous: ReportTotals;
  snapshot: { contacts: number; authorized: number; optedOut: number };
  series: ReportSeriesPoint[];
  byAccount: ({ accountId: string; accountName: string } & ReportTotals)[];
  campaigns: ReportCampaignRow[];
}

export const REPORT_METRIC_LABEL: Record<keyof ReportTotals, string> = {
  contactsCreated: 'Contatos cadastrados',
  consentsGranted: 'Consentimentos registrados',
  optOuts: 'Descadastramentos',
  campaignsCreated: 'Campanhas criadas',
  campaignsCompleted: 'Campanhas concluídas',
  messagesSent: 'Mensagens enviadas',
  messagesDelivered: 'Mensagens entregues',
  messagesRead: 'Mensagens lidas',
  messagesFailed: 'Falhas',
  messagesReceived: 'Respostas recebidas',
};
