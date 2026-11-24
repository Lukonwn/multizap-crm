import type { PrismaClient, Prisma } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Atualiza contadores e conclusão de uma campanha-filho e da principal.
 * Uma campanha-filho conclui quando não há destinatários pendentes (nem em envio).
 */
export async function refreshCampaignProgress(db: Db, campaignAccountId: string): Promise<void> {
  const groups = await db.campaignRecipient.groupBy({
    by: ['status'],
    where: { campaignAccountId },
    _count: { _all: true },
  });
  const count = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
  const total = groups.reduce((n, g) => n + g._count._all, 0);
  const sent = count('SENT') + count('DELIVERED') + count('READ');
  const child = await db.campaignAccount.update({
    where: { id: campaignAccountId },
    data: {
      totalRecipients: total,
      sentCount: sent,
      failedCount: count('FAILED'),
      skippedCount: count('SKIPPED'),
    },
    include: { campaign: true },
  });
  if (!['READY', 'RUNNING'].includes(child.status)) return;
  if (count('PENDING') === 0 && count('SENDING') === 0) {
    await db.campaignAccount.update({ where: { id: child.id }, data: { status: 'COMPLETED' } });
    const open = await db.campaignAccount.count({
      where: { campaignId: child.campaignId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    });
    if (open === 0 && ['READY', 'RUNNING'].includes(child.campaign.status)) {
      await db.campaign.update({
        where: { id: child.campaignId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    }
  }
}

export const MESSAGE_STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: -1,
  RECEIVED: 0,
};
