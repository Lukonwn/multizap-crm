import {
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
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

function pollName(content: NonNullable<ReturnType<typeof normalizeMessageContent>>): string {
  const c = content as Record<string, { name?: string } | undefined>;
  return (
    c.pollCreationMessage?.name ??
    c.pollCreationMessageV2?.name ??
    c.pollCreationMessageV3?.name ??
    ''
  );
}

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
export function normalizeMessage(m: WAMessage, resolvedPn?: string | null): IncomingMessage | null {
  const jid = m.key?.remoteJid;
  if (!jid || !m.key.id) return null;
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return null;

  const content = normalizeMessageContent(m.message);
  if (!content) return null;
  const kind = getContentType(content);
  if (!kind || IGNORED.has(kind)) return null;

  // Endereçamento por LID: usa o número de telefone alternativo quando disponível.
  // Ordem: telefone na própria conversa → telefone alternativo da mensagem → correspondência conhecida.
  const alt = (m.key as { remoteJidAlt?: string }).remoteJidAlt;
  const pnJid = isPnUser(jid)
    ? jid
    : alt && isPnUser(alt)
      ? alt
      : resolvedPn && isPnUser(resolvedPn)
        ? resolvedPn
        : null;
  const chatJid = jidNormalizedUser(pnJid ?? jid);
  const lidJid = isLidUser(jid) && pnJid ? jidNormalizedUser(jid) : undefined;
  const digits = pnJid ? jidNormalizedUser(pnJid).split('@')[0]! : null;

  const base = {
    id: m.key.id,
    chatJid,
    ...(lidJid && { lidJid }),
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
    case 'ptvMessage':
      return { ...base, type: 'video', text: null };
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
    case 'liveLocationMessage':
      return { ...base, type: 'location', text: content.liveLocationMessage?.caption ?? null };
    case 'contactMessage':
      return { ...base, type: 'contact', text: content.contactMessage?.displayName ?? null };
    case 'contactsArrayMessage':
      return { ...base, type: 'contact', text: content.contactsArrayMessage?.displayName ?? null };
    // Respostas a botões e listas: o texto escolhido pelo contato.
    case 'buttonsResponseMessage':
      return {
        ...base,
        type: 'text',
        text: content.buttonsResponseMessage?.selectedDisplayText ?? null,
      };
    case 'listResponseMessage':
      return { ...base, type: 'text', text: content.listResponseMessage?.title ?? null };
    case 'templateButtonReplyMessage':
      return {
        ...base,
        type: 'text',
        text: content.templateButtonReplyMessage?.selectedDisplayText ?? null,
      };
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { ...base, type: 'other', text: `Enquete: ${pollName(content)}`, kind };
    case 'albumMessage':
      return { ...base, type: 'other', text: 'Álbum de fotos e vídeos', kind };
    case 'eventMessage':
      return {
        ...base,
        type: 'other',
        text: `Evento: ${content.eventMessage?.name ?? ''}`.trim(),
        kind,
      };
    default:
      // Tipo ainda não tratado: mostra o nome técnico para facilitar o diagnóstico.
      return { ...base, type: 'other', text: `(${kind})`, kind };
  }
}
