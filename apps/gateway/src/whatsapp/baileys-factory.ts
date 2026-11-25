import makeWASocket, {
  Browsers,
  downloadMediaMessage,
  isLidUser,
  isPnUser,
  makeCacheableSignalKeyStore,
  type AnyMessageContent,
  type Contact,
  type LIDMapping,
  type WAMessage,
} from 'baileys';
import type { Logger } from 'pino';
import type {
  ConnEvent,
  ConnectionFactory,
  IdentityUpdate,
  IncomingMessage,
  OutgoingMessage,
  WaConnection,
} from '../session/types';
import type { DbAuthStore } from './auth-store';
import type { AppStateMonitor } from './app-state-monitor';
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
    private readonly appState?: AppStateMonitor,
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

    // Se a sincronização da agenda ficar parada esperando a chave do celular, tenta de novo
    // algumas vezes (recurso oficial da biblioteca); depois disso, só o aviso no System Health.
    const retryTimers: NodeJS.Timeout[] = [];
    const clearRetries = () => retryTimers.splice(0).forEach(clearTimeout);
    const scheduleResync = () => {
      if (!this.appState) return;
      clearRetries();
      [90_000, 360_000, 1_200_000].forEach((ms, i) => {
        const t = setTimeout(() => {
          const cols = this.appState!.blocked(accountId);
          if (!cols.length) return;
          this.appState!.retry(accountId, i + 1, cols);
          sock
            .resyncAppState(cols as Parameters<typeof sock.resyncAppState>[0], false)
            .catch((err: unknown) =>
              log.warn({ err: String(err) }, 'Nova sincronização da agenda falhou'),
            );
        }, ms);
        t.unref();
        retryTimers.push(t);
      });
    };

    sock.ev.on('connection.update', (u) => {
      if (u.qr) onEvent({ type: 'qr', qr: u.qr });
      if (u.connection === 'open') {
        scheduleResync();
        onEvent({ type: 'open', jid: sock.user?.id ?? '', name: sock.user?.name ?? undefined });
      }
      if (u.connection === 'close') {
        clearRetries();
        this.appState?.clear(accountId);
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

    const lids = sock.signalRepository?.lidMapping;
    /** Telefone de um LID, pela correspondência que o WhatsApp já entregou a esta sessão. */
    const pnForLid = async (jid: string | undefined | null): Promise<string | null> => {
      if (!jid || !isLidUser(jid) || !lids) return null;
      try {
        return (await lids.getPNForLID(jid)) ?? null;
      } catch {
        return null;
      }
    };

    const toIncoming = async (list: WAMessage[]) => {
      const out: IncomingMessage[] = [];
      for (const m of list) {
        const alt = (m.key as { remoteJidAlt?: string }).remoteJidAlt;
        const n = normalizeMessage(m, alt ? null : await pnForLid(m.key?.remoteJid));
        if (!n) continue;
        if (n.type === 'image' || n.type === 'audio') {
          n.download = () =>
            downloadMediaMessage(
              m,
              'buffer',
              {},
              { logger: log, reuploadRequest: sock.updateMediaMessage },
            );
        }
        out.push(n);
      }
      return out;
    };

    /** Nomes e LID ↔ telefone que o WhatsApp entrega ao aparelho conectado. */
    const toIdentities = (contacts: Contact[], mappings: LIDMapping[] = []): IdentityUpdate[] => [
      ...contacts.map((c) => ({
        id: c.id,
        lid: c.lid ?? (c.id && isLidUser(c.id) ? c.id : undefined),
        phoneJid: c.phoneNumber ?? (c.id && isPnUser(c.id) ? c.id : undefined),
        savedName: c.name,
        pushName: c.notify,
        verifiedName: c.verifiedName,
      })),
      ...mappings.map((x) => ({ lid: x.lid, phoneJid: x.pn })),
    ];
    const emitIdentities = (items: IdentityUpdate[]) => {
      if (items.length) onEvent({ type: 'identities', items });
    };

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      onEvent({ type: 'activity' });
      void toIncoming(messages).then((incoming) => {
        // "notify" = mensagem nova; "append" = mensagens anexadas (ex.: de outro aparelho/histórico).
        if (incoming.length)
          onEvent({ type: 'messages', messages: incoming, historical: type !== 'notify' });
      });
    });

    // Histórico recente, agenda e correspondência LID ↔ telefone entregues ao vincular o dispositivo.
    sock.ev.on(
      'messaging-history.set',
      ({ messages, contacts, lidPnMappings, chats, progress }) => {
        onEvent({
          type: 'history',
          chats: chats?.length ?? 0,
          contacts: contacts?.length ?? 0,
          messages: messages?.length ?? 0,
          lidMappings: lidPnMappings?.length ?? 0,
          progress: progress ?? null,
        });
        emitIdentities(toIdentities(contacts ?? [], lidPnMappings ?? []));
        void toIncoming(messages).then((incoming) => {
          if (incoming.length) onEvent({ type: 'messages', messages: incoming, historical: true });
        });
      },
    );
    sock.ev.on('contacts.upsert', (contacts) => emitIdentities(toIdentities(contacts)));
    sock.ev.on('contacts.update', (contacts) =>
      emitIdentities(toIdentities(contacts as Contact[])),
    );
    sock.ev.on('lid-mapping.update', (x) => emitIdentities(toIdentities([], [x])));

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
      sendPresence: async (jid, state) => {
        await sock.sendPresenceUpdate(state, jid);
      },
      profilePictureUrl: async (jid) => {
        try {
          return (await sock.profilePictureUrl(jid, 'preview', 10_000)) ?? null;
        } catch (err) {
          // Sem foto, foto privada ou conversa inexistente: não é erro.
          if (/item-not-found|not-authorized|not-acceptable|\b40[134]\b/i.test(String(err)))
            return null;
          throw err;
        }
      },
      end: () => {
        clearRetries();
        sock.end(undefined);
      },
      logout: () => sock.logout(),
      sendMessage: async (jid, m) => {
        const content = m.media
          ? mediaContent(m.media, m.text)
          : m.image
            ? { image: m.image, mimetype: m.mimetype, caption: m.text }
            : { text: m.text };
        const sent = await sock.sendMessage(jid, content as AnyMessageContent);
        if (!sent?.key?.id) throw new Error('O WhatsApp não confirmou o envio.');
        return {
          id: sent.key.id,
          timestamp: Number(sent.messageTimestamp ?? Math.floor(Date.now() / 1000)),
        };
      },
    };
  }
}

/** Conteúdo do Baileys para cada tipo de mídia (áudio não aceita legenda). */
function mediaContent(
  media: NonNullable<OutgoingMessage['media']>,
  caption: string,
): Record<string, unknown> {
  const cap = caption ? { caption } : {};
  switch (media.kind) {
    case 'image':
      return { image: media.data, mimetype: media.mimetype, ...cap };
    case 'video':
      return { video: media.data, mimetype: media.mimetype, ...cap };
    case 'audio':
      return { audio: media.data, mimetype: media.mimetype, ptt: false };
    default:
      return {
        document: media.data,
        mimetype: media.mimetype,
        fileName: media.fileName ?? 'arquivo',
        ...cap,
      };
  }
}
