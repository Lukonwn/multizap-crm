/**
 * Protocolo entre API e gateway.
 *  - API → gateway: comandos em uma fila BullMQ (persistente; não se perdem
 *    se o gateway estiver reiniciando).
 *  - gateway → API: estado efêmero do pareamento no Redis (QR / código) e
 *    estado durável no PostgreSQL (status, eventos, notificações).
 */
export const GATEWAY_QUEUE = 'gateway-commands';

export type GatewayCommand =
  | { type: 'start-pairing'; accountId: string; method: 'qr' }
  | { type: 'start-pairing'; accountId: string; method: 'pairing-code'; phoneE164: string }
  | { type: 'cancel-pairing'; accountId: string }
  | { type: 'reconnect'; accountId: string }
  | { type: 'stop'; accountId: string }
  /** Encerra a sessão no WhatsApp (logout) e apaga as credenciais. Ação manual. */
  | { type: 'remove'; accountId: string }
  /** Envio individual confirmado pelo administrador (campanha assistida). */
  | { type: 'send-campaign-message'; accountId: string; recipientId: string }
  /** Resposta escrita pelo administrador na Central de Mensagens. */
  | { type: 'send-reply'; accountId: string; messageId: string };

export type PairingState =
  | { kind: 'starting'; method: 'qr' | 'pairing-code'; at: number }
  | { kind: 'qr'; qr: string; expiresAt: number; at: number }
  | { kind: 'pairing-code'; code: string; phoneE164: string; expiresAt: number; at: number }
  | { kind: 'connected'; at: number }
  | { kind: 'expired'; at: number }
  | { kind: 'failed'; message: string; at: number };

export const PAIRING_STATE_TTL_SECONDS = 180;

export const gatewayKeys = {
  pairing: (accountId: string) => `multizap:pairing:${accountId}`,
  lock: (accountId: string) => `multizap:gateway:lock:${accountId}`,
};

/** Formata o código de pareamento como "ABCD-EFGH". */
export function formatPairingCode(code: string): string {
  const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}
