/** Palavras que, enviadas sozinhas pelo contato, registram o descadastramento. */
export const OPT_OUT_KEYWORDS = ['SAIR', 'PARAR', 'STOP', 'CANCELAR', 'DESCADASTRAR', 'REMOVER'];

export function isOptOutMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  return OPT_OUT_KEYWORDS.includes(t);
}

export const CONVERSATION_FILTERS = ['all', 'unread', 'pending', 'answered', 'closed'] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

export const CONVERSATION_STATUS_LABEL: Record<string, string> = {
  OPEN: 'Aberta',
  PENDING: 'Pendente',
  ANSWERED: 'Respondida',
  CLOSED: 'Finalizada',
};

export const MESSAGE_TYPE_LABEL: Record<string, string> = {
  image: 'Imagem',
  video: 'Vídeo',
  audio: 'Áudio',
  document: 'Documento',
  sticker: 'Figurinha',
  location: 'Localização',
  contact: 'Contato',
  other: 'Mensagem não suportada',
};

export interface ConversationDTO {
  id: string;
  accountId: string;
  accountName: string;
  contactId: string | null;
  contactName: string | null;
  phoneE164: string | null;
  /** Rota da foto de perfil (da própria API), quando disponível. */
  photoUrl: string | null;
  title: string | null;
  status: 'OPEN' | 'PENDING' | 'ANSWERED' | 'CLOSED';
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export interface MessageDTO {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  type: string;
  body: string | null;
  status: string;
  hasMedia: boolean;
  fromCampaign: boolean;
  sentAt: string;
}

export interface ReplyPermission {
  allowed: boolean;
  reason: string | null;
}
