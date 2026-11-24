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
  | { type: 'activity' };

export interface WaConnection {
  /** Solicita o código de pareamento ao WhatsApp. `phoneDigits` sem "+". */
  requestPairingCode(phoneDigits: string): Promise<string>;
  /** Fecha o socket SEM desvincular o dispositivo (credenciais preservadas). */
  end(): void;
  /** Desvincula o dispositivo no WhatsApp. */
  logout(): Promise<void>;
}

export interface ConnectionFactory {
  open(accountId: string, onEvent: (e: ConnEvent) => void): Promise<WaConnection>;
}

export interface AuthStoreLike {
  /** Apaga credenciais e chaves de sinalização da instância. */
  clear(accountId: string): Promise<void>;
}
