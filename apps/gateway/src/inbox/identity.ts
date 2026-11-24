import type { PrismaClient } from '@multizap/database';
import type { IdentityUpdate } from '../session/types';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

const PN_RE = /^(\d{5,20})(?::\d+)?@s\.whatsapp\.net$/;
const LID_RE = /^(\d+)(?::\d+)?@lid$/;

/** "5511999990000:3@s.whatsapp.net" → "5511999990000@s.whatsapp.net" (sem sufixo de aparelho). */
export function cleanJid(jid: string): string {
  const [user, server] = jid.split('@');
  return `${user!.split(':')[0]}@${server}`;
}
export const isPnJid = (jid: string) => PN_RE.test(jid);
export const isLidJid = (jid: string) => LID_RE.test(jid);
export function phoneOfJid(jid: string | undefined | null): string | null {
  const m = jid ? PN_RE.exec(jid) : null;
  return m ? `+${m[1]}` : null;
}

const clip = (v: string | undefined | null, n = 120) => {
  const t = v?.trim();
  return t ? t.slice(0, n) : null;
};

/**
 * Diretório de identidades do aparelho conectado.
 *
 * Guarda o que o WhatsApp entrega à sessão: nome salvo na agenda do celular,
 * nome de perfil e a correspondência LID ↔ telefone. Isso só enriquece a
 * Central de Mensagens: NÃO cria contatos do CRM nem consulta números.
 * Conversas por LID passam a mostrar o telefone e o nome assim que forem conhecidos,
 * e são unidas à conversa do telefone quando as duas existirem.
 */
export class IdentityService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: Log = () => undefined,
  ) {}

  /** Telefone e nome conhecidos para um JID de conversa (por LID ou por telefone). */
  async lookup(
    accountId: string,
    jid: string,
  ): Promise<{ phoneJid: string | null; phoneE164: string | null; name: string | null } | null> {
    const key = cleanJid(jid);
    const row = await this.prisma.waIdentity.findFirst({
      where: {
        accountId,
        OR: [
          { jid: key },
          ...(isLidJid(key) ? [{ lid: key }] : [{ phoneE164: phoneOfJid(key) ?? '-' }]),
        ],
      },
    });
    if (!row) return null;
    return {
      phoneJid: row.phoneE164 ? `${row.phoneE164.slice(1)}@s.whatsapp.net` : null,
      phoneE164: row.phoneE164,
      name: row.savedName ?? row.verifiedName ?? row.pushName,
    };
  }

  async apply(accountId: string, items: IdentityUpdate[]): Promise<number> {
    let changed = 0;
    for (const item of items) {
      try {
        if (await this.applyOne(accountId, item)) changed++;
      } catch (err) {
        this.log('Falha ao registrar identidade', { accountId, err: String(err) });
      }
    }
    return changed;
  }

  private async applyOne(accountId: string, it: IdentityUpdate): Promise<boolean> {
    const id = it.id ? cleanJid(it.id) : undefined;
    const lid = it.lid ? cleanJid(it.lid) : id && isLidJid(id) ? id : undefined;
    const phoneJid = it.phoneJid ? cleanJid(it.phoneJid) : id && isPnJid(id) ? id : undefined;
    const phone = phoneOfJid(phoneJid);
    const savedName = clip(it.savedName);
    const pushName = clip(it.pushName);
    const verifiedName = clip(it.verifiedName);
    const key = phoneJid ?? lid ?? id;
    if (!key) return false;
    // Nada de útil (só uma foto, por exemplo): ignora.
    if (!savedName && !pushName && !verifiedName && !(lid && phone)) return false;

    const existing = await this.prisma.waIdentity.findFirst({
      where: {
        accountId,
        OR: [
          { jid: key },
          ...(lid ? [{ lid }, { jid: lid }] : []),
          ...(phone ? [{ phoneE164: phone }] : []),
        ],
      },
    });
    const data = {
      jid: existing && !phone ? existing.jid : key,
      lid: lid ?? existing?.lid ?? null,
      phoneE164: phone ?? existing?.phoneE164 ?? null,
      savedName: savedName ?? existing?.savedName ?? null,
      pushName: pushName ?? existing?.pushName ?? null,
      verifiedName: verifiedName ?? existing?.verifiedName ?? null,
    };
    const same =
      existing &&
      existing.jid === data.jid &&
      existing.lid === data.lid &&
      existing.phoneE164 === data.phoneE164 &&
      existing.savedName === data.savedName &&
      existing.pushName === data.pushName &&
      existing.verifiedName === data.verifiedName;
    if (same) return false;

    const saved = existing
      ? await this.prisma.waIdentity.update({ where: { id: existing.id }, data })
      : await this.prisma.waIdentity.create({ data: { accountId, ...data } });
    await this.refreshConversations(accountId, saved);
    return true;
  }

  /** Aplica nome e telefone às conversas da pessoa e une a conversa por LID à do telefone. */
  private async refreshConversations(
    accountId: string,
    ident: {
      jid: string;
      lid: string | null;
      phoneE164: string | null;
      savedName: string | null;
      pushName: string | null;
      verifiedName: string | null;
    },
  ) {
    const phoneJid = ident.phoneE164 ? `${ident.phoneE164.slice(1)}@s.whatsapp.net` : null;
    const jids = [ident.jid, ident.lid, phoneJid].filter((j): j is string => !!j);
    const convs = await this.prisma.conversation.findMany({
      where: { accountId, remoteJid: { in: jids } },
    });
    if (!convs.length) return;

    const name = ident.savedName ?? ident.verifiedName ?? ident.pushName;
    const contact = ident.phoneE164
      ? await this.prisma.contact.findUnique({
          where: { accountId_phoneE164: { accountId, phoneE164: ident.phoneE164 } },
          select: { id: true },
        })
      : null;

    // 1) Une a conversa por LID à conversa do telefone (se ambas existirem) ou migra o endereço.
    const lidConv = ident.lid ? convs.find((c) => c.remoteJid === ident.lid) : undefined;
    const pnConv = phoneJid ? convs.find((c) => c.remoteJid === phoneJid) : undefined;
    if (lidConv && phoneJid) {
      if (pnConv) await this.merge(lidConv.id, pnConv.id);
      else
        await this.prisma.conversation.update({
          where: { id: lidConv.id },
          data: { remoteJid: phoneJid },
        });
    }

    // 2) Nome, telefone e contato do CRM (somente vincula; nunca cria).
    const targets = await this.prisma.conversation.findMany({
      where: { accountId, remoteJid: { in: jids } },
    });
    for (const c of targets) {
      await this.prisma.conversation.update({
        where: { id: c.id },
        data: {
          ...(name && c.title !== name && { title: name }),
          ...(ident.phoneE164 && c.phoneE164 !== ident.phoneE164 && { phoneE164: ident.phoneE164 }),
          ...(contact && !c.contactId && { contactId: contact.id }),
        },
      });
    }
  }

  /** Move as mensagens da conversa `fromId` para `intoId` e remove a conversa vazia. */
  private async merge(fromId: string, intoId: string) {
    await this.prisma.$transaction(async (tx) => {
      const [from, into] = await Promise.all([
        tx.conversation.findUniqueOrThrow({ where: { id: fromId } }),
        tx.conversation.findUniqueOrThrow({ where: { id: intoId } }),
      ]);
      await tx.message.updateMany({
        where: { conversationId: fromId },
        data: { conversationId: intoId },
      });
      const fromNewer =
        !!from.lastMessageAt && (!into.lastMessageAt || from.lastMessageAt > into.lastMessageAt);
      const unread = from.unreadCount + into.unreadCount;
      await tx.conversation.update({
        where: { id: intoId },
        data: {
          unreadCount: unread,
          lastMessageAt: fromNewer ? from.lastMessageAt : into.lastMessageAt,
          lastMessagePreview: fromNewer ? from.lastMessagePreview : into.lastMessagePreview,
          contactId: into.contactId ?? from.contactId,
          title: into.title ?? from.title,
          photoKey: into.photoKey ?? from.photoKey,
          ...(unread > 0 && { status: 'PENDING' as const }),
        },
      });
      await tx.conversation.delete({ where: { id: fromId } });
    });
    this.log('Conversas unidas (LID e telefone)', { fromId, intoId });
  }
}
