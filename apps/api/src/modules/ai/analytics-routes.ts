import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@multizap/database';
import {
  HEARTBEAT_KEYS,
  type AiAnalyticsDTO,
  type AiHealthAlert,
  type AiHealthDTO,
  type AiUsageTotals,
} from '@multizap/shared';
import { OpenRouterClient } from '@multizap/ai';
import { AI_KEY_AAD } from '@multizap/shared';
import { parse } from '../../lib/validate';

const uuid = z.string().uuid('Identificador inválido.');
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const KEYINFO_CACHE = 'multizap:ai:keyinfo';

/** Métricas e saúde do MultiZap AI: tudo calculado dos registros reais (nada estimado). */
export async function aiAnalyticsRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };
  const tz = app.config.reportsTimezone;

  app.get('/ai/analytics', auth, async (req) => {
    const q = parse(
      z.object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        agentId: uuid.optional(),
        accountId: uuid.optional(),
      }),
      req.query,
    );

    // Janela: do começo do dia (no fuso dos relatórios) de `days - 1` dias atrás até agora.
    // As colunas de data ficam em UTC (sem fuso): comparações e dias locais convertem de UTC.
    const [start] = await prisma.$queryRaw<{ ts: Date }[]>`
      SELECT ((((now() AT TIME ZONE ${tz})::date - ${q.days - 1}::int)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC') AS ts`;
    const from = start!.ts;

    const agentSql = q.agentId ? Prisma.sql`AND d.agent_id = ${q.agentId}::uuid` : Prisma.empty;
    const acctSql = q.accountId
      ? Prisma.sql`AND c.account_id = ${q.accountId}::uuid`
      : Prisma.empty;

    const [t] = await prisma.$queryRaw<
      {
        conversations: bigint;
        replies: bigint;
        auto: bigint;
        approved: bigint;
        discarded: bigint;
        pending: bigint;
        edited: bigint;
        with_sources: bigint;
      }[]
    >`
      SELECT count(DISTINCT d.conversation_id) AS conversations,
             count(*) AS replies,
             count(*) FILTER (WHERE d.auto_sent) AS auto,
             count(*) FILTER (WHERE d.status = 'SENT' AND NOT d.auto_sent) AS approved,
             count(*) FILTER (WHERE d.status = 'DISCARDED') AS discarded,
             count(*) FILTER (WHERE d.status = 'PENDING') AS pending,
             count(*) FILTER (WHERE d.status = 'SENT' AND NOT d.auto_sent
                              AND d.sent_body IS NOT NULL AND d.sent_body <> d.body) AS edited,
             count(*) FILTER (WHERE jsonb_array_length(d.sources) > 0) AS with_sources
      FROM ai_drafts d JOIN conversations c ON c.id = d.conversation_id
      WHERE d.created_at >= ${from} ${agentSql} ${acctSql}`;

    const [resp] = await prisma.$queryRaw<{ med: number | null; p90: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS med,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) AS p90
      FROM (
        SELECT EXTRACT(EPOCH FROM (COALESCE(d.decided_at, d.created_at) - m.sent_at)) AS secs
        FROM ai_drafts d
        JOIN messages m ON m.id = d.inbound_message_id
        JOIN conversations c ON c.id = d.conversation_id
        WHERE d.auto_sent AND d.created_at >= ${from} ${agentSql} ${acctSql}
      ) x WHERE secs >= 0`;
    const [rev] = await prisma.$queryRaw<{ med: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (d.decided_at - d.created_at))) AS med
      FROM ai_drafts d JOIN conversations c ON c.id = d.conversation_id
      WHERE d.status = 'SENT' AND NOT d.auto_sent AND d.decided_at IS NOT NULL
        AND d.created_at >= ${from} ${agentSql} ${acctSql}`;

    const pausedRows = await prisma.$queryRaw<{ by: string | null; n: bigint }[]>`
      SELECT s.paused_by AS by, count(*) AS n
      FROM ai_conversation_states s JOIN conversations c ON c.id = s.conversation_id
      WHERE s.paused_at >= ${from} ${acctSql}
      GROUP BY 1`;
    const paused: Record<string, number> = {};
    for (const r of pausedRows) paused[r.by ?? 'outro'] = Number(r.n);

    // Consumo.
    const usageWhere: Prisma.AiTokenUsageWhereInput = {
      createdAt: { gte: from },
      ...(q.agentId && { agentId: q.agentId }),
      ...(q.accountId && { accountId: q.accountId }),
    };
    const usageRows = await prisma.aiTokenUsage.findMany({
      where: usageWhere,
      select: {
        context: true,
        agentId: true,
        purpose: true,
        promptTokens: true,
        completionTokens: true,
        costUsd: true,
      },
    });
    const total = (ctx: 'LIVE' | 'TEST' | 'GENERATOR'): AiUsageTotals => {
      const r = usageRows.filter((x) => x.context === ctx);
      const priced = r.filter((x) => x.costUsd !== null);
      return {
        calls: r.length,
        promptTokens: r.reduce((a, x) => a + x.promptTokens, 0),
        completionTokens: r.reduce((a, x) => a + x.completionTokens, 0),
        costUsd: priced.length ? priced.reduce((a, x) => a + Number(x.costUsd), 0) : null,
      };
    };
    const live = total('LIVE');
    const replies = Number(t!.replies);

    const agents = await prisma.aiAgent.findMany({ select: { id: true, name: true } });
    const byAgentReplies = await prisma.$queryRaw<{ agent_id: string; n: bigint }[]>`
      SELECT d.agent_id, count(*) AS n
      FROM ai_drafts d JOIN conversations c ON c.id = d.conversation_id
      WHERE d.created_at >= ${from} ${agentSql} ${acctSql}
      GROUP BY 1`;
    const perAgent = agents
      .map((a) => {
        const rows = usageRows.filter((x) => x.context === 'LIVE' && x.agentId === a.id);
        const priced = rows.filter((x) => x.costUsd !== null);
        return {
          agentId: a.id,
          name: a.name,
          replies: Number(byAgentReplies.find((r) => r.agent_id === a.id)?.n ?? 0),
          promptTokens: rows.reduce((s, x) => s + x.promptTokens, 0),
          completionTokens: rows.reduce((s, x) => s + x.completionTokens, 0),
          costUsd: priced.length ? priced.reduce((s, x) => s + Number(x.costUsd), 0) : null,
        };
      })
      .filter((a) => a.replies > 0 || a.promptTokens > 0)
      .sort((a, b) => b.replies - a.replies);

    const top = await prisma.$queryRaw<{ name: string; uses: bigint }[]>`
      SELECT e->>'name' AS name, count(*) AS uses
      FROM ai_drafts d
      JOIN conversations c ON c.id = d.conversation_id
      CROSS JOIN LATERAL jsonb_array_elements(d.sources) e
      WHERE d.created_at >= ${from} ${agentSql} ${acctSql}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 5`;

    // Entregas e pagamentos.
    const delWhere: Prisma.AiDeliveryWhereInput = {
      createdAt: { gte: from },
      ...(q.agentId && { agentId: q.agentId }),
      ...(q.accountId && { conversation: { accountId: q.accountId } }),
    };
    const byStatus: Record<string, number> = {};
    for (const g of await prisma.aiDelivery.groupBy({
      by: ['status'],
      where: delWhere,
      _count: { _all: true },
    }))
      byStatus[g.status] = g._count._all;
    const payWhere = (extra: Prisma.AiPaymentWhereInput): Prisma.AiPaymentWhereInput => ({
      ...extra,
      delivery: {
        ...(q.agentId && { agentId: q.agentId }),
        ...(q.accountId && { conversation: { accountId: q.accountId } }),
      },
    });
    const created = await prisma.aiPayment.count({ where: payWhere({ createdAt: { gte: from } }) });
    const confirmed = await prisma.aiPayment.aggregate({
      where: payWhere({ status: 'CONFIRMED', confirmedAt: { gte: from } }),
      _count: { _all: true },
      _sum: { amountCents: true },
    });

    // Série diária (zeros nos dias sem movimento).
    const replyDaily = await prisma.$queryRaw<{ day: Date; n: bigint; auto: bigint }[]>`
      SELECT ((d.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date AS day, count(*) AS n,
             count(*) FILTER (WHERE d.auto_sent) AS auto
      FROM ai_drafts d JOIN conversations c ON c.id = d.conversation_id
      WHERE d.created_at >= ${from} ${agentSql} ${acctSql}
      GROUP BY 1`;
    const costDaily = await prisma.$queryRaw<{ day: Date; cost: Prisma.Decimal | null }[]>`
      SELECT ((u.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date AS day, sum(u.cost_usd) AS cost
      FROM ai_token_usage u
      WHERE u.context = 'LIVE' AND u.created_at >= ${from}
        ${q.agentId ? Prisma.sql`AND u.agent_id = ${q.agentId}::uuid` : Prisma.empty}
        ${q.accountId ? Prisma.sql`AND u.account_id = ${q.accountId}::uuid` : Prisma.empty}
      GROUP BY 1`;
    const delDaily = await prisma.$queryRaw<{ day: Date; n: bigint }[]>`
      SELECT ((d.sent_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date AS day, count(*) AS n
      FROM ai_deliveries d JOIN conversations c ON c.id = d.conversation_id
      WHERE d.status = 'SENT' AND d.sent_at >= ${from} ${agentSql} ${acctSql}
      GROUP BY 1`;
    const days = await prisma.$queryRaw<{ day: Date }[]>`
      SELECT generate_series(
        (now() AT TIME ZONE ${tz})::date - ${q.days - 1}::int,
        (now() AT TIME ZONE ${tz})::date, interval '1 day')::date AS day`;
    const key = (d: Date) => d.toISOString().slice(0, 10);
    const rMap = new Map(replyDaily.map((r) => [key(r.day), r]));
    const cMap = new Map(costDaily.map((r) => [key(r.day), r]));
    const dMap = new Map(delDaily.map((r) => [key(r.day), r]));
    const daily = days.map(({ day }) => ({
      date: key(day),
      replies: Number(rMap.get(key(day))?.n ?? 0),
      autoSent: Number(rMap.get(key(day))?.auto ?? 0),
      costUsd: Number(cMap.get(key(day))?.cost ?? 0),
      deliveries: Number(dMap.get(key(day))?.n ?? 0),
    }));

    const approved = Number(t!.approved);
    const discarded = Number(t!.discarded);
    const dto: AiAnalyticsDTO = {
      days: q.days,
      from: from.toISOString(),
      to: new Date().toISOString(),
      totals: {
        conversations: Number(t!.conversations),
        replies,
        autoSent: Number(t!.auto),
        approved,
        discarded,
        pending: Number(t!.pending),
        approvalRate: approved + discarded ? approved / (approved + discarded) : null,
        editedRate: approved ? Number(t!.edited) / approved : null,
        knowledgeUseRate: replies ? Number(t!.with_sources) / replies : null,
        responseSeconds: { median: num(resp?.med), p90: num(resp?.p90) },
        reviewSeconds: { median: num(rev?.med) },
        paused,
      },
      usage: { live, test: total('TEST'), generator: total('GENERATOR') },
      costPerReply: live.costUsd !== null && replies ? live.costUsd / replies : null,
      perAgent,
      topSources: top.map((r) => ({ name: r.name, uses: Number(r.uses) })),
      deliveries: {
        byStatus,
        payments: {
          created,
          confirmed: confirmed._count._all,
          revenueCents: confirmed._sum.amountCents ?? 0,
        },
        conversion: created ? confirmed._count._all / created : null,
      },
      daily,
    };
    return dto;
  });

  /** Saúde da IA: agentes, chave e créditos, serviços, filas, eventos e pendências. */
  app.get('/ai/health', auth, async () => {
    const [agents, pendingByAgent, errorEvents, cred] = await Promise.all([
      prisma.aiAgent.findMany({
        orderBy: { createdAt: 'asc' },
        include: { _count: { select: { accounts: true } } },
      }),
      prisma.aiDraft.groupBy({
        by: ['agentId'],
        where: { status: 'PENDING' },
        _count: { _all: true },
      }),
      prisma.aiAgentEvent.findMany({
        where: { level: 'error', agentId: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { agentId: true, message: true, createdAt: true },
      }),
      prisma.aiCredential.findUnique({ where: { provider: 'openrouter' } }),
    ]);

    // Créditos da OpenRouter (consulta externa, guardada por 5 minutos; falha não derruba a tela).
    let usageUsd: number | null = null;
    let limitUsd: number | null = null;
    if (cred && app.cipher) {
      const cached = app.redis ? await app.redis.get(KEYINFO_CACHE).catch(() => null) : null;
      if (cached)
        ({ usageUsd, limitUsd } = JSON.parse(cached) as {
          usageUsd: number | null;
          limitUsd: number | null;
        });
      else {
        try {
          const apiKey = app.cipher.decrypt(Buffer.from(cred.keyEnc), AI_KEY_AAD).toString('utf8');
          const info = await new OpenRouterClient({
            apiKey,
            fetchImpl: app.aiFetch,
            timeoutMs: 8000,
          }).keyInfo();
          usageUsd = info.usageUsd;
          limitUsd = info.limitUsd;
          if (app.redis)
            await app.redis
              .set(KEYINFO_CACHE, JSON.stringify({ usageUsd, limitUsd }), 'EX', 300)
              .catch(() => undefined);
        } catch {
          /* sem a consulta, a tela só não mostra o saldo */
        }
      }
    }
    const remainingUsd =
      limitUsd !== null && usageUsd !== null ? Math.max(0, limitUsd - usageUsd) : null;

    const hb = async (k: string) => !!(app.redis && (await app.redis.get(k).catch(() => null)));
    const services = {
      worker: await hb(HEARTBEAT_KEYS.worker),
      gateway: await hb(HEARTBEAT_KEYS.gateway),
    };
    const queues = app.systemQueues ? await app.systemQueues.aiCounts().catch(() => []) : [];

    const events = await prisma.aiAgentEvent.findMany({
      where: { level: { in: ['warn', 'error'] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { agent: { select: { name: true } } },
    });

    const week = new Date(Date.now() - 7 * 24 * 3_600_000);
    const [sourcesWithError, sourcesStuck, failed, blocked, claimed, minorLocksOpen] =
      await Promise.all([
        prisma.aiKnowledgeSource.count({ where: { status: 'ERROR' } }),
        prisma.aiKnowledgeSource.count({
          where: { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
        }),
        prisma.aiDelivery.count({ where: { status: 'FAILED', createdAt: { gte: week } } }),
        prisma.aiDelivery.count({ where: { status: 'BLOCKED', createdAt: { gte: week } } }),
        prisma.aiPayment.count({ where: { status: 'PENDING', claimedAt: { not: null } } }),
        prisma.aiConversationState.count({ where: { paused: true, pausedBy: 'minor' } }),
      ]);

    const agentsDto: AiHealthDTO['agents'] = agents.map((a) => {
      const err = errorEvents.find((e) => e.agentId === a.id);
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        mode: a.mode,
        accounts: a._count.accounts,
        pendingDrafts: pendingByAgent.find((p) => p.agentId === a.id)?._count._all ?? 0,
        lastError: err ? { message: err.message, at: err.createdAt.toISOString() } : null,
      };
    });

    const alerts: AiHealthAlert[] = [];
    const active = agents.some((a) => a.status === 'ACTIVE');
    for (const a of agents.filter((x) => x.status === 'ERROR'))
      alerts.push({
        level: 'error',
        text: `O agente "${a.name}" parou por erro. Corrija e ative de novo.`,
        href: `/ai/agentes/${a.id}`,
      });
    if (active && !cred)
      alerts.push({
        level: 'error',
        text: 'Há agente ativo, mas a chave da OpenRouter não está configurada.',
        href: '/ai/configuracoes',
      });
    if (cred?.lastTestOk === false)
      alerts.push({
        level: 'warning',
        text: 'O último teste da chave da OpenRouter falhou.',
        href: '/ai/configuracoes',
      });
    if (active && !services.worker)
      alerts.push({
        level: 'error',
        text: 'O worker não está respondendo: a IA não vai responder às mensagens.',
      });
    if (active && !services.gateway)
      alerts.push({
        level: 'error',
        text: 'O gateway não está respondendo: nenhuma mensagem é recebida nem enviada.',
      });
    if (remainingUsd !== null && limitUsd && remainingUsd < Math.max(1, limitUsd * 0.1))
      alerts.push({
        level: 'warning',
        text: `Créditos da OpenRouter acabando: restam US$ ${remainingUsd.toFixed(2)}.`,
        href: '/ai/configuracoes',
      });
    for (const qn of queues.filter((x) => x.failed > 0))
      alerts.push({ level: 'warning', text: `Fila "${qn.label}": ${qn.failed} job(s) com falha.` });
    for (const qn of queues.filter((x) => x.waiting > 20))
      alerts.push({
        level: 'warning',
        text: `Fila "${qn.label}" acumulando: ${qn.waiting} esperando.`,
      });
    if (sourcesWithError)
      alerts.push({
        level: 'warning',
        text: `${sourcesWithError} fonte(s) de conhecimento com erro.`,
        href: '/ai/conhecimento',
      });
    if (sourcesStuck)
      alerts.push({
        level: 'warning',
        text: `${sourcesStuck} fonte(s) de conhecimento presas em "processando".`,
        href: '/ai/conhecimento',
      });
    if (failed)
      alerts.push({
        level: 'warning',
        text: `${failed} entrega(s) falharam nos últimos 7 dias.`,
        href: '/ai/atendimentos',
      });
    if (claimed)
      alerts.push({
        level: 'warning',
        text: `${claimed} contato(s) dizem que pagaram: confira e confirme.`,
        href: '/ai/atendimentos',
      });
    if (minorLocksOpen)
      alerts.push({
        level: 'warning',
        text: `${minorLocksOpen} conversa(s) travada(s) por possível menor de idade.`,
        href: '/ai/atendimentos',
      });

    const dto: AiHealthDTO = {
      alerts,
      agents: agentsDto,
      key: {
        configured: !!cred,
        lastTestOk: cred?.lastTestOk ?? null,
        lastTestAt: cred?.lastTestAt?.toISOString() ?? null,
        usageUsd,
        limitUsd,
        remainingUsd,
      },
      services,
      queues: queues.map(({ name, label, waiting, active: act, delayed, failed: f }) => ({
        name,
        label,
        waiting,
        active: act,
        delayed,
        failed: f,
      })),
      events: events.map((e) => ({
        id: e.id,
        agentName: e.agent?.name ?? null,
        category: e.category,
        level: e.level,
        message: e.message,
        createdAt: e.createdAt.toISOString(),
      })),
      issues: {
        sourcesWithError,
        sourcesStuck,
        deliveriesFailed7d: failed,
        deliveriesBlocked7d: blocked,
        paymentsClaimed: claimed,
        minorLocksOpen,
      },
    };
    return dto;
  });
}
