import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@multizap/database';
import {
  MAX_MESSAGE_LENGTH,
  type AiConversationDTO,
  type AiConversationState,
  type AiKnowledgeUsedDTO,
  type AiDraftDTO,
  type AiUsageSummaryDTO,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';
import { convInclude, replyPermissionFor } from '../inbox/routes';

const uuid = z.string().uuid('Identificador inválido.');
const idParams = z.object({ id: uuid });
const actor = (req: FastifyRequest) => req.auth!.user;

/**
 * Atendimento real do MultiZap AI: ativar/pausar agentes, revisar respostas, controlar a IA
 * por conversa e acompanhar o consumo. As respostas em si são geradas pelo worker.
 */
export async function aiServiceRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  const event = (
    agentId: string,
    category: 'AGENT' | 'OPENROUTER',
    level: string,
    message: string,
  ) =>
    prisma.aiAgentEvent
      .create({ data: { agentId, category, level, message: message.slice(0, 500) } })
      .catch(() => undefined);

  // ─── Ativar e pausar ───

  app.post('/ai/agents/:id/activate', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const agent = await prisma.aiAgent.findUnique({
      where: { id },
      include: { accounts: { include: { account: { select: { id: true, name: true } } } } },
    });
    if (!agent) throw Errors.notFound('Agente não encontrado.');
    if (!agent.publishedVersionId)
      throw new AppError(409, 'NOT_PUBLISHED', 'Publique uma versão antes de ativar o agente.');
    if (!agent.accounts.length)
      throw new AppError(
        409,
        'NO_ACCOUNTS',
        'Escolha ao menos uma instância para o agente atender.',
      );
    if (!(await prisma.aiCredential.findUnique({ where: { provider: 'openrouter' } })))
      throw new AppError(
        409,
        'AI_NOT_CONFIGURED',
        'Configure a chave da OpenRouter em MultiZap AI → Configurações.',
      );
    const conflicts = await prisma.aiAgentAccount.findMany({
      where: {
        accountId: { in: agent.accounts.map((a) => a.accountId) },
        agentId: { not: id },
        agent: { status: 'ACTIVE' },
      },
      include: { account: { select: { name: true } }, agent: { select: { name: true } } },
    });
    if (conflicts.length)
      throw new AppError(
        409,
        'ACCOUNT_HAS_ACTIVE_AGENT',
        conflicts.map((c) => `${c.account.name} já é atendida por "${c.agent.name}"`).join('; ') +
          '.',
      );
    const updated = await prisma.aiAgent.update({ where: { id }, data: { status: 'ACTIVE' } });
    await event(id, 'AGENT', 'info', 'Agente ativado.');
    await audit(prisma, req, {
      action: 'ai.agent_activated',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: id,
    });
    return { status: updated.status };
  });

  app.post('/ai/agents/:id/pause', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const agent = await prisma.aiAgent.findUnique({ where: { id }, select: { status: true } });
    if (!agent) throw Errors.notFound('Agente não encontrado.');
    if (agent.status !== 'ACTIVE')
      throw new AppError(409, 'NOT_ACTIVE', 'O agente não está ativo.');
    await prisma.aiAgent.update({ where: { id }, data: { status: 'PAUSED' } });
    await event(id, 'AGENT', 'info', 'Agente pausado pelo administrador.');
    await audit(prisma, req, {
      action: 'ai.agent_paused',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: id,
    });
    return { status: 'PAUSED' as const };
  });

  // ─── Rascunhos (modo revisão humana) ───

  const draftInclude = {
    agent: { select: { name: true } },
  } satisfies Prisma.AiDraftInclude;

  const toDraftDTO = (
    d: Prisma.AiDraftGetPayload<{ include: typeof draftInclude }>,
    inboundText: string | null,
  ): AiDraftDTO => ({
    id: d.id,
    conversationId: d.conversationId,
    agentId: d.agentId,
    agentName: d.agent.name,
    body: d.sentBody ?? d.body,
    status: d.status,
    autoSent: d.autoSent,
    sources: Array.isArray(d.sources) ? (d.sources as unknown as AiKnowledgeUsedDTO[]) : [],
    inboundText,
    createdAt: d.createdAt.toISOString(),
    decidedAt: d.decidedAt?.toISOString() ?? null,
  });

  const withInbound = async (
    rows: Prisma.AiDraftGetPayload<{ include: typeof draftInclude }>[],
  ) => {
    const msgs = await prisma.message.findMany({
      where: { id: { in: rows.map((r) => r.inboundMessageId) } },
      select: { id: true, body: true },
    });
    const byId = new Map(msgs.map((m) => [m.id, m.body]));
    return rows.map((r) => toDraftDTO(r, byId.get(r.inboundMessageId) ?? null));
  };

  app.get('/ai/drafts', auth, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['PENDING', 'SENT', 'DISCARDED', 'FAILED']).default('PENDING'),
        conversationId: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const rows = await prisma.aiDraft.findMany({
      where: { status: q.status, ...(q.conversationId && { conversationId: q.conversationId }) },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      include: draftInclude,
    });
    return { items: await withInbound(rows) };
  });

  app.post('/ai/drafts/:id/approve', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { text } = parse(
      z.object({
        text: z
          .string()
          .trim()
          .min(1, 'Escreva a mensagem.')
          .max(MAX_MESSAGE_LENGTH, `Máximo de ${MAX_MESSAGE_LENGTH} caracteres.`)
          .optional(),
      }),
      req.body ?? {},
    );
    const draft = await prisma.aiDraft.findUnique({ where: { id } });
    if (!draft) throw Errors.notFound('Rascunho não encontrado.');
    if (draft.status !== 'PENDING')
      throw new AppError(409, 'DRAFT_DECIDED', 'Este rascunho já foi enviado ou descartado.');
    const conv = await prisma.conversation.findUnique({
      where: { id: draft.conversationId },
      include: convInclude,
    });
    if (!conv) throw Errors.notFound('Conversa não encontrada.');
    const permission = await replyPermissionFor(prisma, conv);
    if (!permission.allowed) throw new AppError(409, 'REPLY_NOT_ALLOWED', permission.reason!);
    if (!app.gateway || !(await app.gateway.isAlive()))
      throw new AppError(
        503,
        'GATEWAY_UNAVAILABLE',
        'O serviço de conexões está indisponível no momento.',
      );
    const body = text ?? draft.body;
    // Reserva atômica: dois cliques não enviam duas vezes.
    const claimed = await prisma.aiDraft.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'SENT', sentBody: body, decidedAt: new Date() },
    });
    if (claimed.count !== 1)
      throw new AppError(409, 'DRAFT_DECIDED', 'Este rascunho já foi enviado ou descartado.');
    const m = await prisma.message.create({
      data: {
        accountId: conv.accountId,
        conversationId: conv.id,
        providerMessageId: `pending:${randomUUID()}`,
        direction: 'OUTBOUND',
        type: 'text',
        body,
        status: 'PENDING',
        sentAt: new Date(),
        aiLink: { create: { agentId: draft.agentId, source: 'review' } },
      },
    });
    await prisma.aiDraft.update({ where: { id }, data: { messageId: m.id } });
    await prisma.aiConversationState.upsert({
      where: { conversationId: conv.id },
      create: { conversationId: conv.id, lastReplyAt: m.sentAt },
      update: { lastReplyAt: m.sentAt, lastSkip: null, lastSkipAt: null },
    });
    await prisma.conversation.update({ where: { id: conv.id }, data: { unreadCount: 0 } });
    await app.gateway.send({ type: 'send-reply', accountId: conv.accountId, messageId: m.id });
    await audit(prisma, req, {
      action: 'ai.draft_approved',
      actorId: actor(req).id,
      entityType: 'ai_draft',
      entityId: id,
      accountId: conv.accountId,
      details: { edited: body !== draft.body },
    });
    reply.code(202);
    return { messageId: m.id };
  });

  app.post('/ai/drafts/:id/discard', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const draft = await prisma.aiDraft.findUnique({
      where: { id },
      include: { conversation: { select: { accountId: true } } },
    });
    if (!draft) throw Errors.notFound('Rascunho não encontrado.');
    const r = await prisma.aiDraft.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'DISCARDED', decidedAt: new Date() },
    });
    if (r.count !== 1)
      throw new AppError(409, 'DRAFT_DECIDED', 'Este rascunho já foi enviado ou descartado.');
    await audit(prisma, req, {
      action: 'ai.draft_discarded',
      actorId: actor(req).id,
      entityType: 'ai_draft',
      entityId: id,
      accountId: draft.conversation.accountId,
    });
    return { ok: true };
  });

  // ─── Conversas atendidas ───

  const stateOf = (
    pending: number,
    st: { paused: boolean; pausedReason: string | null; lastSkip: string | null } | null,
  ): { state: AiConversationState; reason: string | null } => {
    if (pending > 0) return { state: 'review', reason: null };
    if (st?.paused) return { state: 'paused', reason: st.pausedReason };
    if (st?.lastSkip) return { state: 'blocked', reason: st.lastSkip };
    return { state: 'serving', reason: null };
  };

  app.get('/ai/conversations', auth, async (req) => {
    const q = parse(
      z.object({
        accountId: uuid.optional(),
        filter: z.enum(['all', 'review', 'paused', 'blocked', 'serving']).default('all'),
        limit: z.coerce.number().int().min(1).max(100).default(60),
      }),
      req.query,
    );
    const rows = await prisma.conversation.findMany({
      where: {
        lastMessageAt: { not: null },
        ...(q.accountId && { accountId: q.accountId }),
        OR: [
          { aiState: { isNot: null } },
          { aiDrafts: { some: {} } },
          { account: { aiAgentLinks: { some: { agent: { status: 'ACTIVE' } } } } },
        ],
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 200,
      include: {
        account: {
          select: {
            name: true,
            aiAgentLinks: {
              where: { agent: { status: 'ACTIVE' } },
              select: { agent: { select: { name: true } } },
            },
          },
        },
        contact: { select: { name: true, phoneE164: true } },
        aiState: true,
        _count: { select: { aiDrafts: { where: { status: 'PENDING' } } } },
      },
    });
    const items: AiConversationDTO[] = rows
      .map((c) => {
        const pending = c._count.aiDrafts;
        const { state, reason } = stateOf(pending, c.aiState);
        return {
          id: c.id,
          accountId: c.accountId,
          accountName: c.account.name,
          title: c.contact?.name ?? c.title,
          phoneE164: c.contact?.phoneE164 ?? c.phoneE164,
          photoUrl: c.photoKey ? `/api/conversations/${c.id}/photo` : null,
          lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
          lastMessagePreview: c.lastMessagePreview,
          state,
          reason,
          pausedBy: c.aiState?.paused ? c.aiState.pausedBy : null,
          enabledOverride: c.aiState?.enabledOverride ?? false,
          contextResetAt: c.aiState?.contextResetAt?.toISOString() ?? null,
          pendingDrafts: pending,
          agentName: c.account.aiAgentLinks[0]?.agent.name ?? null,
        };
      })
      .filter((c) => q.filter === 'all' || c.state === q.filter)
      .slice(0, q.limit);
    return { items };
  });

  /** Pausar/retomar a IA em uma conversa e liberar o atendimento após campanha. */
  app.put('/ai/conversations/:id/state', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z
        .object({
          paused: z.boolean().optional(),
          enabled: z.boolean().optional(),
          /** Recomeçar do zero: a IA ignora o que veio antes (histórico, memória, respostas humanas). */
          resetContext: z.literal(true).optional(),
        })
        .refine(
          (b) => b.paused !== undefined || b.enabled !== undefined || b.resetContext,
          'Nada para alterar.',
        ),
      req.body,
    );
    const conv = await prisma.conversation.findUnique({
      where: { id },
      select: { accountId: true },
    });
    if (!conv) throw Errors.notFound('Conversa não encontrada.');
    const at = new Date();
    const data: Prisma.AiConversationStateUpdateInput = {};
    if (body.paused === true)
      Object.assign(data, {
        paused: true,
        pausedBy: 'admin',
        pausedReason: 'IA pausada pelo administrador',
        pausedAt: at,
      });
    if (body.paused === false)
      Object.assign(data, {
        paused: false,
        pausedBy: null,
        pausedReason: null,
        pausedAt: null,
        lastSkip: null,
        lastSkipAt: null,
      });
    if (body.resetContext)
      // Recomeço: ponto de corte agora, memória apagada e a IA volta a atender a conversa.
      Object.assign(data, {
        contextResetAt: at,
        memory: null,
        memoryAgentId: null,
        memoryUpdatedAt: null,
        paused: false,
        pausedBy: null,
        pausedReason: null,
        pausedAt: null,
        lastSkip: null,
        lastSkipAt: null,
      });
    if (body.enabled !== undefined) {
      data.enabledOverride = body.enabled;
      if (body.enabled) Object.assign(data, { lastSkip: null, lastSkipAt: null });
    }
    await prisma.aiConversationState.upsert({
      where: { conversationId: id },
      create: {
        ...(data as Prisma.AiConversationStateCreateWithoutConversationInput),
        conversation: { connect: { id } },
      },
      update: data,
    });
    await audit(prisma, req, {
      action: body.resetContext
        ? 'ai.conversation_context_reset'
        : body.paused === true
          ? 'ai.conversation_paused'
          : 'ai.conversation_resumed',
      actorId: actor(req).id,
      entityType: 'conversation',
      entityId: id,
      accountId: conv.accountId,
      details: body,
    });
    return { ok: true };
  });

  // ─── Consumo ───

  app.get('/ai/usage', auth, async (req) => {
    const q = parse(
      z.object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        agentId: uuid.optional(),
        accountId: uuid.optional(),
      }),
      req.query,
    );
    const since = new Date(Date.now() - q.days * 24 * 3_600_000);
    const rows = await prisma.aiTokenUsage.findMany({
      where: {
        createdAt: { gte: since },
        ...(q.agentId && { agentId: q.agentId }),
        ...(q.accountId && { accountId: q.accountId }),
      },
      select: {
        context: true,
        purpose: true,
        promptTokens: true,
        completionTokens: true,
        costUsd: true,
      },
    });
    const sum = (ctx: 'LIVE' | 'TEST') => {
      const r = rows.filter((x) => x.context === ctx);
      const priced = r.filter((x) => x.costUsd !== null);
      return {
        n: r.length,
        replies: r.filter((x) => x.purpose !== 'memory').length,
        promptTokens: r.reduce((a, x) => a + x.promptTokens, 0),
        completionTokens: r.reduce((a, x) => a + x.completionTokens, 0),
        costUsd: priced.length ? priced.reduce((a, x) => a + Number(x.costUsd), 0) : null,
      };
    };
    const live = sum('LIVE');
    const test = sum('TEST');
    const dto: AiUsageSummaryDTO = {
      days: q.days,
      live: {
        replies: live.replies,
        promptTokens: live.promptTokens,
        completionTokens: live.completionTokens,
        costUsd: live.costUsd,
      },
      test: {
        calls: test.n,
        promptTokens: test.promptTokens,
        completionTokens: test.completionTokens,
        costUsd: test.costUsd,
      },
    };
    return dto;
  });
}
