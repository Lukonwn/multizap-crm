import makeWASocket, { Browsers, makeCacheableSignalKeyStore } from 'baileys';
import type { Logger } from 'pino';
import type { ConnEvent, ConnectionFactory, WaConnection } from '../session/types';
import type { DbAuthStore } from './auth-store';
import { mapDisconnect } from './disconnect';

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

    sock.ev.on('messages.upsert', () => onEvent({ type: 'activity' }));

    return {
      requestPairingCode: (phoneDigits) => sock.requestPairingCode(phoneDigits),
      end: () => sock.end(undefined),
      logout: () => sock.logout(),
    };
  }
}
