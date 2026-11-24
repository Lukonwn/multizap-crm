import { Prisma, type PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Métricas de um dia (no fuso dos relatórios) para uma instância. */
export interface DailyMetricRow {
  day: string; // YYYY-MM-DD
  accountId: string;
  contactsCreated: number;
  consentsGranted: number;
  optOuts: number;
  campaignsCreated: number;
  campaignsCompleted: number;
  messagesSent: number;
  messagesDelivered: number;
  messagesRead: number;
  messagesFailed: number;
  messagesReceived: number;
}

/** Data de hoje (YYYY-MM-DD) no fuso informado. */
export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Garante um nome de fuso IANA válido (usado dentro do SQL). */
export function assertTimezone(tz: string): string {
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) throw new Error(`Fuso horário inválido: ${tz}`);
  new Intl.DateTimeFormat('en-US', { timeZone: tz }); // lança RangeError se não existir
  return tz;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Calcula as métricas diárias diretamente das tabelas de origem (dados reais).
 *
 * Definições:
 *  - enviadas: mensagens de saída efetivamente aceitas pelo WhatsApp (dia do envio);
 *  - entregues / lidas: das enviadas no dia, quantas estão entregues/lidas (coorte);
 *  - falhas: envios de campanha com falha + respostas com falha;
 *  - recebidas: mensagens de entrada (respostas dos contatos);
 *  - contatos, consentimentos e descadastros: pelo dia do registro.
 * Os timestamps são gravados em UTC e convertidos para o fuso `tz`.
 */
export async function computeDailyMetrics(db: Db, from: string, to: string, tz: string): Promise<DailyMetricRow[]> {
  assertTimezone(tz);
  const lo = Prisma.sql`((${from}::date)::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`;
  const hi = Prisma.sql`(((${to}::date + 1))::timestamp AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`;
  const day = (col: string) => Prisma.raw(`((${col} AT TIME ZONE 'UTC') AT TIME ZONE '${tz}')::date`);

  const rows = await db.$queryRaw<
    {
      day: Date;
      account_id: string;
      contacts_created: bigint;
      consents_granted: bigint;
      opt_outs: bigint;
      campaigns_created: bigint;
      campaigns_completed: bigint;
      messages_sent: bigint;
      messages_delivered: bigint;
      messages_read: bigint;
      messages_failed: bigint;
      messages_received: bigint;
    }[]
  >`
    WITH grid AS (
      SELECT d::date AS day, a.id AS account_id
      FROM generate_series(${from}::date, ${to}::date, interval '1 day') d CROSS JOIN accounts a
    ),
    c AS (SELECT account_id, ${day('created_at')} AS day, count(*) n FROM contacts WHERE created_at >= ${lo} AND created_at < ${hi} GROUP BY 1, 2),
    ce AS (SELECT account_id, ${day('created_at')} AS day, count(*) n FROM consent_events WHERE action = 'GRANTED' AND created_at >= ${lo} AND created_at < ${hi} GROUP BY 1, 2),
    oo AS (SELECT account_id, ${day('created_at')} AS day, count(*) n FROM opt_outs WHERE created_at >= ${lo} AND created_at < ${hi} GROUP BY 1, 2),
    cc AS (SELECT account_id, ${day('created_at')} AS day, count(*) n FROM campaign_accounts WHERE created_at >= ${lo} AND created_at < ${hi} GROUP BY 1, 2),
    cd AS (
      SELECT ca.account_id, ${day('c.completed_at')} AS day, count(*) n
      FROM campaigns c JOIN campaign_accounts ca ON ca.campaign_id = c.id
      WHERE c.status = 'COMPLETED' AND c.completed_at >= ${lo} AND c.completed_at < ${hi} GROUP BY 1, 2
    ),
    mo AS (
      SELECT account_id, ${day('sent_at')} AS day,
        count(*) FILTER (WHERE status IN ('SENT', 'DELIVERED', 'READ')) sent,
        count(*) FILTER (WHERE status IN ('DELIVERED', 'READ')) delivered,
        count(*) FILTER (WHERE status = 'READ') read,
        count(*) FILTER (WHERE status = 'FAILED' AND campaign_recipient_id IS NULL) failed
      FROM messages WHERE direction = 'OUTBOUND' AND sent_at >= ${lo} AND sent_at < ${hi} GROUP BY 1, 2
    ),
    mi AS (SELECT account_id, ${day('sent_at')} AS day, count(*) n FROM messages WHERE direction = 'INBOUND' AND sent_at >= ${lo} AND sent_at < ${hi} GROUP BY 1, 2),
    rf AS (SELECT account_id, ${day('updated_at')} AS day, count(*) n FROM campaign_recipients WHERE status = 'FAILED' AND updated_at >= ${lo} AND updated_at < ${hi} GROUP BY 1, 2)
    SELECT g.day, g.account_id,
      coalesce(c.n, 0) contacts_created, coalesce(ce.n, 0) consents_granted, coalesce(oo.n, 0) opt_outs,
      coalesce(cc.n, 0) campaigns_created, coalesce(cd.n, 0) campaigns_completed,
      coalesce(mo.sent, 0) messages_sent, coalesce(mo.delivered, 0) messages_delivered, coalesce(mo.read, 0) messages_read,
      coalesce(mo.failed, 0) + coalesce(rf.n, 0) messages_failed, coalesce(mi.n, 0) messages_received
    FROM grid g
    LEFT JOIN c ON c.account_id = g.account_id AND c.day = g.day
    LEFT JOIN ce ON ce.account_id = g.account_id AND ce.day = g.day
    LEFT JOIN oo ON oo.account_id = g.account_id AND oo.day = g.day
    LEFT JOIN cc ON cc.account_id = g.account_id AND cc.day = g.day
    LEFT JOIN cd ON cd.account_id = g.account_id AND cd.day = g.day
    LEFT JOIN mo ON mo.account_id = g.account_id AND mo.day = g.day
    LEFT JOIN mi ON mi.account_id = g.account_id AND mi.day = g.day
    LEFT JOIN rf ON rf.account_id = g.account_id AND rf.day = g.day
    ORDER BY g.day, g.account_id`;

  return rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    accountId: r.account_id,
    contactsCreated: Number(r.contacts_created),
    consentsGranted: Number(r.consents_granted),
    optOuts: Number(r.opt_outs),
    campaignsCreated: Number(r.campaigns_created),
    campaignsCompleted: Number(r.campaigns_completed),
    messagesSent: Number(r.messages_sent),
    messagesDelivered: Number(r.messages_delivered),
    messagesRead: Number(r.messages_read),
    messagesFailed: Number(r.messages_failed),
    messagesReceived: Number(r.messages_received),
  }));
}

/** Grava (upsert) as métricas consolidadas em daily_metrics. */
export async function storeDailyMetrics(db: PrismaClient, rows: DailyMetricRow[]): Promise<void> {
  const ops = rows.map((r) => {
    const { day, accountId, ...data } = r;
    const date = new Date(`${day}T00:00:00Z`);
    return db.dailyMetric.upsert({
      where: { date_accountId: { date, accountId } },
      create: { date, accountId, ...data },
      update: data,
    });
  });
  for (let i = 0; i < ops.length; i += 200) await db.$transaction(ops.slice(i, i + 200));
}

/**
 * Métricas de um intervalo: usa daily_metrics para dias já consolidados
 * (anteriores a hoje) e calcula ao vivo o restante. Se faltar algum dia
 * consolidado, calcula o intervalo inteiro ao vivo (sempre correto).
 */
export async function loadDailyMetrics(db: PrismaClient, from: string, to: string, tz: string): Promise<DailyMetricRow[]> {
  const today = todayIn(tz);
  const closedTo = to < today ? to : addDays(today, -1);
  if (closedTo < from) return computeDailyMetrics(db, from, to, tz);

  const [stored, accounts] = await Promise.all([
    db.dailyMetric.findMany({ where: { date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${closedTo}T00:00:00Z`) } } }),
    db.account.count(),
  ]);
  const expected = daysBetween(from, closedTo) * accounts;
  if (stored.length < expected) return computeDailyMetrics(db, from, to, tz);

  const live = to >= today ? await computeDailyMetrics(db, today, to, tz) : [];
  return [
    ...stored.map((s) => ({
      day: s.date.toISOString().slice(0, 10),
      accountId: s.accountId,
      contactsCreated: s.contactsCreated,
      consentsGranted: s.consentsGranted,
      optOuts: s.optOuts,
      campaignsCreated: s.campaignsCreated,
      campaignsCompleted: s.campaignsCompleted,
      messagesSent: s.messagesSent,
      messagesDelivered: s.messagesDelivered,
      messagesRead: s.messagesRead,
      messagesFailed: s.messagesFailed,
      messagesReceived: s.messagesReceived,
    })),
    ...live,
  ];
}
