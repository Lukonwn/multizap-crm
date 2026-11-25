import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@multizap/database';
import {
  hasKnowledge,
  isOperationsPaused,
  notify,
  requestDelivery,
  searchKnowledge,
} from '@multizap/database';
import {
  AGE_GATE_QUESTION,
  KNOWLEDGE_LIMITS,
  MINOR_NOTICE,
  OpenRouterClient,
  OpenRouterError,
  buildMessages,
  buildSearchQuery,
  buildSystemPrompt,
  detectMinorInMessages,
  estimateCost,
  extractDelivery,
  hitsForDisplay,
  knowledgeForPrompt,
  parseAgeAnswer,
  type DeliverableSpec,
  type KnowledgeHit,
  type ChatMessage,
  type ModelInfo,
  type PersonaSpec,
} from '@multizap/ai';
import {
  AI_ACCOUNT_HOURLY_CAP,
  AI_CAMPAIGN_QUIET_DAYS,
  AI_HUMAN_WINDOW_HOURS,
  AI_KEY_AAD,
  type AiInboundJob,
  type GatewayCommand,
} from '@multizap/shared';
import type { CredentialCipher } from '@multizap/shared/crypto';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export type Outcome =
  { status: 'sent' | 'drafted' } | { status: 'skipped' | 'failed'; reason: string };

/** Versão publicada do agente (fotografia gravada na publicação). */
interface Snapshot {
  agent: {
    name: string;
    model: string;
    temperature: number | null;
    maxTokens: number;
    instructions: string | null;
    memoryEnabled: boolean;
    mode: 'REVIEW' | 'AUTO';
  };
  persona: PersonaSpec;
}

const HISTORY_MESSAGES = 20;
const MEMORY_EVERY = 12;
const MAX_INTERVAL_WAIT_MS = 120_000;
const HOUR = 3_600_000;

export interface ResponderDeps {
  prisma: PrismaClient;
  cipher: CredentialCipher | null;
  gateway: { send(cmd: GatewayCommand): Promise<unknown> };
  fetchImpl?: typeof fetch;
  appUrl?: string;
  log?: Log;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Atendimento pela IA: para cada mensagem recebida ao vivo decide se o agente pode responder
 * (todas as regras de segurança passam por aqui) e, se puder, gera a resposta e a entrega como
 * rascunho para revisão (padrão) ou envia (modo automático, escolhido por agente).
 *
 * Qualquer falha fica restrita ao módulo: nada aqui impede o CRM de gravar ou mostrar mensagens.
 */
export class AiResponder {
  private readonly prisma: PrismaClient;
  private readonly log: Log;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private priceCache: { at: number; models: ModelInfo[] } | null = null;

  constructor(private readonly deps: ResponderDeps) {
    this.prisma = deps.prisma;
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async handle(job: AiInboundJob): Promise<Outcome> {
    const { prisma } = this;
    const msg = await prisma.message.findUnique({ where: { id: job.messageId } });
    if (!msg || msg.direction !== 'INBOUND') return { status: 'skipped', reason: 'sem mensagem' };
    const conv = await prisma.conversation.findUnique({
      where: { id: msg.conversationId },
      include: { contact: true, account: true },
    });
    if (!conv) return { status: 'skipped', reason: 'sem conversa' };

    // Grupos, listas de transmissão e canais nunca são atendidos.
    const jid = conv.remoteJid;
    if (!/@(s\.whatsapp\.net|lid)$/.test(jid))
      return { status: 'skipped', reason: 'não individual' };

    // Só a mensagem mais recente do contato responde (as anteriores já fazem parte do histórico).
    const latest = await prisma.message.findFirst({
      where: { conversationId: conv.id, direction: 'INBOUND' },
      orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true },
    });
    if (latest && latest.id !== msg.id) return { status: 'skipped', reason: 'mensagem mais nova' };

    const link = await prisma.aiAgentAccount.findFirst({
      where: {
        accountId: conv.accountId,
        agent: { status: 'ACTIVE', publishedVersionId: { not: null } },
      },
      include: { agent: { include: { publishedVersion: true } } },
    });
    if (!link?.agent.publishedVersion) return { status: 'skipped', reason: 'sem agente ativo' };
    const agent = link.agent;
    const spec = agent.publishedVersion!.snapshot as unknown as Snapshot;

    if (await prisma.aiDraft.findUnique({ where: { inboundMessageId: msg.id } }))
      return { status: 'skipped', reason: 'já respondida' };

    const state = await prisma.aiConversationState.findUnique({
      where: { conversationId: conv.id },
    });
    const skip = async (reason: string, pause?: { by: string }): Promise<Outcome> => {
      await this.note(conv.id, reason, pause);
      return { status: 'skipped', reason };
    };

    if (state?.paused) return skip(state.pausedReason ?? 'IA pausada nesta conversa');
    if (conv.account.connectionType !== 'WHATSAPP_WEB' || conv.account.disabledAt)
      return skip('Instância indisponível para a IA');
    if (await isOperationsPaused(prisma)) return skip('Operações pausadas globalmente');

    // Descadastro: só volta a ser atendido se escrever depois do pedido (igual às respostas manuais).
    const optOut = conv.phoneE164
      ? await prisma.optOut.findUnique({
          where: {
            accountId_phoneE164: { accountId: conv.accountId, phoneE164: conv.phoneE164 },
          },
          select: { createdAt: true },
        })
      : null;
    const optedOutAt = conv.contact?.optedOutAt ?? optOut?.createdAt ?? null;
    if (optedOutAt && msg.sentAt <= optedOutAt) return skip('O contato pediu descadastramento');

    // Campanha não ativa a IA: quem recebeu campanha fica fora por alguns dias.
    if (!state?.enabledOverride) {
      const since = new Date(this.now() - AI_CAMPAIGN_QUIET_DAYS * 24 * HOUR);
      const camp = await prisma.message.findFirst({
        where: {
          conversationId: conv.id,
          direction: 'OUTBOUND',
          campaignRecipientId: { not: null },
          sentAt: { gt: since },
        },
        select: { id: true },
      });
      if (camp)
        return skip(
          `Recebeu campanha nos últimos ${AI_CAMPAIGN_QUIET_DAYS} dias (libere manualmente)`,
        );
    }

    // Uma pessoa respondeu (pela Central ou pelo celular): a IA se afasta.
    const humanSince = new Date(
      Math.max(
        this.now() - AI_HUMAN_WINDOW_HOURS * HOUR,
        state?.lastReplyAt?.getTime() ?? 0,
        state?.contextResetAt?.getTime() ?? 0,
      ),
    );
    const human = await prisma.message.findFirst({
      where: {
        conversationId: conv.id,
        direction: 'OUTBOUND',
        campaignRecipientId: null,
        aiLink: null,
        status: { not: 'FAILED' },
        sentAt: { gt: humanSince },
      },
      select: { id: true },
    });
    if (human) return skip('Uma pessoa respondeu esta conversa', { by: 'human' });

    // Proteção de menor de idade (vale para todo agente, antes de qualquer resposta ou limite):
    // sinais de menos de 18 anos nas últimas mensagens do contato encerram o atendimento.
    // Não verifica idade: só detecta sinais. A IA fica pausada até o administrador liberar.
    const recentInbound = await prisma.message.findMany({
      where: {
        conversationId: conv.id,
        direction: 'INBOUND',
        type: 'text',
        body: { not: null },
        ...(state?.contextResetAt && { sentAt: { gt: state.contextResetAt } }),
      },
      orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
      take: 3,
      select: { body: true },
    });
    const signal = detectMinorInMessages(recentInbound.map((m) => m.body!));
    const autoMode = agent.mode === 'AUTO';
    if (signal) {
      const reason = `Possível menor de idade (${signal.kind}): "${signal.snippet}"`;
      await this.lockMinor(conv, agent, msg, reason, autoMode);
      return { status: 'skipped', reason: 'Possível menor de idade' };
    }

    // Portão de idade (opcional por agente): pergunta antes de conversar. Não verifica idade.
    if (agent.ageGate && !state?.ageConfirmedAt) {
      const answer = state?.ageAskedAt ? parseAgeAnswer(msg.body ?? '') : null;
      if (answer === 'no') {
        await this.lockMinor(conv, agent, msg, 'Respondeu que não tem 18 anos', autoMode);
        return { status: 'skipped', reason: 'Possível menor de idade' };
      }
      if (answer === 'yes') {
        await prisma.aiConversationState.update({
          where: { conversationId: conv.id },
          data: { ageConfirmedAt: new Date(this.now()) },
        });
      } else {
        // Primeira mensagem, ou resposta que não deu para entender: faz (ou repete) a pergunta.
        await this.emitCanned(conv, agent, msg, AGE_GATE_QUESTION, autoMode);
        await prisma.aiConversationState.upsert({
          where: { conversationId: conv.id },
          create: { conversationId: conv.id, ageAskedAt: new Date(this.now()) },
          update: { ageAskedAt: new Date(this.now()), lastSkip: null, lastSkipAt: null },
        });
        return { status: autoMode ? 'sent' : 'drafted' };
      }
    }

    // Limites de envio.
    const hourAgo = new Date(this.now() - HOUR);
    if (
      (await prisma.aiDraft.count({
        where: { conversationId: conv.id, createdAt: { gt: hourAgo } },
      })) >= agent.maxRepliesPerHour
    )
      return skip('Limite de respostas por hora desta conversa');
    if (
      (await prisma.aiDraft.count({
        where: { conversation: { accountId: conv.accountId }, createdAt: { gt: hourAgo } },
      })) >= AI_ACCOUNT_HOURLY_CAP
    )
      return skip('Limite de respostas por hora da instância');

    const text = msg.type === 'text' ? msg.body?.trim() : null;
    if (!text) return skip('Mensagem sem texto (áudio, imagem...): responda manualmente');

    // Chave da OpenRouter.
    const client = await this.client(agent.id);
    if (!client) return skip('IA sem chave da OpenRouter utilizável');

    const history = await this.history(conv.id, state?.contextResetAt);
    const memory =
      spec.agent.memoryEnabled && state?.memory && state.memoryAgentId === agent.id
        ? state.memory
        : null;
    // Base de conhecimento: trechos relevantes às últimas mensagens do contato.
    // Uma falha na busca nunca impede a resposta (o agente apenas responde sem a base).
    let hits: KnowledgeHit[] = [];
    let knowledgeSearched = false;
    try {
      knowledgeSearched = await hasKnowledge(prisma, agent.id);
      if (knowledgeSearched) {
        const recent = history
          .filter((m) => m.role === 'user')
          .slice(-2)
          .map((m) => m.content)
          .join(' ');
        const query = buildSearchQuery(recent);
        // Mensagem sem termos de busca (ex.: "Oi"): não há o que consultar na base, e o agente
        // não deve tratar isso como "informação que falta".
        knowledgeSearched = query !== '';
        if (knowledgeSearched)
          hits = (await searchKnowledge(
            prisma,
            agent.id,
            query,
            KNOWLEDGE_LIMITS.searchLimit,
          )) as KnowledgeHit[];
      }
    } catch (err) {
      this.log('Busca na base de conhecimento falhou', { agentId: agent.id, err: String(err) });
    }
    const sources = hitsForDisplay(hits);

    // Entregáveis do agente (ligados, ligados e com arquivo disponível) e aviso de pagamento declarado.
    const items = await prisma.aiDeliverable.findMany({
      where: { enabled: true, agents: { some: { agentId: agent.id } } },
      include: { asset: { select: { storageKey: true } } },
      orderBy: { name: 'asc' },
    });
    const offered = items.filter((i) => i.kind !== 'FILE' || !!i.asset?.storageKey);
    const catalog: DeliverableSpec[] = offered.map((i) => ({
      code: i.code,
      name: i.name,
      description: i.description,
      adultOnly: i.adultOnly,
      requiresPayment: i.requiresPayment,
      priceCents: i.priceCents,
      paymentInstructions: i.paymentInstructions,
    }));
    await this.noteClaimedPayment(conv, text);

    const messages = buildMessages(
      spec.persona,
      { name: spec.agent.name, instructions: spec.agent.instructions },
      history,
      {
        memory,
        contactName: conv.contact?.name ?? conv.title,
        knowledge: knowledgeForPrompt(hits),
        knowledgeSearched,
        deliverables: catalog,
      },
    );

    // O modo é um interruptor operacional: vale na hora, sem nova publicação.
    const auto = agent.mode === 'AUTO';
    const typing = auto && agent.showTyping;
    if (typing) await this.presence(conv.accountId, jid, 'composing');
    let result;
    try {
      result = await client.chat({
        model: spec.agent.model,
        messages,
        temperature: spec.agent.temperature,
        maxTokens: spec.agent.maxTokens,
      });
    } catch (err) {
      return this.chatFailure(agent.id, conv.id, err);
    } finally {
      if (typing) await this.presence(conv.accountId, jid, 'paused');
    }
    await this.recordUsage(
      agent.id,
      conv.accountId,
      conv.id,
      'reply',
      result,
      spec.agent.model,
      client,
    );

    // O marcador [[ENTREGAR:codigo]] nunca chega ao contato: sai do texto e vira um pedido de entrega.
    const parsed = extractDelivery(result.content);
    const wanted = parsed.code ? offered.find((i) => i.code === parsed.code) : undefined;
    const reply = parsed.text || (wanted ? 'Certo! Já cuido disso.' : '');
    if (!reply) return skip('O modelo devolveu uma resposta vazia');

    if (!auto) {
      try {
        await prisma.aiDraft.create({
          data: {
            conversationId: conv.id,
            agentId: agent.id,
            versionId: agent.publishedVersionId,
            inboundMessageId: msg.id,
            body: reply,
            sources,
            deliverableId: wanted?.id ?? null,
          },
        });
      } catch (err) {
        if (isUnique(err)) return { status: 'skipped', reason: 'já respondida' };
        throw err;
      }
      await this.clearSkip(conv.id);
      return { status: 'drafted' };
    }

    // Automático: espera o intervalo fixo e confere de novo antes de enviar.
    const target = Math.max(
      msg.createdAt.getTime() + agent.minIntervalSeconds * 1000,
      (state?.lastReplyAt?.getTime() ?? 0) + agent.minIntervalSeconds * 1000,
    );
    const wait = Math.min(MAX_INTERVAL_WAIT_MS, Math.max(0, target - this.now()));
    if (wait > 0) await this.sleep(wait);

    const stillLatest = await prisma.message.findFirst({
      where: { conversationId: conv.id, direction: 'INBOUND' },
      orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true },
    });
    if (stillLatest?.id !== msg.id) return skip('Chegou outra mensagem durante a resposta');
    const fresh = await prisma.aiConversationState.findUnique({
      where: { conversationId: conv.id },
    });
    if (fresh?.paused) return skip(fresh.pausedReason ?? 'IA pausada nesta conversa');
    const humanNow = await prisma.message.findFirst({
      where: {
        conversationId: conv.id,
        direction: 'OUTBOUND',
        campaignRecipientId: null,
        aiLink: null,
        status: { not: 'FAILED' },
        sentAt: { gt: msg.sentAt },
      },
      select: { id: true },
    });
    if (humanNow) return skip('Uma pessoa respondeu esta conversa', { by: 'human' });
    const stillActive = await prisma.aiAgent.findFirst({
      where: { id: agent.id, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!stillActive) return skip('Agente pausado durante a resposta');

    let sentMessageId: string;
    try {
      sentMessageId = await prisma.$transaction(async (tx) => {
        const sentAt = new Date(this.now());
        const m = await tx.message.create({
          data: {
            accountId: conv.accountId,
            conversationId: conv.id,
            providerMessageId: `pending:${randomUUID()}`,
            direction: 'OUTBOUND',
            type: 'text',
            body: reply,
            status: 'PENDING',
            sentAt,
          },
        });
        await tx.aiMessageLink.create({
          data: { messageId: m.id, agentId: agent.id, source: 'auto' },
        });
        await tx.aiDraft.create({
          data: {
            conversationId: conv.id,
            agentId: agent.id,
            versionId: agent.publishedVersionId,
            inboundMessageId: msg.id,
            body: reply,
            sentBody: reply,
            sources,
            status: 'SENT',
            autoSent: true,
            messageId: m.id,
            decidedAt: sentAt,
          },
        });
        await tx.aiConversationState.upsert({
          where: { conversationId: conv.id },
          create: { conversationId: conv.id, lastReplyAt: sentAt },
          update: { lastReplyAt: sentAt, lastSkip: null, lastSkipAt: null },
        });
        return m.id;
      });
    } catch (err) {
      if (isUnique(err)) return { status: 'skipped', reason: 'já respondida' };
      throw err;
    }
    await this.deps.gateway.send({
      type: 'send-reply',
      accountId: conv.accountId,
      messageId: sentMessageId,
    });

    if (wanted)
      await this.startDelivery(conv, agent, msg.id, wanted.id).catch((err) =>
        this.log('Entrega não registrada', { conversationId: conv.id, err: String(err) }),
      );

    await this.updateMemory(agent.id, conv.id, conv.accountId, spec, client).catch((err) =>
      this.log('Memória não atualizada', { conversationId: conv.id, err: String(err) }),
    );
    return { status: 'sent' };
  }

  // ─── apoio ──────────────────────────────────────────────────────────────

  /**
   * O agente pediu um item: registra a entrega (as regras e o pagamento são decididos em
   * `requestDelivery`). Item pago: manda o código do pedido ao contato e NADA é entregue até o
   * pagamento ser confirmado por fonte real. Item gratuito de aprovação automática vai direto
   * para o envio; de aprovação manual, avisa o administrador.
   */
  private async startDelivery(
    conv: { id: string; accountId: string; title: string | null; phoneE164: string | null },
    agent: { id: string },
    inboundMessageId: string,
    deliverableId: string,
  ) {
    const r = await requestDelivery(this.prisma, {
      conversationId: conv.id,
      deliverableId,
      agentId: agent.id,
      inboundMessageId,
    });
    if (!r.created) return;
    const who = conv.title ?? conv.phoneE164 ?? 'contato';
    if (r.delivery.status === 'BLOCKED') {
      await this.event(
        agent.id,
        'DELIVERY',
        'warn',
        `Entrega bloqueada (${r.delivery.itemName}): ${r.delivery.reason}`,
        {
          conversationId: conv.id,
        },
      );
      return;
    }
    if (r.payment) {
      const price = (r.payment.amountCents / 100).toFixed(2).replace('.', ',');
      await this.emitPlain(
        conv,
        agent,
        `Código do pedido: ${r.payment.reference} (R$ ${price}). Informe este código ao pagar. Assim que o pagamento for confirmado, envio o item.`,
      );
    }
    if (r.delivery.status === 'AWAITING_APPROVAL')
      await notify(this.prisma, {
        severity: 'INFO',
        category: 'PROCESSING',
        title: 'Entrega aguardando aprovação',
        message: `${r.delivery.itemName} para ${who}. Aprove em MultiZap AI → Atendimentos.`,
        accountId: conv.accountId,
        dedupeKey: `ai-delivery-approval:${r.delivery.id}`,
      });
    if (r.dispatch)
      await this.deps.gateway.send({
        type: 'send-delivery',
        accountId: conv.accountId,
        deliveryId: r.delivery.id,
      });
  }

  /** Mensagem de sistema ao contato (sem rascunho): enviada pelo mesmo caminho das respostas. */
  private async emitPlain(
    conv: { id: string; accountId: string },
    agent: { id: string },
    body: string,
  ) {
    const m = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          accountId: conv.accountId,
          conversationId: conv.id,
          providerMessageId: `pending:${randomUUID()}`,
          direction: 'OUTBOUND',
          type: 'text',
          body,
          status: 'PENDING',
          sentAt: new Date(this.now()),
        },
      });
      await tx.aiMessageLink.create({
        data: { messageId: msg.id, agentId: agent.id, source: 'auto' },
      });
      return msg;
    });
    await this.deps.gateway.send({
      type: 'send-reply',
      accountId: conv.accountId,
      messageId: m.id,
    });
  }

  /**
   * O contato disse que pagou: é só um aviso para o administrador conferir. NADA é liberado por
   * isso: o pagamento só é confirmado por fonte real (administrador ou aviso assinado).
   */
  private async noteClaimedPayment(
    conv: { id: string; accountId: string; title: string | null; phoneE164: string | null },
    text: string,
  ) {
    if (!PAID_CLAIM.test(text)) return;
    const pending = await this.prisma.aiPayment.findMany({
      where: { status: 'PENDING', claimedAt: null, delivery: { conversationId: conv.id } },
      include: { delivery: { select: { itemName: true } } },
    });
    for (const p of pending) {
      await this.prisma.aiPayment.update({
        where: { id: p.id },
        data: { claimedAt: new Date(this.now()) },
      });
      await notify(this.prisma, {
        severity: 'WARNING',
        category: 'PROCESSING',
        title: 'Contato diz que pagou',
        message: `${conv.title ?? conv.phoneE164 ?? 'Contato'} disse que pagou "${p.delivery.itemName}" (código ${p.reference}). Confira no seu banco e confirme em Atendimentos.`,
        accountId: conv.accountId,
        dedupeKey: `ai-pay-claim:${p.id}`,
      });
    }
  }

  /**
   * Sinal de menor de idade: pausa a IA nesta conversa (só o administrador libera), avisa o
   * administrador e, no modo automático, envia uma única mensagem fixa e neutra.
   */
  private async lockMinor(
    conv: { id: string; accountId: string; title: string | null; phoneE164: string | null },
    agent: { id: string; publishedVersionId: string | null },
    msg: { id: string },
    reason: string,
    auto: boolean,
  ) {
    const at = new Date(this.now());
    await this.prisma.aiConversationState.upsert({
      where: { conversationId: conv.id },
      create: {
        conversationId: conv.id,
        paused: true,
        pausedBy: 'minor',
        pausedReason: reason,
        pausedAt: at,
        lastSkip: reason,
        lastSkipAt: at,
      },
      update: {
        paused: true,
        pausedBy: 'minor',
        pausedReason: reason,
        pausedAt: at,
        lastSkip: reason,
        lastSkipAt: at,
      },
    });
    if (auto) await this.emitCanned(conv, agent, msg, MINOR_NOTICE, true);
    await this.event(agent.id, 'AGENT', 'warn', `Conversa pausada: ${reason}`, {
      conversationId: conv.id,
    });
    await notify(this.prisma, {
      severity: 'WARNING',
      category: 'SECURITY',
      title: 'IA pausada: possível menor de idade',
      message: `${conv.title ?? conv.phoneE164 ?? 'Contato'}: ${reason}. Revise em MultiZap AI → Atendimentos.`,
      accountId: conv.accountId,
      dedupeKey: `ai-minor:${conv.id}`,
    });
  }

  /**
   * Mensagem fixa (pergunta de idade, aviso de encerramento): no modo automático é enviada pelo
   * mesmo caminho das respostas; no modo revisão vira rascunho. Uma por mensagem do contato.
   */
  private async emitCanned(
    conv: { id: string; accountId: string },
    agent: { id: string; publishedVersionId: string | null },
    msg: { id: string },
    body: string,
    auto: boolean,
  ) {
    const { prisma } = this;
    if (!auto) {
      await prisma.aiDraft
        .create({
          data: {
            conversationId: conv.id,
            agentId: agent.id,
            versionId: agent.publishedVersionId,
            inboundMessageId: msg.id,
            body,
          },
        })
        .catch((err) => {
          if (!isUnique(err)) throw err;
        });
      return;
    }
    let messageId: string;
    try {
      messageId = await prisma.$transaction(async (tx) => {
        const sentAt = new Date(this.now());
        const m = await tx.message.create({
          data: {
            accountId: conv.accountId,
            conversationId: conv.id,
            providerMessageId: `pending:${randomUUID()}`,
            direction: 'OUTBOUND',
            type: 'text',
            body,
            status: 'PENDING',
            sentAt,
          },
        });
        await tx.aiMessageLink.create({
          data: { messageId: m.id, agentId: agent.id, source: 'auto' },
        });
        await tx.aiDraft.create({
          data: {
            conversationId: conv.id,
            agentId: agent.id,
            versionId: agent.publishedVersionId,
            inboundMessageId: msg.id,
            body,
            sentBody: body,
            status: 'SENT',
            autoSent: true,
            messageId: m.id,
            decidedAt: sentAt,
          },
        });
        await tx.aiConversationState.upsert({
          where: { conversationId: conv.id },
          create: { conversationId: conv.id, lastReplyAt: sentAt },
          update: { lastReplyAt: sentAt },
        });
        return m.id;
      });
    } catch (err) {
      if (isUnique(err)) return;
      throw err;
    }
    await this.deps.gateway.send({ type: 'send-reply', accountId: conv.accountId, messageId });
  }

  /** Últimas mensagens de texto da conversa; só as posteriores ao "reiniciar contexto", se houver. */
  private async history(
    conversationId: string,
    since?: Date | null,
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(since && { sentAt: { gt: since } }),
        type: 'text',
        body: { not: null },
        status: { not: 'FAILED' },
      },
      orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
      take: HISTORY_MESSAGES,
      select: { direction: true, body: true },
    });
    return rows
      .reverse()
      .filter((r) => r.body?.trim())
      .map((r) => ({
        role: r.direction === 'INBOUND' ? ('user' as const) : ('assistant' as const),
        content: r.body!.trim(),
      }));
  }

  private async client(agentId: string): Promise<OpenRouterClient | null> {
    const cred = await this.prisma.aiCredential.findUnique({ where: { provider: 'openrouter' } });
    if (!cred) {
      await this.event(agentId, 'OPENROUTER', 'warn', 'Chave da OpenRouter não configurada.');
      return null;
    }
    if (!this.deps.cipher) {
      await this.event(
        agentId,
        'OPENROUTER',
        'error',
        'O worker não tem CREDENTIALS_MASTER_KEY para ler a chave da OpenRouter.',
      );
      return null;
    }
    try {
      const apiKey = this.deps.cipher
        .decrypt(Buffer.from(cred.keyEnc), AI_KEY_AAD)
        .toString('utf8');
      return new OpenRouterClient({
        apiKey,
        fetchImpl: this.deps.fetchImpl,
        appUrl: this.deps.appUrl,
      });
    } catch {
      await this.event(
        agentId,
        'OPENROUTER',
        'error',
        'A chave salva não pôde ser lida (CREDENTIALS_MASTER_KEY diferente da usada para salvar).',
      );
      return null;
    }
  }

  private async chatFailure(
    agentId: string,
    conversationId: string,
    err: unknown,
  ): Promise<Outcome> {
    if (!(err instanceof OpenRouterError)) throw err;
    await this.event(agentId, 'OPENROUTER', 'error', err.message, { code: err.code });
    // Chave inválida ou sem créditos: continuar tentando só repete o erro. Para o agente.
    if (err.code === 'INVALID_KEY' || err.code === 'NO_CREDITS') {
      await this.prisma.aiAgent.update({ where: { id: agentId }, data: { status: 'ERROR' } });
      await this.event(
        agentId,
        'AGENT',
        'error',
        'Agente parado por erro da OpenRouter. Corrija e ative novamente.',
      );
      await notify(this.prisma, {
        severity: 'ERROR',
        category: 'INTEGRATION',
        title: 'IA parada por erro da OpenRouter',
        message: `${err.message} O agente foi parado: corrija a chave ou os créditos e ative de novo em MultiZap AI.`,
        dedupeKey: `ai-agent-error:${agentId}`,
      });
    }
    await this.note(conversationId, `Falha da OpenRouter: ${err.message}`);
    return { status: 'failed', reason: err.code };
  }

  private async prices(client: OpenRouterClient): Promise<ModelInfo[]> {
    if (this.priceCache && this.now() - this.priceCache.at < HOUR) return this.priceCache.models;
    const models = await client.models().catch(() => [] as ModelInfo[]);
    this.priceCache = { at: this.now(), models };
    return models;
  }

  private async recordUsage(
    agentId: string,
    accountId: string,
    conversationId: string,
    purpose: 'reply' | 'memory',
    r: {
      model: string;
      promptTokens: number;
      completionTokens: number;
      costUsd: number | null;
      latencyMs: number;
    },
    requested: string,
    client: OpenRouterClient,
  ) {
    let cost = r.costUsd;
    let confirmed = cost !== null;
    if (cost === null) {
      const models = await this.prices(client);
      cost = estimateCost(
        r.promptTokens,
        r.completionTokens,
        models.find((m) => m.id === requested),
      );
      confirmed = false;
    }
    await this.prisma.aiTokenUsage.create({
      data: {
        agentId,
        accountId,
        conversationId,
        purpose,
        context: 'LIVE',
        model: r.model,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        costUsd: cost,
        costConfirmed: confirmed,
        latencyMs: r.latencyMs,
      },
    });
  }

  /** Resume o que se sabe do contato a cada MEMORY_EVERY mensagens novas. */
  private async updateMemory(
    agentId: string,
    conversationId: string,
    accountId: string,
    spec: Snapshot,
    client: OpenRouterClient,
  ) {
    if (!spec.agent.memoryEnabled) return;
    const state = await this.prisma.aiConversationState.findUnique({ where: { conversationId } });
    const memorySince = state?.memoryAgentId === agentId ? state.memoryUpdatedAt : null;
    const reset = state?.contextResetAt ?? null;
    const since =
      memorySince && reset ? (memorySince > reset ? memorySince : reset) : (memorySince ?? reset);
    const fresh = await this.prisma.message.count({
      where: { conversationId, type: 'text', ...(since && { sentAt: { gt: since } }) },
    });
    if (fresh < MEMORY_EVERY) return;
    const transcript = (await this.history(conversationId, reset))
      .map((m) => `${m.role === 'user' ? 'Contato' : 'Atendente'}: ${m.content}`)
      .join('\n');
    const previous = state?.memoryAgentId === agentId ? state.memory : null;
    const prompt: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Você mantém a memória de um atendimento. Escreva um resumo curto (até 8 linhas, em português) com o que é útil lembrar sobre este contato: nome, interesses, pedidos, dúvidas em aberto e preferências. Não invente nada e não inclua senhas, códigos ou dados de cartão.',
      },
      {
        role: 'user',
        content: `Resumo anterior:\n${previous ?? '(nenhum)'}\n\nConversa recente:\n${transcript}\n\nEscreva o resumo atualizado.`,
      },
    ];
    const r = await client.chat({
      model: spec.agent.model,
      messages: prompt,
      maxTokens: 300,
      temperature: 0.2,
    });
    await this.recordUsage(
      agentId,
      accountId,
      conversationId,
      'memory',
      r,
      spec.agent.model,
      client,
    );
    const now = new Date(this.now());
    await this.prisma.aiConversationState.upsert({
      where: { conversationId },
      create: {
        conversationId,
        memory: r.content.trim(),
        memoryAgentId: agentId,
        memoryUpdatedAt: now,
      },
      update: { memory: r.content.trim(), memoryAgentId: agentId, memoryUpdatedAt: now },
    });
  }

  private async presence(accountId: string, jid: string, state: 'composing' | 'paused') {
    try {
      await this.deps.gateway.send({ type: 'send-presence', accountId, jid, state });
    } catch (err) {
      this.log('Presença não enviada', { accountId, err: String(err) });
    }
  }

  /** Registra por que a IA não respondeu (aparece na caixa de entrada da IA). */
  private async note(conversationId: string, reason: string, pause?: { by: string }) {
    const at = new Date(this.now());
    await this.prisma.aiConversationState.upsert({
      where: { conversationId },
      create: {
        conversationId,
        lastSkip: reason,
        lastSkipAt: at,
        ...(pause && { paused: true, pausedBy: pause.by, pausedReason: reason, pausedAt: at }),
      },
      update: {
        lastSkip: reason,
        lastSkipAt: at,
        ...(pause && { paused: true, pausedBy: pause.by, pausedReason: reason, pausedAt: at }),
      },
    });
  }

  private async clearSkip(conversationId: string) {
    await this.prisma.aiConversationState.upsert({
      where: { conversationId },
      create: { conversationId },
      update: { lastSkip: null, lastSkipAt: null },
    });
  }

  /** Eventos do agente; o mesmo aviso repetido em 10 minutos não vira outro evento. */
  private async event(
    agentId: string,
    category: 'OPENROUTER' | 'AGENT' | 'WHATSAPP' | 'KNOWLEDGE' | 'DELIVERY',
    level: 'info' | 'warn' | 'error',
    message: string,
    details?: Record<string, unknown>,
  ) {
    const recent = await this.prisma.aiAgentEvent.findFirst({
      where: { agentId, message, createdAt: { gt: new Date(this.now() - 10 * 60_000) } },
      select: { id: true },
    });
    if (recent) return;
    await this.prisma.aiAgentEvent.create({
      data: { agentId, category, level, message, ...(details && { details: details as object }) },
    });
  }
}

/** O contato afirma que já pagou (só um aviso: nunca libera nada). */
const PAID_CLAIM =
  /\b(j[aá]\s+(paguei|pago|fiz\s+o\s+pix|fiz\s+a\s+transfer[eê]ncia|transferi|depositei)|pix\s+(feito|enviado|realizado)|comprovante)\b/i;

const isUnique = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
