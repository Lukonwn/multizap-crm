import type { PrismaClient } from '@multizap/database';
import { addDays, computeDailyMetrics, storeDailyMetrics, todayIn } from '@multizap/database';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/**
 * Consolida métricas diárias (daily_metrics) dos dias já encerrados.
 * Recalcula os últimos dias a cada execução, pois confirmações de entrega e
 * leitura podem chegar depois do envio. O dia de hoje é sempre calculado ao vivo.
 */
export class MetricsRollup {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tz: string,
    private readonly log: Log = () => undefined,
  ) {}

  async run(recentDays = 7): Promise<number> {
    const yesterday = addDays(todayIn(this.tz), -1);
    const rows = await computeDailyMetrics(
      this.prisma,
      addDays(yesterday, -(recentDays - 1)),
      yesterday,
      this.tz,
    );
    await storeDailyMetrics(this.prisma, rows);
    return rows.length;
  }

  /** Preenche dias encerrados ainda não consolidados (desde o primeiro registro, até 400 dias). */
  async backfill(maxDays = 400): Promise<number> {
    const yesterday = addDays(todayIn(this.tz), -1);
    const first = await this.prisma.account.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    if (!first) return 0;
    const firstDay = todayIn(this.tz, first.createdAt);
    const from = [firstDay, addDays(yesterday, -(maxDays - 1))].sort().at(-1)!;
    if (from > yesterday) return 0;
    const rows = await computeDailyMetrics(this.prisma, from, yesterday, this.tz);
    const existing = new Set(
      (
        await this.prisma.dailyMetric.findMany({
          where: { date: { gte: new Date(`${from}T00:00:00Z`) } },
          select: { date: true, accountId: true },
        })
      ).map((d) => `${d.date.toISOString().slice(0, 10)}:${d.accountId}`),
    );
    const missing = rows.filter((r) => !existing.has(`${r.day}:${r.accountId}`));
    await storeDailyMetrics(this.prisma, missing);
    if (missing.length) this.log('Métricas consolidadas (backfill)', { rows: missing.length });
    return missing.length;
  }
}
