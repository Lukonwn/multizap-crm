import {
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  type WAMessage,
} from 'baileys';
import type { IncomingMessage } from '../session/types';

const IGNORED = new Set([
  'protocolMessage',
  'reactionMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'pollUpdateMessage',
  'keepInChatMessage',
  'encReactionMessage',
]);

function toMillis(ts: WAMessage['messageTimestamp']): number {
  if (typeof ts === 'number') return ts * 1000;
  const n = Number(ts?.toString?.() ?? 0);
  return n ? n * 1000 : Date.now();
}

/**
 * Converte uma mensagem do Baileys para o formato do domínio.
 * Retorna null para o que não pertence à Central de Mensagens: grupos,
 * transmissões/status, canais, reações e mensagens de protocolo.
 */
export function normalizeMessage(m: WAMessage): IncomingMessage | null {
  const jid = m.key?.remoteJid;
  if (!jid || !m.key.id) return null;
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return null;

  const content = normalizeMessageContent(m.message);
  if (!content) return null;
  const kind = getContentType(content);
  if (!kind || IGNORED.has(kind)) return null;

  // Endereçamento por LID: usa o número de telefone alternativo quando disponível.
  const alt = (m.key as { remoteJidAlt?: string }).remoteJidAlt;
  const pnJid = isPnUser(jid) ? jid : alt && isPnUser(alt) ? alt : null;
  const chatJid = jidNormalizedUser(pnJid ?? jid);
  const digits = pnJid ? jidNormalizedUser(pnJid).split('@')[0]! : null;

  const base = {
    id: m.key.id,
    chatJid,
    phoneE164: digits ? `+${digits}` : null,
    fromMe: !!m.key.fromMe,
    timestamp: new Date(toMillis(m.messageTimestamp)),
    pushName: m.pushName ?? null,
  };

  switch (kind) {
    case 'conversation':
      return { ...base, type: 'text', text: content.conversation ?? '' };
    case 'extendedTextMessage':
      return { ...base, type: 'text', text: content.extendedTextMessage?.text ?? '' };
    case 'imageMessage':
      return {
        ...base,
        type: 'image',
        text: content.imageMessage?.caption ?? null,
        mimetype: content.imageMessage?.mimetype ?? 'image/jpeg',
      };
    case 'videoMessage':
      return { ...base, type: 'video', text: content.videoMessage?.caption ?? null };
    case 'audioMessage':
      return { ...base, type: 'audio', text: null };
    case 'documentMessage':
      return {
        ...base,
        type: 'document',
        text: content.documentMessage?.caption ?? null,
        fileName: content.documentMessage?.fileName ?? undefined,
      };
    case 'stickerMessage':
      return { ...base, type: 'sticker', text: null };
    case 'locationMessage':
      return { ...base, type: 'location', text: content.locationMessage?.name ?? null };
    case 'contactMessage':
      return { ...base, type: 'contact', text: content.contactMessage?.displayName ?? null };
    default:
      return { ...base, type: 'other', text: null };
  }
}
