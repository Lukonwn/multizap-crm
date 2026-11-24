import {
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  normalizeMessageContent,
  type proto,
  type WAMessage,
} from 'baileys';
import { PENDING_CONTENT_TEXT, type IncomingMessage } from '../session/types';

const IGNORED = new Set([
  'protocolMessage',
  'reactionMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'pollUpdateMessage',
  'keepInChatMessage',
  'encReactionMessage',
]);

const joinLines = (parts: (string | null | undefined)[]) =>
  parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join('\n');

const buttonsLine = (labels: (string | null | undefined)[]) => {
  const l = labels.map((x) => x?.trim()).filter((x): x is string => !!x);
  return l.length ? `Botões: ${l.join(' · ')}` : null;
};

/** Texto de botões "nativos" (interactiveMessage): o rótulo vem em JSON. */
function nativeFlowLabels(i: proto.Message.IInteractiveMessage): string[] {
  return (i.nativeFlowMessage?.buttons ?? []).flatMap((b) => {
    try {
      const j = JSON.parse(b.buttonParamsJson ?? '{}') as { display_text?: string };
      return j.display_text ? [j.display_text] : [];
    } catch {
      return [];
    }
  });
}

function interactiveText(i: proto.Message.IInteractiveMessage): string {
  return joinLines([
    i.header?.title,
    i.header?.subtitle,
    i.body?.text,
    i.footer?.text,
    buttonsLine(nativeFlowLabels(i)),
  ]);
}

function hydratedText(h: proto.Message.TemplateMessage.IHydratedFourRowTemplate): string {
  return joinLines([
    h.hydratedTitleText,
    h.hydratedContentText,
    h.hydratedFooterText,
    buttonsLine(
      (h.hydratedButtons ?? []).map(
        (b) =>
          b.quickReplyButton?.displayText ?? b.urlButton?.displayText ?? b.callButton?.displayText,
      ),
    ),
  ]);
}

/** Conteúdo de mensagens de empresa (modelos, botões e listas), quando há texto. */
function richText(content: proto.IMessage, kind: string): string | null {
  let text = '';
  if (kind === 'templateMessage') {
    const t = content.templateMessage;
    const h = t?.hydratedTemplate ?? t?.hydratedFourRowTemplate;
    if (h) text = hydratedText(h);
    else if (t?.interactiveMessageTemplate) text = interactiveText(t.interactiveMessageTemplate);
  } else if (kind === 'interactiveMessage' && content.interactiveMessage) {
    text = interactiveText(content.interactiveMessage);
  } else if (kind === 'buttonsMessage' && content.buttonsMessage) {
    const b = content.buttonsMessage;
    text = joinLines([
      b.text,
      b.contentText,
      b.footerText,
      buttonsLine((b.buttons ?? []).map((x) => x.buttonText?.displayText)),
    ]);
  } else if (kind === 'listMessage' && content.listMessage) {
    const l = content.listMessage;
    text = joinLines([
      l.title,
      l.description,
      l.footerText,
      l.buttonText ? `Lista: ${l.buttonText}` : null,
    ]);
  }
  return text || null;
}

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
      return {
        ...base,
        type: 'audio',
        text: null,
        mimetype: content.audioMessage?.mimetype ?? 'audio/ogg',
        ...(content.audioMessage?.seconds != null && { seconds: content.audioMessage.seconds }),
      };
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
    case 'templateMessage':
    case 'interactiveMessage':
    case 'buttonsMessage':
    case 'listMessage': {
      const text = richText(content, kind);
      return text
        ? { ...base, type: 'text', text }
        : { ...base, type: 'other', text: `(${kind})`, kind };
    }
    // O WhatsApp entregou a mensagem sem o conteúdo e o celular reenvia depois (mesmo ID).
    case 'placeholderMessage':
      return { ...base, type: 'other', text: PENDING_CONTENT_TEXT, kind, pending: true };
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
