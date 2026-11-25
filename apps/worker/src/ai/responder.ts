import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@multizap/database';
import { hasKnowledge, isOperationsPaused, searchKnowledge } from '@multizap/database';
import {
  KNOWLEDGE_LIMITS,
  OpenRouterClient,
  OpenRouterError,
  buildMessages,
  buildSearchQuery,
  buildSystemPrompt,
  estimateCost,
  hitsForDisplay,
  knowledgeForPrompt,
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
      Math.max(this.now() - AI_HUMAN_WINDOW_HOURS * HOUR, state?.lastReplyAt?.getTime() ?? 0),
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

    const history = await this.history(conv.id);
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
        hits = (await searchKnowledge(
          prisma,
          agent.id,
          buildSearchQuery(recent),
          KNOWLEDGE_LIMITS.searchLimit,
        )) as KnowledgeHit[];
      }
    } catch (err) {
      this.log('Busca na base de conhecimento falhou', { agentId: agent.id, err: String(err) });
    }
    const sources = hitsForDisplay(hits);
    const messages = buildMessages(
      spec.persona,
      { name: spec.agent.name, instructions: spec.agent.instructions },
      history,
      {
        memory,
        contactName: conv.contact?.name ?? conv.title,
        knowledge: knowledgeForPrompt(hits),
        knowledgeSearched,
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

    const reply = result.content.trim();
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

    await this.updateMemory(agent.id, conv.id, conv.accountId, spec, client).catch((err) =>
      this.log('Memória não atualizada', { conversationId: conv.id, err: String(err) }),
    );
    return { status: 'sent' };
  }

  // ─── apoio ──────────────────────────────────────────────────────────────

  private async history(
    conversationId: string,
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
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
    const since = state?.memoryAgentId === agentId ? state.memoryUpdatedAt : null;
    const fresh = await this.prisma.message.count({
      where: { conversationId, type: 'text', ...(since && { createdAt: { gt: since } }) },
    });
    if (fresh < MEMORY_EVERY) return;
    const transcript = (await this.history(conversationId))
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
    category: 'OPENROUTER' | 'AGENT' | 'WHATSAPP',
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

const isUnique = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
