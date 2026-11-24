import makeWASocket, {
  Browsers,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  type WAMessage,
} from 'baileys';
import type { Logger } from 'pino';
import type { ConnEvent, ConnectionFactory, WaConnection } from '../session/types';
import type { DbAuthStore } from './auth-store';
import { mapAck, mapDisconnect } from './disconnect';
import { normalizeMessage } from './normalize';

/**
 * Cria conexões de dispositivo conectado via Baileys.
 *
 * Configuração conservadora:
 *  - markOnlineOnConnect: false → o celular continua recebendo notificações;
 *  - syncFullHistory: false → apenas a sincronização inicial padrão do WhatsApp.
 *    Ela NÃO é desativada: o Baileys 7 depende dela para obter os mapeamentos
 *    LID, e bloqueá-la causa instabilidade e erros de sessão. Até a Central de
 *    Mensagens (Fase 7) nada do histórico recebido é armazenado;
 *  - nenhum comportamento automatizado além de manter a conexão.
 */
export class BaileysFactory implements ConnectionFactory {
  constructor(
    private readonly store: DbAuthStore,
    private readonly logger: Logger,
    private readonly browserName = 'Chrome',
  ) {}

  async open(accountId: string, onEvent: (e: ConnEvent) => void): Promise<WaConnection> {
    const { state, saveCreds } = await this.store.load(accountId);
    const log = this.logger.child({ accountId });

    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, log) },
      logger: log,
      browser: Browsers.macOS(this.browserName),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });

    sock.ev.on('creds.update', () => {
      saveCreds().catch((err: unknown) => log.error({ err }, 'Falha ao salvar credenciais'));
    });

    sock.ev.on('connection.update', (u) => {
      if (u.qr) onEvent({ type: 'qr', qr: u.qr });
      if (u.connection === 'open') {
        onEvent({ type: 'open', jid: sock.user?.id ?? '', name: sock.user?.name ?? undefined });
      }
      if (u.connection === 'close') {
        const err = u.lastDisconnect?.error as
          { output?: { statusCode?: number }; message?: string } | undefined;
        const statusCode = err?.output?.statusCode;
        onEvent({
          type: 'close',
          reason: mapDisconnect(statusCode, err?.message),
          statusCode,
          message: err?.message,
        });
      }
    });

    const toIncoming = (list: WAMessage[]) =>
      list.flatMap((m) => {
        const n = normalizeMessage(m);
        if (!n) return [];
        if (n.type === 'image') {
          n.download = () =>
            downloadMediaMessage(
              m,
              'buffer',
              {},
              { logger: log, reuploadRequest: sock.updateMediaMessage },
            );
        }
        return [n];
      });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      onEvent({ type: 'activity' });
      const incoming = toIncoming(messages);
      // "notify" = mensagem nova; "append" = mensagens anexadas (ex.: de outro aparelho/histórico).
      if (incoming.length)
        onEvent({ type: 'messages', messages: incoming, historical: type !== 'notify' });
    });

    // Histórico recente entregue pelo próprio WhatsApp ao vincular o dispositivo.
    sock.ev.on('messaging-history.set', ({ messages }) => {
      const incoming = toIncoming(messages);
      if (incoming.length) onEvent({ type: 'messages', messages: incoming, historical: true });
    });

    // Confirmações reais do WhatsApp para mensagens enviadas por esta sessão.
    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (!u.key.fromMe || !u.key.id || u.update.status === undefined || u.update.status === null)
          continue;
        const status = mapAck(Number(u.update.status));
        if (status) onEvent({ type: 'message-status', id: u.key.id, status });
      }
    });

    return {
      requestPairingCode: (phoneDigits) => sock.requestPairingCode(phoneDigits),
      end: () => sock.end(undefined),
      logout: () => sock.logout(),
      sendMessage: async (jid, m) => {
        const content = m.image
          ? { image: m.image, mimetype: m.mimetype, caption: m.text }
          : { text: m.text };
        const sent = await sock.sendMessage(jid, content);
        if (!sent?.key?.id) throw new Error('O WhatsApp não confirmou o envio.');
        return {
          id: sent.key.id,
          timestamp: Number(sent.messageTimestamp ?? Math.floor(Date.now() / 1000)),
        };
      },
    };
  }
}
