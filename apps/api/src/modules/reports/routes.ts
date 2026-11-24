import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma, addDays, daysBetween, loadDailyMetrics, type DailyMetricRow } from '@multizap/database';
import { writerToStream } from '@multizap/files';
import {
  REPORT_METRIC_LABEL,
  reportQuerySchema,
  type ReportCampaignRow,
  type ReportDTO,
  type ReportQuery,
  type ReportTotals,
} from '@multizap/shared';
import { parse } from '../../lib/validate';

const KEYS = Object.keys(REPORT_METRIC_LABEL) as (keyof ReportTotals)[];
const zero = (): ReportTotals => Object.fromEntries(KEYS.map((k) => [k, 0])) as unknown as ReportTotals;

function sumRows(rows: DailyMetricRow[]): ReportTotals {
  const t = zero();
  for (const r of rows) for (const k of KEYS) if (k !== 'campaignsCreated' && k !== 'campaignsCompleted') t[k] += r[k];
  return t;
}

/** Campanhas são globais: contadas uma vez (não por instância). */
async function campaignCounts(app: FastifyInstance, q: ReportQuery, tz: string) {
  const lo = Prisma.sql`((${q.from}::date)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`;
  const hi = Prisma.sql`(((${q.to}::date + 1))::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`;
  const byAccount = q.accountId
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM campaign_accounts ca WHERE ca.campaign_id = c.id AND ca.account_id = ${q.accountId}::uuid)`
    : Prisma.empty;
  const [r] = await app.prisma.$queryRaw<{ created: bigint; completed: bigint }[]>`
    SELECT
      count(*) FILTER (WHERE c.created_at >= ${lo} AND c.created_at < ${hi}) created,
      count(*) FILTER (WHERE c.status = 'COMPLETED' AND c.completed_at >= ${lo} AND c.completed_at < ${hi}) completed
    FROM campaigns c WHERE true ${byAccount}`;
  return { campaignsCreated: Number(r?.created ?? 0), campaignsCompleted: Number(r?.completed ?? 0) };
}

/** Desempenho das campanhas com envios no período (respostas: mensagem recebida até 7 dias após o envio). */
async function campaignRows(app: FastifyInstance, q: ReportQuery, tz: string): Promise<ReportCampaignRow[]> {
  const lo = Prisma.sql`((${q.from}::date)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`;
  const hi = Prisma.sql`(((${q.to}::date + 1))::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`;
  const acc = q.accountId ? Prisma.sql`AND r.account_id = ${q.accountId}::uuid` : Prisma.empty;
  const rows = await app.prisma.$queryRaw<
    { id: string; name: string; status: string; recipients: bigint; sent: bigint; delivered: bigint; read: bigint; failed: bigint; skipped: bigint; replied: bigint }[]
  >`
    SELECT c.id, c.name, c.status::text AS status,
      count(r.id) recipients,
      count(r.id) FILTER (WHERE r.status IN ('SENT', 'DELIVERED', 'READ')) sent,
      count(r.id) FILTER (WHERE r.status IN ('DELIVERED', 'READ')) delivered,
      count(r.id) FILTER (WHERE r.status = 'READ') read,
      count(r.id) FILTER (WHERE r.status = 'FAILED') failed,
      count(r.id) FILTER (WHERE r.status = 'SKIPPED') skipped,
      count(r.id) FILTER (WHERE EXISTS (
        SELECT 1 FROM messages m JOIN messages om ON om.conversation_id = m.conversation_id
        WHERE om.campaign_recipient_id = r.id AND m.direction = 'INBOUND'
          AND m.sent_at > r.sent_at AND m.sent_at <= r.sent_at + interval '7 days'
      )) replied
    FROM campaigns c
    JOIN campaign_accounts ca ON ca.campaign_id = c.id
    JOIN campaign_recipients r ON r.campaign_account_id = ca.id
    WHERE EXISTS (
      SELECT 1 FROM campaign_recipients r2 JOIN campaign_accounts ca2 ON ca2.id = r2.campaign_account_id
      WHERE ca2.campaign_id = c.id AND r2.sent_at >= ${lo} AND r2.sent_at < ${hi}
    ) ${acc}
    GROUP BY c.id, c.name, c.status
    ORDER BY max(r.sent_at) DESC NULLS LAST
    LIMIT 100`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    recipients: Number(r.recipients),
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    read: Number(r.read),
    failed: Number(r.failed),
    skipped: Number(r.skipped),
    replied: Number(r.replied),
  }));
}

export async function reportRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };
  const tz = app.config.reportsTimezone;

  const load = async (q: ReportQuery) => {
    const rows = (await loadDailyMetrics(prisma, q.from, q.to, tz)).filter((r) => !q.accountId || r.accountId === q.accountId);
    return rows;
  };

  app.get('/reports/summary', auth, async (req): Promise<ReportDTO> => {
    const q = parse(reportQuerySchema, req.query);
    const len = daysBetween(q.from, q.to);
    const prev: ReportQuery = { ...q, from: addDays(q.from, -len), to: addDays(q.from, -1) };

    const [rows, prevRows, campaigns, prevCampaigns, accounts] = await Promise.all([
      load(q),
      load(prev),
      campaignCounts(app, q, tz),
      campaignCounts(app, prev, tz),
      prisma.account.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    const contactWhere = q.accountId ? { accountId: q.accountId } : {};
    const [contacts, authorized, optedOut, campaignTable] = await Promise.all([
      prisma.contact.count({ where: contactWhere }),
      prisma.contact.count({ where: { ...contactWhere, consentStatus: 'GRANTED', optedOutAt: null } }),
      prisma.contact.count({ where: { ...contactWhere, optedOutAt: { not: null } } }),
      campaignRows(app, q, tz),
    ]);

    const seriesMap = new Map<string, ReportDTO['series'][number]>();
    for (let i = 0; i < len; i++) {
      const date = addDays(q.from, i);
      seriesMap.set(date, { date, sent: 0, delivered: 0, read: 0, received: 0, failed: 0 });
    }
    for (const r of rows) {
      const p = seriesMap.get(r.day);
      if (!p) continue;
      p.sent += r.messagesSent;
      p.delivered += r.messagesDelivered;
      p.read += r.messagesRead;
      p.received += r.messagesReceived;
      p.failed += r.messagesFailed;
    }

    const byAccount = accounts
      .filter((a) => !q.accountId || a.id === q.accountId)
      .map((a) => {
        const accRows = rows.filter((r) => r.accountId === a.id);
        const t = sumRows(accRows);
        t.campaignsCreated = accRows.reduce((n, r) => n + r.campaignsCreated, 0);
        t.campaignsCompleted = accRows.reduce((n, r) => n + r.campaignsCompleted, 0);
        return { accountId: a.id, accountName: a.name, ...t };
      });

    return {
      range: { from: q.from, to: q.to },
      previousRange: { from: prev.from, to: prev.to },
      timezone: tz,
      totals: { ...sumRows(rows), ...campaigns },
      previous: { ...sumRows(prevRows), ...prevCampaigns },
      snapshot: { contacts, authorized, optedOut },
      series: [...seriesMap.values()],
      byAccount,
      campaigns: campaignTable,
    };
  });

  /** Exportação: uma linha por dia e instância, com totais. */
  app.get('/reports/export', auth, async (req, reply) => {
    const { format, ...rest } = parse(z.object({ format: z.enum(['csv', 'xlsx']).default('csv') }).passthrough(), req.query);
    const q = parse(reportQuerySchema, rest);
    const rows = await load(q);
    const names = new Map((await prisma.account.findMany({ select: { id: true, name: true } })).map((a) => [a.id, a.name]));
    const cols = KEYS.filter((k) => k !== 'campaignsCreated' && k !== 'campaignsCompleted');
    const { writer, stream } = writerToStream(format);
    reply
      .header('content-type', format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="relatorio-${q.from}-a-${q.to}.${format}"`)
      .header('cache-control', 'no-store');
    void (async () => {
      try {
        await writer.write(['data', 'instancia', ...cols.map((k) => REPORT_METRIC_LABEL[k])]);
        for (const r of rows) await writer.write([r.day, names.get(r.accountId) ?? r.accountId, ...cols.map((k) => r[k])]);
        const t = sumRows(rows);
        await writer.write(['TOTAL', q.accountId ? (names.get(q.accountId) ?? '') : 'Todas as instâncias', ...cols.map((k) => t[k])]);
        await writer.end();
      } catch (err) {
        req.log.error({ err }, 'Falha na exportação do relatório');
        stream.destroy(err as Error);
      }
    })();
    return reply.send(stream);
  });
}
