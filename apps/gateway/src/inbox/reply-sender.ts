import type { PrismaClient } from '@multizap/database';
import { NotConnectedError, type SessionManager } from '../session/manager';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** Envia uma resposta escrita pelo administrador na Central de Mensagens. */
export class ReplySender {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly manager: SessionManager,
    private readonly log: Log = () => undefined,
  ) {}

  async send(messageId: string): Promise<void> {
    const msg = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });
    if (!msg || msg.status !== 'PENDING' || !msg.providerMessageId.startsWith('pending:')) return;
    // Reserva: apenas um processamento envia esta resposta.
    const claimed = await this.prisma.message.updateMany({
      where: { id: msg.id, status: 'PENDING', providerMessageId: msg.providerMessageId },
      data: { providerMessageId: `sending:${msg.id}` },
    });
    if (claimed.count !== 1) return;

    let result: { id: string; timestamp: number };
    try {
      result = await this.manager.send(msg.accountId, msg.conversation.remoteJid, {
        text: msg.body ?? '',
      });
    } catch (err) {
      await this.prisma.message.update({
        where: { id: msg.id },
        data: { status: 'FAILED', providerMessageId: `failed:${msg.id}` },
      });
      await this.prisma.messageEvent.create({
        data: {
          messageId: msg.id,
          accountId: msg.accountId,
          status: 'FAILED',
          occurredAt: new Date(),
          details: {
            error:
              err instanceof NotConnectedError
                ? 'Instância desconectada'
                : String(err).slice(0, 200),
          },
        },
      });
      this.log('Resposta não enviada', { messageId, err: String(err) });
      return;
    }

    const sentAt = new Date(result.timestamp * 1000);
    await this.prisma.$transaction(async (tx) => {
      // A própria sessão pode ter registrado o eco da mensagem antes desta transação.
      const echo = await tx.message.findUnique({
        where: {
          accountId_providerMessageId: { accountId: msg.accountId, providerMessageId: result.id },
        },
      });
      if (echo) {
        // Preserva a marca de "enviada pela IA" ao trocar a mensagem pendente pelo eco.
        await tx.aiMessageLink.updateMany({
          where: { messageId: msg.id },
          data: { messageId: echo.id },
        });
        await tx.message.delete({ where: { id: msg.id } });
        await tx.message.update({
          where: { id: echo.id },
          data: { body: msg.body, status: echo.status === 'RECEIVED' ? 'SENT' : echo.status },
        });
        await tx.messageEvent.create({
          data: {
            messageId: echo.id,
            accountId: msg.accountId,
            status: 'SENT',
            occurredAt: sentAt,
          },
        });
      } else {
        await tx.message.update({
          where: { id: msg.id },
          data: { providerMessageId: result.id, status: 'SENT', sentAt },
        });
        await tx.messageEvent.create({
          data: { messageId: msg.id, accountId: msg.accountId, status: 'SENT', occurredAt: sentAt },
        });
      }
      await tx.conversation.update({
        where: { id: msg.conversationId },
        data: {
          status: 'ANSWERED',
          lastMessageAt: sentAt,
          lastMessagePreview: (msg.body ?? '').slice(0, 120),
        },
      });
    });
  }
}
