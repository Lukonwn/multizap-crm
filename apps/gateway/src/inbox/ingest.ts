import { recordSystemEvent, type Message, type PrismaClient } from '@multizap/database';
import { isOptOutMessage, MESSAGE_TYPE_LABEL } from '@multizap/shared';
import type { StorageDriver } from '@multizap/storage';
import type { IncomingMessage } from '../session/types';
import { IdentityService, isLidJid } from './identity';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

const HISTORY_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 25_000;
const MEDIA_CONCURRENCY = 2;
const MEDIA_QUEUE_MAX = 400;

type MediaJob = { accountId: string; messageId: string; m: IncomingMessage };

/** Só imagens e áudios são guardados (voz e fotos); demais tipos aparecem identificados. */
const isStorableMedia = (m: Pick<IncomingMessage, 'type' | 'download'>) =>
  (m.type === 'image' || m.type === 'audio') && !!m.download;

function mediaExt(m: Pick<IncomingMessage, 'type' | 'mimetype'>): string {
  if (m.type === 'image') return 'jpg';
  const t = (m.mimetype ?? '').toLowerCase();
  if (t.includes('mpeg')) return 'mp3';
  if (t.includes('mp4') || t.includes('m4a')) return 'm4a';
  if (t.includes('aac')) return 'aac';
  if (t.includes('amr')) return 'amr';
  if (t.includes('wav')) return 'wav';
  return 'ogg';
}

export function previewOf(m: Pick<IncomingMessage, 'type' | 'text'>): string {
  // "other" com descrição (enquete, álbum...) mostra só a descrição.
  const bare = m.type === 'text' || (m.type === 'other' && !!m.text);
  const label = bare ? '' : `[${MESSAGE_TYPE_LABEL[m.type] ?? 'Mensagem'}] `;
  return `${label}${m.text ?? ''}`.trim().slice(0, 120);
}

/**
 * Registra as mensagens recebidas pela sessão (Central de Mensagens).
 * Somente conversas individuais; nada é inventado: apenas o que o WhatsApp
 * entregou a esta sessão (ao vivo ou como histórico recente).
 */
export class InboxIngest {
  private readonly unknownKinds = new Set<string>();
  private readonly mediaQueue: MediaJob[] = [];
  private mediaActive = 0;
  readonly identities: IdentityService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageDriver | null,
    private readonly log: Log = () => undefined,
  ) {
    this.identities = new IdentityService(prisma, log);
  }

  async ingest(accountId: string, messages: IncomingMessage[], historical: boolean): Promise<void> {
    const minTs = Date.now() - HISTORY_WINDOW_MS;
    const sorted = [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    for (const m of sorted) {
      if (historical && m.timestamp.getTime() < minTs) continue;
      try {
        await this.one(accountId, m, historical);
      } catch (err) {
        this.log('Falha ao registrar mensagem', { accountId, id: m.id, err: String(err) });
      }
    }
  }

  private async one(accountId: string, original: IncomingMessage, historical: boolean) {
    const exists = await this.prisma.message.findUnique({
      where: { accountId_providerMessageId: { accountId, providerMessageId: original.id } },
    });
    if (exists) {
      await this.upgrade(accountId, exists, original, historical);
      return;
    }
    let m = original;

    // Identidade: registra a correspondência LID ↔ telefone e o nome de perfil, e resolve
    // o telefone de conversas endereçadas por LID quando o WhatsApp já o informou.
    // Qualquer falha aqui é registrada, mas NUNCA impede a gravação da mensagem.
    let identityName: string | null = null;
    try {
      if (m.lidJid)
        await this.identities.apply(accountId, [{ lid: m.lidJid, phoneJid: m.chatJid }]);
      if (!m.fromMe && m.pushName)
        await this.identities.apply(accountId, [
          { id: m.lidJid ?? m.chatJid, pushName: m.pushName },
        ]);
      const known = await this.identities.lookup(accountId, m.lidJid ?? m.chatJid);
      if (!m.phoneE164 && known?.phoneE164 && known.phoneJid && isLidJid(m.chatJid))
        m = { ...m, chatJid: known.phoneJid, phoneE164: known.phoneE164 };
      identityName = known?.name ?? null;
    } catch (err) {
      this.log('Identidade não aplicada', { accountId, id: m.id, err: String(err) });
    }

    if (m.kind && !this.unknownKinds.has(m.kind) && m.type === 'other' && m.text?.startsWith('(')) {
      this.unknownKinds.add(m.kind);
      await recordSystemEvent(this.prisma, {
        source: 'gateway',
        level: 'info',
        type: 'unhandled_message_kind',
        message: `Tipo de mensagem ainda não tratado pela Central: ${m.kind}.`,
      });
    }

    // Contato: vincula ao existente; cria somente para quem escreveu agora (origem "mensagem recebida").
    let contact = m.phoneE164
      ? await this.prisma.contact.findUnique({
          where: { accountId_phoneE164: { accountId, phoneE164: m.phoneE164 } },
        })
      : null;
    if (!contact && m.phoneE164 && !m.fromMe && !historical) {
      contact = await this.prisma.contact.upsert({
        where: { accountId_phoneE164: { accountId, phoneE164: m.phoneE164 } },
        create: {
          accountId,
          phoneE164: m.phoneE164,
          name: m.pushName?.slice(0, 120) ?? null,
          origin: 'INBOUND',
          originDetail: 'Enviou mensagem pelo WhatsApp',
        },
        update: {},
      });
    }

    // Ao vivo: baixa na hora. Histórico: vai para uma fila (não trava a sincronização).
    let mediaKey: string | null = null;
    if (isStorableMedia(m) && this.storage && !historical) {
      try {
        mediaKey = await this.fetchMedia(accountId, m);
      } catch (err) {
        this.log('Mídia não baixada', { accountId, id: m.id, err: String(err) });
      }
    }

    const preview = previewOf(m);
    let createdId = '';
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.conversation.findUnique({
        where: { accountId_remoteJid: { accountId, remoteJid: m.chatJid } },
      });
      const newer = !existing?.lastMessageAt || existing.lastMessageAt <= m.timestamp;
      const live = !historical;
      const conv = existing
        ? await tx.conversation.update({
            where: { id: existing.id },
            data: {
              contactId: existing.contactId ?? contact?.id ?? null,
              title:
                existing.title ??
                identityName ??
                (m.fromMe ? null : m.pushName) ??
                contact?.name ??
                null,
              ...(!existing.phoneE164 && m.phoneE164 && { phoneE164: m.phoneE164 }),
              ...(newer && { lastMessageAt: m.timestamp, lastMessagePreview: preview }),
              ...(live && !m.fromMe && { unreadCount: { increment: 1 }, status: 'PENDING' }),
              ...(live && m.fromMe && { status: 'ANSWERED' }),
            },
          })
        : await tx.conversation.create({
            data: {
              accountId,
              remoteJid: m.chatJid,
              contactId: contact?.id ?? null,
              title: identityName ?? (m.fromMe ? null : m.pushName) ?? contact?.name ?? null,
              phoneE164: m.phoneE164,
              lastMessageAt: m.timestamp,
              lastMessagePreview: preview,
              unreadCount: live && !m.fromMe ? 1 : 0,
              status: live ? (m.fromMe ? 'ANSWERED' : 'PENDING') : 'OPEN',
            },
          });
      const created = await tx.message.create({
        data: {
          accountId,
          conversationId: conv.id,
          providerMessageId: m.id,
          direction: m.fromMe ? 'OUTBOUND' : 'INBOUND',
          type: m.type,
          body: m.text ?? (m.fileName ? m.fileName : null),
          mediaKey,
          status: m.fromMe ? 'SENT' : 'RECEIVED',
          sentAt: m.timestamp,
        },
      });
      createdId = created.id;
    });
    if (historical && isStorableMedia(m)) this.enqueueMedia({ accountId, messageId: createdId, m });

    await this.maybeOptOut(m, contact, historical);
  }

  /** Descadastramento por palavra-chave ("SAIR"), somente em mensagens novas do contato. */
  private async maybeOptOut(
    m: IncomingMessage,
    contact: {
      id: string;
      accountId: string;
      phoneE164: string;
      name: string | null;
      optedOutAt: Date | null;
    } | null,
    historical: boolean,
  ) {
    if (!historical && !m.fromMe && contact && isOptOutMessage(m.text) && !contact.optedOutAt) {
      await this.prisma.$transaction([
        this.prisma.optOut.upsert({
          where: {
            accountId_phoneE164: { accountId: contact.accountId, phoneE164: contact.phoneE164 },
          },
          create: {
            accountId: contact.accountId,
            phoneE164: contact.phoneE164,
            reason: `Respondeu "${m.text?.trim()}"`,
            source: 'whatsapp_keyword',
          },
          update: {},
        }),
        this.prisma.contact.update({
          where: { id: contact.id },
          data: { optedOutAt: new Date(), consentStatus: 'REVOKED' },
        }),
        this.prisma.consentEvent.create({
          data: {
            accountId: contact.accountId,
            contactId: contact.id,
            action: 'REVOKED',
            source: 'Pedido de descadastro pelo WhatsApp',
            evidence: `Mensagem "${m.text?.trim()}" em ${m.timestamp.toISOString()}`,
          },
        }),
        this.prisma.systemNotification.create({
          data: {
            accountId: contact.accountId,
            severity: 'INFO',
            category: 'SYSTEM',
            title: 'Contato pediu descadastramento',
            message: `${contact.name ?? contact.phoneE164} respondeu "${m.text?.trim()}" e foi descadastrado automaticamente.`,
          },
        }),
      ]);
    }
  }

  /**
   * O WhatsApp reenvia, com o mesmo ID, mensagens cujo conteúdo não chegou (marcador
   * "aguardando") ou que a Central ainda não entendia. Quando o conteúdo real chega,
   * a mensagem já gravada é atualizada em vez de ser ignorada como repetida.
   */
  private async upgrade(
    accountId: string,
    stored: Message,
    m: IncomingMessage,
    historical: boolean,
  ) {
    if (stored.type !== 'other' || m.pending) return;
    const body = m.text ?? (m.fileName ? m.fileName : null);
    if (m.type === 'other' && body === stored.body) return;
    await this.prisma.message.update({ where: { id: stored.id }, data: { type: m.type, body } });
    const conv = await this.prisma.conversation.findUnique({
      where: { id: stored.conversationId },
    });
    if (conv?.lastMessageAt && conv.lastMessageAt.getTime() === stored.sentAt.getTime())
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { lastMessagePreview: previewOf(m) },
      });
    if (isStorableMedia(m) && !stored.mediaKey)
      this.enqueueMedia({ accountId, messageId: stored.id, m });
    if (conv?.contactId) {
      const contact = await this.prisma.contact.findUnique({ where: { id: conv.contactId } });
      await this.maybeOptOut(m, contact, historical);
    }
  }

  // ─── Mídia (áudios e imagens) ───

  /** Baixa a mídia e guarda no bucket. Retorna a chave, ou null se for grande demais. */
  private async fetchMedia(accountId: string, m: IncomingMessage): Promise<string | null> {
    if (!this.storage || !m.download) return null;
    const buf = await Promise.race([
      m.download(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('tempo esgotado')), MEDIA_TIMEOUT_MS).unref(),
      ),
    ]);
    if (buf.length > (m.type === 'audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES)) return null;
    const key = `media/${accountId}/${m.id.replace(/[^\w-]/g, '_')}.${mediaExt(m)}`;
    await this.storage.put(key, buf, {
      contentType: m.mimetype ?? (m.type === 'audio' ? 'audio/ogg' : 'image/jpeg'),
    });
    return key;
  }

  private enqueueMedia(job: MediaJob) {
    if (!this.storage || !job.messageId || this.mediaQueue.length >= MEDIA_QUEUE_MAX) return;
    this.mediaQueue.push(job);
    this.pumpMedia();
  }

  private pumpMedia() {
    while (this.mediaActive < MEDIA_CONCURRENCY && this.mediaQueue.length) {
      const job = this.mediaQueue.shift()!;
      this.mediaActive++;
      void this.runMedia(job).finally(() => {
        this.mediaActive--;
        this.pumpMedia();
      });
    }
  }

  private async runMedia(job: MediaJob) {
    try {
      const key = await this.fetchMedia(job.accountId, job.m);
      if (key)
        await this.prisma.message.update({ where: { id: job.messageId }, data: { mediaKey: key } });
    } catch (err) {
      // Mídia antiga pode ter saído do servidor do WhatsApp: a mensagem continua, sem o arquivo.
      this.log('Mídia do histórico não baixada', { id: job.m.id, err: String(err).slice(0, 120) });
    }
  }

  /** Espera a fila de downloads esvaziar (usado nos testes). */
  async mediaIdle(): Promise<void> {
    while (this.mediaActive > 0 || this.mediaQueue.length > 0)
      await new Promise((r) => setTimeout(r, 10));
  }
}
