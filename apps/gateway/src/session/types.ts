/**
 * Abstração da conexão WhatsApp usada pelo SessionManager.
 * A implementação real (Baileys) fica em ../whatsapp; os testes usam uma
 * implementação falsa, o que permite validar toda a lógica de estados.
 */
export type CloseReason =
  | 'logged_out'
  | 'restart_required'
  | 'connection_replaced'
  | 'bad_session'
  | 'qr_timeout'
  | 'connection_lost'
  | 'multidevice_mismatch'
  | 'forbidden'
  | 'unavailable'
  | 'unknown';

export type ConnEvent =
  | { type: 'qr'; qr: string }
  | { type: 'open'; jid: string; name?: string }
  | { type: 'close'; reason: CloseReason; statusCode?: number; message?: string }
  | { type: 'activity' }
  | { type: 'message-status'; id: string; status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' }
  /** Mensagens recebidas pela sessão. historical = histórico entregue pelo WhatsApp (não conta como nova). */
  | { type: 'messages'; messages: IncomingMessage[]; historical: boolean }
  /** Nomes e correspondência LID ↔ telefone que o WhatsApp entrega ao aparelho conectado. */
  | { type: 'identities'; items: IdentityUpdate[] }
  /** Resumo do que o WhatsApp entregou na sincronização inicial (diagnóstico). */
  | {
      type: 'history';
      chats: number;
      contacts: number;
      messages: number;
      lidMappings: number;
      progress: number | null;
    };

/** Dados de identidade de um contato, como entregues pelo WhatsApp à sessão. */
export interface IdentityUpdate {
  /** Identificador principal (telefone ou LID). */
  id?: string;
  lid?: string;
  /** JID de telefone (…@s.whatsapp.net). */
  phoneJid?: string;
  /** Nome salvo na agenda do celular. */
  savedName?: string;
  /** Nome que o próprio contato definiu no perfil. */
  pushName?: string;
  verifiedName?: string;
}

/** Texto mostrado enquanto o celular ainda não reenviou o conteúdo de uma mensagem. */
export const PENDING_CONTENT_TEXT =
  'Aguardando o conteúdo da mensagem (o celular precisa reenviá-la)…';

export type IncomingMessageType =
  'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact' | 'other';

export interface IncomingMessage {
  id: string;
  /** JID da conversa, preferencialmente o de telefone (…@s.whatsapp.net). */
  chatJid: string;
  /** JID original (LID) quando a conversa foi endereçada por LID e o telefone é conhecido. */
  lidJid?: string;
  phoneE164: string | null;
  fromMe: boolean;
  timestamp: Date;
  type: IncomingMessageType;
  text: string | null;
  pushName: string | null;
  mimetype?: string;
  fileName?: string;
  /** Nome técnico do tipo, quando não é um dos tipos tratados. */
  kind?: string;
  /** Conteúdo ainda não recebido: será substituído quando o WhatsApp reenviar a mensagem. */
  pending?: boolean;
  /** Duração de áudios, em segundos. */
  seconds?: number;
  /** Baixa a mídia (somente imagens são armazenadas). */
  download?: () => Promise<Buffer>;
}

export interface OutgoingMessage {
  text: string;
  image?: Buffer;
  mimetype?: string;
  /** Mídia de qualquer tipo (entregáveis): imagem, vídeo, áudio ou documento. */
  media?: {
    kind: 'image' | 'video' | 'audio' | 'document';
    data: Buffer;
    mimetype: string;
    fileName?: string;
  };
}

export interface WaConnection {
  /** Solicita o código de pareamento ao WhatsApp. `phoneDigits` sem "+". */
  requestPairingCode(phoneDigits: string): Promise<string>;
  /** Fecha o socket SEM desvincular o dispositivo (credenciais preservadas). */
  end(): void;
  /** Desvincula o dispositivo no WhatsApp. */
  logout(): Promise<void>;
  /** URL da foto de perfil (miniatura) de uma conversa existente; null se não houver ou for privada. */
  profilePictureUrl?(jid: string): Promise<string | null>;
  /** Envia uma mensagem individual. Retorna o id atribuído pelo WhatsApp. */
  sendMessage(jid: string, message: OutgoingMessage): Promise<{ id: string; timestamp: number }>;
  /** Mostra "digitando…" ou o apaga em uma conversa individual. */
  sendPresence?(jid: string, state: 'composing' | 'paused'): Promise<void>;
}

export interface ConnectionFactory {
  open(accountId: string, onEvent: (e: ConnEvent) => void): Promise<WaConnection>;
}

export interface AuthStoreLike {
  /** Apaga credenciais e chaves de sinalização da instância. */
  clear(accountId: string): Promise<void>;
}

/** As credenciais existem, mas não podem ser descriptografadas (chave trocada ou dado corrompido). */
export class CredentialsUnreadableError extends Error {
  constructor(cause: string) {
    super(`Credenciais ilegíveis: ${cause}`);
    this.name = 'CredentialsUnreadableError';
  }
}
