import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@multizap/database';
import { isOperationsPaused } from '@multizap/database';
import {
  CONVERSATION_FILTERS,
  MAX_MESSAGE_LENGTH,
  type ConversationDTO,
  type MessageDTO,
  type ReplyPermission,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';
import { contactInclude, toContactDTO } from '../contacts/dto';

const idParams = z.object({ id: z.string().uuid('Conversa inválida.') });

const convInclude = {
  account: {
    select: { id: true, name: true, status: true, connectionType: true, disabledAt: true },
  },
  contact: { select: { id: true, name: true, phoneE164: true, optedOutAt: true } },
} satisfies Prisma.ConversationInclude;
type ConvRow = Prisma.ConversationGetPayload<{ include: typeof convInclude }>;

function phoneOf(c: ConvRow): string | null {
  if (c.contact?.phoneE164) return c.contact.phoneE164;
  const [user, server] = c.remoteJid.split('@');
  return server === 's.whatsapp.net' && user ? `+${user}` : null;
}

function toConversationDTO(c: ConvRow): ConversationDTO {
  return {
    id: c.id,
    accountId: c.accountId,
    accountName: c.account.name,
    contactId: c.contactId,
    contactName: c.contact?.name ?? null,
    phoneE164: phoneOf(c),
    title: c.title,
    status: c.status,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: c.lastMessagePreview,
  };
}

export async function inboxRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  const load = async (id: string) => {
    const c = await prisma.conversation.findUnique({ where: { id }, include: convInclude });
    if (!c) throw Errors.notFound('Conversa não encontrada.');
    return c;
  };

  /** Quando é permitido responder pela Central (regras do canal e de consentimento). */
  const replyPermission = async (c: ConvRow): Promise<ReplyPermission> => {
    if (c.account.connectionType !== 'WHATSAPP_WEB')
      return { allowed: false, reason: 'Aparelho apenas cadastrado: responda pelo celular.' };
    if (c.account.disabledAt) return { allowed: false, reason: 'A instância está desativada.' };
    if (c.account.status !== 'CONNECTED')
      return { allowed: false, reason: 'A instância não está conectada.' };
    if (await isOperationsPaused(prisma))
      return { allowed: false, reason: 'As operações estão pausadas globalmente.' };
    if (c.contact?.optedOutAt) {
      // Descadastrado só volta a receber resposta se escrever novamente depois do pedido.
      const after = await prisma.message.count({
        where: { conversationId: c.id, direction: 'INBOUND', sentAt: { gt: c.contact.optedOutAt } },
      });
      if (!after)
        return {
          allowed: false,
          reason:
            'O contato pediu descadastramento. Só é possível responder se ele escrever novamente.',
        };
    }
    return { allowed: true, reason: null };
  };

  app.get('/conversations', auth, async (req) => {
    const q = parse(
      z.object({
        accountId: z.string().uuid().optional(),
        filter: z.enum(CONVERSATION_FILTERS).default('all'),
        q: z.string().trim().max(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(40),
      }),
      req.query,
    );
    const where: Prisma.ConversationWhereInput = {
      ...(q.accountId && { accountId: q.accountId }),
      ...(q.filter === 'unread' && { unreadCount: { gt: 0 } }),
      ...(q.filter === 'pending' && { status: 'PENDING' }),
      ...(q.filter === 'answered' && { status: 'ANSWERED' }),
      ...(q.filter === 'closed' && { status: 'CLOSED' }),
      ...(q.filter !== 'closed' && q.filter !== 'all' && { NOT: { status: 'CLOSED' } }),
    };
    if (q.q) {
      const digits = q.q.replace(/\D/g, '');
      where.OR = [
        { title: { contains: q.q, mode: 'insensitive' } },
        { contact: { name: { contains: q.q, mode: 'insensitive' } } },
        ...(digits.length >= 3
          ? [{ remoteJid: { contains: digits } }, { contact: { phoneE164: { contains: digits } } }]
          : []),
      ];
    }
    const [rows, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: convInclude,
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.conversation.count({ where }),
    ]);
    return { items: rows.map(toConversationDTO), total };
  });

  app.get('/conversations/unread', auth, async () => ({
    conversations: await prisma.conversation.count({ where: { unreadCount: { gt: 0 } } }),
  }));

  app.get('/conversations/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const c = await load(id);
    const contact = c.contactId
      ? await prisma.contact.findUnique({ where: { id: c.contactId }, include: contactInclude })
      : null;
    return {
      conversation: toConversationDTO(c),
      contact: contact ? toContactDTO(contact) : null,
      reply: await replyPermission(c),
    };
  });

  app.get('/conversations/:id/messages', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { before, limit } = parse(
      z.object({
        before: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    await load(id);
    const rows = await prisma.message.findMany({
      where: { conversationId: id, ...(before && { sentAt: { lt: before } }) },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items: MessageDTO[] = rows
      .slice(0, limit)
      .reverse()
      .map((m) => ({
        id: m.id,
        direction: m.direction,
        type: m.type,
        body: m.body,
        status: m.status,
        hasMedia: !!m.mediaKey,
        fromCampaign: !!m.campaignRecipientId,
        sentAt: m.sentAt.toISOString(),
      }));
    return { items, hasMore };
  });

  app.post('/conversations/:id/read', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    await prisma.conversation.update({ where: { id }, data: { unreadCount: 0 } }).catch(() => {
      throw Errors.notFound('Conversa não encontrada.');
    });
    return { ok: true };
  });

  app.post('/conversations/:id/status', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { status } = parse(z.object({ status: z.enum(['CLOSED', 'OPEN']) }), req.body);
    const c = await load(id);
    const updated = await prisma.conversation.update({
      where: { id: c.id },
      data: { status, ...(status === 'CLOSED' && { unreadCount: 0 }) },
      include: convInclude,
    });
    await audit(prisma, req, {
      action: status === 'CLOSED' ? 'conversation.closed' : 'conversation.reopened',
      actorId: req.auth!.user.id,
      entityType: 'conversation',
      entityId: id,
      accountId: c.accountId,
    });
    return { conversation: toConversationDTO(updated) };
  });

  /** Resposta escrita pelo administrador (envio individual). */
  app.post('/conversations/:id/messages', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { text } = parse(
      z.object({
        text: z
          .string()
          .trim()
          .min(1, 'Escreva a mensagem.')
          .max(MAX_MESSAGE_LENGTH, `Máximo de ${MAX_MESSAGE_LENGTH} caracteres.`),
      }),
      req.body,
    );
    const c = await load(id);
    const permission = await replyPermission(c);
    if (!permission.allowed) throw new AppError(409, 'REPLY_NOT_ALLOWED', permission.reason!);
    if (!app.gateway || !(await app.gateway.isAlive())) {
      throw new AppError(
        503,
        'GATEWAY_UNAVAILABLE',
        'O serviço de conexões está indisponível no momento.',
      );
    }
    const m = await prisma.message.create({
      data: {
        accountId: c.accountId,
        conversationId: c.id,
        providerMessageId: `pending:${randomUUID()}`,
        direction: 'OUTBOUND',
        type: 'text',
        body: text,
        status: 'PENDING',
        sentAt: new Date(),
      },
    });
    await prisma.conversation.update({ where: { id: c.id }, data: { unreadCount: 0 } });
    await app.gateway.send({ type: 'send-reply', accountId: c.accountId, messageId: m.id });
    await audit(prisma, req, {
      action: 'conversation.replied',
      actorId: req.auth!.user.id,
      entityType: 'message',
      entityId: m.id,
      accountId: c.accountId,
    });
    reply.code(202);
    const dto: MessageDTO = {
      id: m.id,
      direction: 'OUTBOUND',
      type: 'text',
      body: text,
      status: 'PENDING',
      hasMedia: false,
      fromCampaign: false,
      sentAt: m.sentAt.toISOString(),
    };
    return { message: dto };
  });

  app.get('/messages/:id/media', auth, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const m = await prisma.message.findUnique({ where: { id } });
    if (!m?.mediaKey) throw Errors.notFound('Mídia não disponível.');
    if (!app.storage) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Armazenamento indisponível.');
    reply
      .header(
        'content-type',
        m.mediaKey.endsWith('.webp')
          ? 'image/webp'
          : m.mediaKey.endsWith('.png')
            ? 'image/png'
            : 'image/jpeg',
      )
      .header('cache-control', 'private, max-age=86400')
      .header('content-security-policy', "default-src 'none'; sandbox");
    return reply.send(await app.storage.get(m.mediaKey));
  });
}
