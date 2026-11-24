import type { PrismaClient } from '@multizap/database';
import { refreshCampaignProgress } from '@multizap/database';
import { SETTING_KEYS, buildCampaignMessage, e164Digits } from '@multizap/shared';
import type { StorageDriver } from '@multizap/storage';
import { streamToBuffer } from '@multizap/storage';
import { NotConnectedError, type SessionManager } from '../session/manager';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/**
 * Executa UM envio confirmado pelo administrador (campanha assistida).
 * Revalida tudo no momento do envio: estado da campanha, pausa global,
 * consentimento, descadastramento e conexão da instância.
 */
export class CampaignSender {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageDriver | null,
    private readonly manager: SessionManager,
    private readonly log: Log = () => undefined,
  ) {}

  async send(recipientId: string): Promise<void> {
    const r = await this.prisma.campaignRecipient.findUnique({
      where: { id: recipientId },
      include: {
        contact: true,
        campaignAccount: { include: { campaign: { include: { asset: true } } } },
      },
    });
    if (!r || r.status !== 'PENDING' || !r.confirmedAt) return;
    // Reserva atômica: apenas um processamento envia (protege contra jobs duplicados).
    const claimed = await this.prisma.campaignRecipient.updateMany({
      where: { id: r.id, status: 'PENDING', confirmedAt: { not: null } },
      data: { status: 'SENDING' },
    });
    if (claimed.count !== 1) return;
    const child = r.campaignAccount;
    const campaign = child.campaign;

    const unconfirm = (error: string) =>
      this.prisma.campaignRecipient.update({
        where: { id: r.id },
        data: { status: 'PENDING', confirmedAt: null, error },
      });

    if (
      !['READY', 'RUNNING'].includes(campaign.status) ||
      !['READY', 'RUNNING'].includes(child.status)
    ) {
      await unconfirm('Campanha pausada ou encerrada antes do envio.');
      return;
    }
    const paused = await this.prisma.systemSetting.findUnique({
      where: { key: SETTING_KEYS.operationsPaused },
    });
    if (paused?.value === true) {
      await unconfirm('Operações pausadas globalmente.');
      return;
    }

    const optOut = await this.prisma.optOut.findUnique({
      where: { accountId_phoneE164: { accountId: r.accountId, phoneE164: r.contact.phoneE164 } },
    });
    if (r.contact.optedOutAt || optOut || r.contact.consentStatus !== 'GRANTED') {
      await this.prisma.campaignRecipient.update({
        where: { id: r.id },
        data: {
          status: 'SKIPPED',
          error:
            r.contact.consentStatus !== 'GRANTED'
              ? 'Consentimento não está autorizado.'
              : 'Contato descadastrado.',
        },
      });
      await refreshCampaignProgress(this.prisma, child.id);
      return;
    }

    const body = child.body ?? campaign.body ?? '';
    const text = buildCampaignMessage(
      { body, linkUrl: child.linkUrl ?? campaign.linkUrl },
      r.contact,
    );
    const asset = campaign.asset;
    let image: Buffer | undefined;
    if (asset?.storageKey && this.storage)
      image = await streamToBuffer(await this.storage.get(asset.storageKey));
    const jid = `${e164Digits(r.contact.phoneE164)}@s.whatsapp.net`;

    let result: { id: string; timestamp: number };
    try {
      result = await this.manager.send(r.accountId, jid, {
        text,
        image,
        mimetype: asset?.mimeType ?? undefined,
      });
    } catch (err) {
      const message =
        err instanceof NotConnectedError
          ? 'Instância desconectada no momento do envio.'
          : `Falha no envio: ${String((err as Error).message ?? err).slice(0, 200)}`;
      await this.prisma.campaignRecipient.update({
        where: { id: r.id },
        data: { status: 'FAILED', error: message },
      });
      await refreshCampaignProgress(this.prisma, child.id);
      this.log('Envio falhou', { recipientId, error: message });
      return;
    }

    const sentAt = new Date(result.timestamp * 1000);
    await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.upsert({
        where: { accountId_remoteJid: { accountId: r.accountId, remoteJid: jid } },
        create: {
          accountId: r.accountId,
          contactId: r.contactId,
          remoteJid: jid,
          title: r.contact.name,
          lastMessageAt: sentAt,
          lastMessagePreview: text.slice(0, 120),
        },
        update: {
          contactId: r.contactId,
          lastMessageAt: sentAt,
          lastMessagePreview: text.slice(0, 120),
        },
      });
      const message = await tx.message.create({
        data: {
          accountId: r.accountId,
          conversationId: conversation.id,
          providerMessageId: result.id,
          direction: 'OUTBOUND',
          type: image ? 'image' : 'text',
          body: text,
          mediaKey: asset?.storageKey ?? null,
          status: 'SENT',
          campaignRecipientId: r.id,
          sentAt,
        },
      });
      await tx.messageEvent.create({
        data: { messageId: message.id, accountId: r.accountId, status: 'SENT', occurredAt: sentAt },
      });
      await tx.campaignRecipient.update({
        where: { id: r.id },
        data: { status: 'SENT', sentAt, error: null },
      });
      if (child.status === 'READY')
        await tx.campaignAccount.update({ where: { id: child.id }, data: { status: 'RUNNING' } });
      if (campaign.status === 'READY')
        await tx.campaign.update({
          where: { id: campaign.id },
          data: { status: 'RUNNING', startedAt: campaign.startedAt ?? new Date() },
        });
      await refreshCampaignProgress(tx, child.id);
    });
    this.log('Mensagem enviada', { recipientId, providerMessageId: result.id });
  }

  /**
   * Após um reinício, envios interrompidos no meio (status SENDING) não podem
   * ser confirmados nem repetidos às cegas: marca como falha e orienta conferir.
   */
  async recoverInterrupted(olderThanMs = 60_000): Promise<number> {
    const stuck = await this.prisma.campaignRecipient.findMany({
      where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - olderThanMs) } },
      select: { id: true, campaignAccountId: true },
    });
    for (const s of stuck) {
      await this.prisma.campaignRecipient.update({
        where: { id: s.id },
        data: {
          status: 'FAILED',
          error: 'Envio interrompido por reinício. Confira no celular antes de tentar novamente.',
        },
      });
      await refreshCampaignProgress(this.prisma, s.campaignAccountId);
    }
    return stuck.length;
  }
}
