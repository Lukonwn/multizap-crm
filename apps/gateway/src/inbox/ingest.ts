import { recordSystemEvent, type PrismaClient } from '@multizap/database';
import { isOptOutMessage, MESSAGE_TYPE_LABEL } from '@multizap/shared';
import type { StorageDriver } from '@multizap/storage';
import type { IncomingMessage } from '../session/types';
import { IdentityService, isLidJid } from './identity';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

const HISTORY_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

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
    if (exists) return;
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

    let mediaKey: string | null = null;
    if (m.type === 'image' && m.download && this.storage && !historical) {
      try {
        const buf = await m.download();
        if (buf.length <= MAX_MEDIA_BYTES) {
          mediaKey = `media/${accountId}/${m.id.replace(/[^\w-]/g, '_')}.jpg`;
          await this.storage.put(mediaKey, buf, { contentType: m.mimetype ?? 'image/jpeg' });
        }
      } catch (err) {
        this.log('Mídia não baixada', { accountId, id: m.id, err: String(err) });
      }
    }

    const preview = previewOf(m);
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
      await tx.message.create({
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
    });

    // Descadastramento por palavra-chave ("SAIR"), somente em mensagens novas do contato.
    if (!historical && !m.fromMe && contact && isOptOutMessage(m.text) && !contact.optedOutAt) {
      await this.prisma.$transaction([
        this.prisma.optOut.upsert({
          where: { accountId_phoneE164: { accountId, phoneE164: contact.phoneE164 } },
          create: {
            accountId,
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
            accountId,
            contactId: contact.id,
            action: 'REVOKED',
            source: 'Pedido de descadastro pelo WhatsApp',
            evidence: `Mensagem "${m.text?.trim()}" em ${m.timestamp.toISOString()}`,
          },
        }),
        this.prisma.systemNotification.create({
          data: {
            accountId,
            severity: 'INFO',
            category: 'SYSTEM',
            title: 'Contato pediu descadastramento',
            message: `${contact.name ?? contact.phoneE164} respondeu "${m.text?.trim()}" e foi descadastrado automaticamente.`,
          },
        }),
      ]);
    }
  }
}
