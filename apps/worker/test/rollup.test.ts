import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, createPrisma, todayIn, type PrismaClient } from '@multizap/database';
import { MetricsRollup } from '../src/metrics/rollup';

const prisma: PrismaClient = createPrisma(process.env.TEST_DATABASE_URL!);
const TZ = 'America/Sao_Paulo';
afterAll(() => prisma.$disconnect());

beforeEach(async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
});

describe('consolidação de métricas', () => {
  it('backfill preenche os dias encerrados desde a primeira instância e é idempotente', async () => {
    const created = new Date(Date.now() - 5 * 86_400_000);
    const a = await prisma.account.create({
      data: { name: 'A', connectionType: 'WHATSAPP_WEB', createdAt: created },
    });
    await prisma.contact.create({
      data: {
        accountId: a.id,
        phoneE164: '+5511900000001',
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      },
    });
    const rollup = new MetricsRollup(prisma, TZ);
    const n = await rollup.backfill();
    const yesterday = addDays(todayIn(TZ), -1);
    const first = todayIn(TZ, created);
    const expectedDays = Math.round((Date.parse(yesterday) - Date.parse(first)) / 86_400_000) + 1;
    expect(n).toBe(expectedDays);
    expect(await rollup.backfill()).toBe(0);
    // hoje nunca é consolidado (sempre calculado ao vivo)
    expect(
      await prisma.dailyMetric.count({ where: { date: new Date(`${todayIn(TZ)}T00:00:00Z`) } }),
    ).toBe(0);
    const total = await prisma.dailyMetric.aggregate({ _sum: { contactsCreated: true } });
    expect(total._sum.contactsCreated).toBe(1);
  });

  it('run recalcula os últimos dias (confirmações tardias de leitura)', async () => {
    const a = await prisma.account.create({
      data: {
        name: 'A',
        connectionType: 'WHATSAPP_WEB',
        createdAt: new Date(Date.now() - 3 * 86_400_000),
      },
    });
    const conv = await prisma.conversation.create({
      data: { accountId: a.id, remoteJid: '1@s.whatsapp.net' },
    });
    const yesterdayNoon = new Date(`${addDays(todayIn(TZ), -1)}T15:00:00Z`);
    const m = await prisma.message.create({
      data: {
        accountId: a.id,
        conversationId: conv.id,
        providerMessageId: 'x',
        direction: 'OUTBOUND',
        status: 'SENT',
        sentAt: yesterdayNoon,
      },
    });
    const rollup = new MetricsRollup(prisma, TZ);
    await rollup.run();
    expect(
      (await prisma.dailyMetric.findFirstOrThrow({ where: { messagesSent: 1 } })).messagesRead,
    ).toBe(0);
    await prisma.message.update({ where: { id: m.id }, data: { status: 'READ' } });
    await rollup.run();
    expect(
      (await prisma.dailyMetric.findFirstOrThrow({ where: { messagesSent: 1 } })).messagesRead,
    ).toBe(1);
  });

  it('rejeita fuso horário inválido', async () => {
    const { assertTimezone } = await import('@multizap/database');
    expect(() => assertTimezone("America/Sao_Paulo'; DROP TABLE x;--")).toThrow();
    expect(() => assertTimezone('Marte/Base')).toThrow();
    expect(assertTimezone('America/Sao_Paulo')).toBe('America/Sao_Paulo');
  });
});
