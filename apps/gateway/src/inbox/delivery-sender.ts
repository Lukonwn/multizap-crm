import type { PrismaClient } from '@multizap/database';
import { isOperationsPaused, notify } from '@multizap/database';
import type { StorageDriver } from '@multizap/storage';
import { streamToBuffer } from '@multizap/storage';
import { NotConnectedError, type SessionManager } from '../session/manager';
import type { OutgoingMessage } from '../session/types';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** Tipo de mensagem do WhatsApp para o tipo do arquivo. */
function mediaKind(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Envia ao contato um item entregável já liberado (aprovação e pagamento conferidos antes).
 * Por segurança, TUDO é conferido de novo na hora do envio: o que vale é o estado de agora.
 */
export class DeliverySender {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageDriver | null,
    private readonly manager: SessionManager,
    private readonly log: Log = () => undefined,
  ) {}

  private async finish(id: string, status: 'FAILED' | 'BLOCKED' | 'QUEUED', reason: string) {
    const d = await this.prisma.aiDelivery.update({
      where: { id },
      data: { status, reason: reason.slice(0, 300) },
      include: { conversation: { select: { accountId: true, title: true, phoneE164: true } } },
    });
    if (status !== 'QUEUED')
      await notify(this.prisma, {
        severity: 'WARNING',
        category: 'PROCESSING',
        title: status === 'FAILED' ? 'Entrega não enviada' : 'Entrega bloqueada',
        message: `${d.itemName} para ${d.conversation.title ?? d.conversation.phoneE164 ?? 'contato'}: ${reason}`,
        accountId: d.conversation.accountId,
        dedupeKey: `ai-delivery:${id}`,
      });
    return d;
  }

  async send(deliveryId: string): Promise<void> {
    const { prisma } = this;
    // Reserva: só um envio por entrega, e só se ela está liberada (na fila).
    const claimed = await prisma.aiDelivery.updateMany({
      where: { id: deliveryId, status: 'QUEUED' },
      data: { status: 'SENDING' },
    });
    if (claimed.count !== 1) return;

    const d = await prisma.aiDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: {
        deliverable: { include: { asset: true } },
        conversation: { include: { account: true, contact: true, aiState: true } },
      },
    });
    const conv = d.conversation;
    const item = d.deliverable;
    try {
      if (!item || !item.enabled)
        return void (await this.finish(d.id, 'BLOCKED', 'Item desligado ou excluído.'));
      if (await isOperationsPaused(prisma))
        return void (await this.finish(
          d.id,
          'QUEUED',
          'Operações pausadas: tentará de novo quando retomar.',
        ));
      if (conv.aiState?.paused && conv.aiState.pausedBy === 'minor')
        return void (await this.finish(
          d.id,
          'BLOCKED',
          'Conversa travada por sinal de menor de idade.',
        ));
      if (item.adultOnly) {
        const agent = d.agentId
          ? await prisma.aiAgent.findUnique({ where: { id: d.agentId }, select: { ageGate: true } })
          : null;
        if (!agent?.ageGate || !conv.aiState?.ageConfirmedAt)
          return void (await this.finish(
            d.id,
            'BLOCKED',
            'Item adulto sem a confirmação de 18 anos nesta conversa.',
          ));
      }
      // Descadastrado só recebe se escrever de novo depois do pedido (igual às respostas manuais).
      const phone = conv.contact?.phoneE164 ?? conv.phoneE164;
      const optOut = phone
        ? await prisma.optOut.findUnique({
            where: { accountId_phoneE164: { accountId: conv.accountId, phoneE164: phone } },
            select: { createdAt: true },
          })
        : null;
      const optedOutAt = conv.contact?.optedOutAt ?? optOut?.createdAt ?? null;
      if (optedOutAt) {
        const after = await prisma.message.count({
          where: { conversationId: conv.id, direction: 'INBOUND', sentAt: { gt: optedOutAt } },
        });
        if (!after)
          return void (await this.finish(d.id, 'BLOCKED', 'O contato pediu descadastramento.'));
      }
      if (conv.account.disabledAt || conv.account.status !== 'CONNECTED')
        return void (await this.finish(d.id, 'FAILED', 'A instância não está conectada.'));

      // Conteúdo.
      let out: OutgoingMessage;
      let type = 'text';
      let body: string = item.text ?? '';
      let mediaKey: string | null = null;
      if (item.kind === 'FILE') {
        const asset = item.asset;
        if (!asset?.storageKey || !this.storage)
          return void (await this.finish(d.id, 'FAILED', 'Arquivo indisponível na biblioteca.'));
        const mime = asset.mimeType ?? 'application/octet-stream';
        const kind = mediaKind(mime);
        const data = await streamToBuffer(await this.storage.get(asset.storageKey));
        out = {
          text: item.text ?? '',
          media: { kind, data, mimetype: mime, fileName: asset.name },
        };
        type = kind;
        body = item.text || asset.name;
        if (kind === 'image' || kind === 'audio') mediaKey = asset.storageKey;
      } else {
        out = { text: item.text ?? '' };
      }

      const result = await this.manager.send(conv.accountId, conv.remoteJid, out);
      const sentAt = new Date(result.timestamp * 1000);
      const messageId = await prisma.$transaction(async (tx) => {
        // A própria sessão pode ter registrado o eco antes desta transação.
        const echo = await tx.message.findUnique({
          where: {
            accountId_providerMessageId: {
              accountId: conv.accountId,
              providerMessageId: result.id,
            },
          },
        });
        const msg = echo
          ? await tx.message.update({ where: { id: echo.id }, data: { type, body, mediaKey } })
          : await tx.message.create({
              data: {
                accountId: conv.accountId,
                conversationId: conv.id,
                providerMessageId: result.id,
                direction: 'OUTBOUND',
                type,
                body,
                mediaKey,
                status: 'SENT',
                sentAt,
              },
            });
        if (d.agentId)
          await tx.aiMessageLink.upsert({
            where: { messageId: msg.id },
            create: { messageId: msg.id, agentId: d.agentId, source: 'delivery' },
            update: {},
          });
        await tx.messageEvent.create({
          data: {
            messageId: msg.id,
            accountId: conv.accountId,
            status: 'SENT',
            occurredAt: sentAt,
          },
        });
        await tx.conversation.update({
          where: { id: conv.id },
          data: {
            status: 'ANSWERED',
            lastMessageAt: sentAt,
            lastMessagePreview: (type === 'text' ? body : `📎 ${item.name}`).slice(0, 120),
          },
        });
        await tx.aiDelivery.update({
          where: { id: d.id },
          data: { status: 'SENT', reason: null, messageId: msg.id, sentAt },
        });
        return msg.id;
      });
      this.log('Entrega enviada', { deliveryId, messageId });
    } catch (err) {
      const reason =
        err instanceof NotConnectedError
          ? 'A instância não está conectada.'
          : `Falha no envio: ${String(err).slice(0, 160)}`;
      this.log('Entrega não enviada', { deliveryId, err: String(err) });
      await this.finish(d.id, 'FAILED', reason);
    }
  }
}
