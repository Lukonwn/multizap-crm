/**
 * Contratos dos provedores de canal.
 *
 * Cada provedor declara suas capacidades. A interface só habilita uma ação
 * quando a capacidade correspondente é `true`; caso contrário a ação aparece
 * como "Indisponível neste canal". Nada é simulado.
 *
 * Implementações:
 *  - whatsapp-web (Fase 2): dispositivo conectado — QR Code e código de pareamento.
 *  - manual (Fase 2): aparelho apenas cadastrado — sem envio nem sincronização.
 */

export type ProviderId = 'whatsapp-web' | 'manual';

export interface ProviderCapabilities {
  /** Pareamento exibindo QR Code fornecido pelo WhatsApp. */
  qrPairing: boolean;
  /** Pareamento por número: o WhatsApp gera um código de 8 caracteres. */
  pairingCode: boolean;
  /** Envio individual de mensagens (inclui campanha assistida). */
  sendMessage: boolean;
  /** Recebimento de mensagens em tempo real. */
  receiveMessages: boolean;
  /** Atualizações de status (enviada, entregue, lida). */
  messageStatus: boolean;
  /** Histórico entregue pelo WhatsApp ao vincular o dispositivo. */
  historySync: boolean;
}

export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  'whatsapp-web': {
    qrPairing: true,
    pairingCode: true,
    sendMessage: true,
    receiveMessages: true,
    messageStatus: true,
    historySync: true,
  },
  manual: {
    qrPairing: false,
    pairingCode: false,
    sendMessage: false,
    receiveMessages: false,
    messageStatus: false,
    historySync: false,
  },
};

export type ConnectionState =
  | { kind: 'idle' }
  | { kind: 'qr'; qr: string; expiresAt: number }
  | { kind: 'pairing-code'; code: string; phoneE164: string; expiresAt: number }
  | { kind: 'connecting' }
  | { kind: 'connected'; jid: string; deviceName?: string }
  | { kind: 'disconnected'; reason: string; recoverable: boolean }
  | { kind: 'logged-out'; reason: string };
