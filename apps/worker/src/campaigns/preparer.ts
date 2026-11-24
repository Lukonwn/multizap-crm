import type { Prisma, PrismaClient } from '@multizap/database';
import { refreshCampaignProgress } from '@multizap/database';

type Log = (msg: string, extra?: Record<string, unknown>) => void;
const BATCH = 2000;

/**
 * Monta a fila de uma campanha assistida: um destinatário por contato ELEGÍVEL
 * de cada instância (consentimento autorizado, não descadastrado, filtro de
 * etiquetas da instância). Nenhuma mensagem é enviada aqui.
 */
export class CampaignPreparer {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: Log = () => undefined,
  ) {}

  async prepare(campaignId: string): Promise<void> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { accounts: true },
    });
    if (!campaign || campaign.status !== 'SCHEDULED') return;

    let total = 0;
    for (const child of campaign.accounts) {
      if (child.status === 'CANCELLED') continue;
      const tagIds = ((child.audience ?? {}) as { tagIds?: string[] }).tagIds ?? [];
      const optOuts = new Set(
        (
          await this.prisma.optOut.findMany({
            where: { accountId: child.accountId },
            select: { phoneE164: true },
          })
        ).map((o) => o.phoneE164),
      );
      const where: Prisma.ContactWhereInput = {
        accountId: child.accountId,
        consentStatus: 'GRANTED',
        optedOutAt: null,
        ...(tagIds.length && { tags: { some: { tagId: { in: tagIds } } } }),
      };
      let cursor: string | undefined;
      for (;;) {
        const contacts = await this.prisma.contact.findMany({
          where,
          select: { id: true, phoneE164: true },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        });
        if (!contacts.length) break;
        const data = contacts
          .filter((c) => !optOuts.has(c.phoneE164))
          .map((c) => ({
            campaignAccountId: child.id,
            accountId: child.accountId,
            contactId: c.id,
            phoneE164: c.phoneE164,
          }));
        if (data.length)
          total += (await this.prisma.campaignRecipient.createMany({ data, skipDuplicates: true }))
            .count;
        cursor = contacts[contacts.length - 1]!.id;
      }
      await this.prisma.campaignAccount.update({
        where: { id: child.id },
        data: { status: 'READY' },
      });
      await refreshCampaignProgress(this.prisma, child.id);
    }

    const updated = await this.prisma.campaign.updateMany({
      where: { id: campaignId, status: 'SCHEDULED' },
      data: { status: 'READY' },
    });
    if (!updated.count) return;
    // Filhos sem destinatários já concluíram: se todos concluíram, a principal também.
    const open = await this.prisma.campaignAccount.count({
      where: { campaignId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    });
    if (open === 0) {
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    }

    const recipients = await this.prisma.campaignRecipient.count({
      where: { campaignAccount: { campaignId } },
    });
    await this.prisma.systemNotification.create({
      data: {
        severity: 'INFO',
        category: 'PROCESSING',
        title: 'Campanha pronta para envio assistido',
        message: `"${campaign.name}": ${recipients} destinatário(s) elegível(is) na fila. Os envios dependem da sua confirmação.`,
        dedupeKey: `campaign:${campaignId}:ready`,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        action: 'campaign.prepared',
        entityType: 'campaign',
        entityId: campaignId,
        details: { recipients, added: total },
      },
    });
    this.log('Campanha preparada', { campaignId, recipients });
  }

  /** Campanhas agendadas cujo horário chegou (verificado a cada minuto). */
  async due(): Promise<string[]> {
    const rows = await this.prisma.campaign.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
