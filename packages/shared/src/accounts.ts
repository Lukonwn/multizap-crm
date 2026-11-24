import { z } from 'zod';
import { normalizePhone } from './phone';

export const ACCOUNT_STATUSES = [
  'NOT_CONFIGURED',
  'AWAITING_CONNECTION',
  'CONNECTED',
  'DISCONNECTED',
  'ATTENTION',
  'NEEDS_REPAIR',
  'DISABLED',
] as const;
export type AccountStatusValue = (typeof ACCOUNT_STATUSES)[number];

export const CONNECTION_TYPES = ['WHATSAPP_WEB', 'EXTERNAL_DEVICE'] as const;
export type ConnectionTypeValue = (typeof CONNECTION_TYPES)[number];

export const ACCOUNT_STATUS_LABEL: Record<AccountStatusValue, string> = {
  NOT_CONFIGURED: 'Não configurada',
  AWAITING_CONNECTION: 'Aguardando conexão',
  CONNECTED: 'Conectada',
  DISCONNECTED: 'Desconectada',
  ATTENTION: 'Atenção',
  NEEDS_REPAIR: 'Requer novo pareamento',
  DISABLED: 'Desativada',
};

export const CONNECTION_TYPE_LABEL: Record<ConnectionTypeValue, string> = {
  WHATSAPP_WEB: 'Dispositivo conectado',
  EXTERNAL_DEVICE: 'Aparelho externo cadastrado',
};

/** Códigos de motivo gravados em accounts.status_reason. */
export const STATUS_REASON = {
  connectionReplaced: 'connection_replaced',
  loggedOut: 'logged_out',
  reconnectFailing: 'reconnect_failing',
  badSession: 'bad_session',
  pairingExpired: 'pairing_expired',
  pairingCancelled: 'pairing_cancelled',
  removedByAdmin: 'removed_by_admin',
  credentialsUnreadable: 'credentials_unreadable',
} as const;

export const STATUS_REASON_LABEL: Record<string, string> = {
  credentials_unreadable:
    'As credenciais salvas não puderam ser lidas (a CREDENTIALS_MASTER_KEY mudou?). Nada foi apagado: restaure a chave anterior e clique em Reconectar, ou remova a conexão e pareie novamente.',
  connection_replaced: 'A sessão foi aberta em outro local. Reconecte manualmente se desejar.',
  logged_out:
    'O dispositivo foi desconectado pelo WhatsApp ou pelo celular. É necessário parear novamente.',
  reconnect_failing: 'Várias tentativas de reconexão falharam. O sistema continua tentando.',
  bad_session: 'O WhatsApp rejeitou a sessão. O sistema tentará reconectar.',
  pairing_expired: 'O tempo para concluir o pareamento expirou.',
  pairing_cancelled: 'Pareamento cancelado.',
  removed_by_admin: 'Conexão removida pelo administrador.',
};

const phoneField = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (!v) return null;
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

export const createAccountSchema = z
  .object({
    name: z.string().trim().min(2, 'Informe um nome com ao menos 2 caracteres.').max(60),
    connectionType: z.enum(CONNECTION_TYPES),
    phone: phoneField.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.connectionType === 'EXTERNAL_DEVICE' && !v.phone) {
      ctx.addIssue({
        code: 'custom',
        path: ['phone'],
        message: 'Informe o número do aparelho externo.',
      });
    }
  });
export type CreateAccountInput = z.input<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  name: z.string().trim().min(2, 'Informe um nome com ao menos 2 caracteres.').max(60).optional(),
  phone: phoneField.optional(),
});

export const startPairingSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('qr') }),
  z.object({
    method: z.literal('pairing-code'),
    phone: z
      .string()
      .trim()
      .transform((v, ctx) => {
        const r = normalizePhone(v);
        if (!r.ok) {
          ctx.addIssue({ code: 'custom', message: 'Telefone inválido. Use o número com DDD.' });
          return z.NEVER;
        }
        return r.e164;
      }),
  }),
]);
export type StartPairingInput = z.input<typeof startPairingSchema>;

/** Confirmação explícita por digitação do nome da instância (ações destrutivas). */
export const confirmByNameSchema = z.object({ confirmName: z.string() });

export interface AccountDTO {
  id: string;
  name: string;
  phoneE164: string | null;
  connectionType: ConnectionTypeValue;
  status: AccountStatusValue;
  statusReason: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  integration: {
    provider: string;
    waJid: string | null;
    deviceName: string | null;
    pairedAt: string | null;
    lastCheckAt: string | null;
    lastError: string | null;
    hasCredentials: boolean;
  } | null;
}

export interface ConnectionEventDTO {
  id: string;
  type: string;
  message: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}
