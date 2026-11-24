import type {
  AccountStatus,
  NotificationCategory,
  NotificationSeverity,
  Prisma,
  PrismaClient,
} from '@multizap/database';

/** Erros esperados quando a instância foi excluída enquanto a sessão encerrava. */
function isMissingRecord(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'P2025' || code === 'P2003';
}

async function tolerant<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingRecord(err)) return undefined;
    throw err;
  }
}

/** Escritas duráveis do gateway: status, eventos e notificações. */
export class SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  setStatus(
    accountId: string,
    status: AccountStatus,
    reason: string | null,
    data: Prisma.AccountUpdateInput = {},
  ) {
    return tolerant(() =>
      this.prisma.account.update({
        where: { id: accountId },
        data: { status, statusReason: reason, ...data },
      }),
    );
  }

  event(accountId: string, type: string, message: string, details: Prisma.InputJsonValue = {}) {
    return tolerant(() =>
      this.prisma.connectionEvent.create({ data: { accountId, type, message, details } }),
    );
  }

  touch(accountId: string) {
    return tolerant(() =>
      this.prisma.account.update({
        where: { id: accountId },
        data: { lastActivityAt: new Date() },
      }),
    );
  }

  markPaired(accountId: string, info: { jid: string; deviceName?: string }) {
    return tolerant(() =>
      this.prisma.integration.upsert({
        where: { accountId },
        create: {
          accountId,
          provider: 'whatsapp-web',
          pairedAt: new Date(),
          waJid: info.jid,
          deviceName: info.deviceName,
          lastCheckAt: new Date(),
        },
        update: {
          pairedAt: new Date(),
          waJid: info.jid,
          deviceName: info.deviceName ?? null,
          lastError: null,
          lastCheckAt: new Date(),
        },
      }),
    );
  }

  markConnected(accountId: string, jid: string) {
    return tolerant(() =>
      this.prisma.integration.update({
        where: { accountId },
        data: { waJid: jid, lastError: null, lastCheckAt: new Date() },
      }),
    );
  }

  setLastError(accountId: string, error: string) {
    return tolerant(() =>
      this.prisma.integration.update({
        where: { accountId },
        data: { lastError: error.slice(0, 500), lastCheckAt: new Date() },
      }),
    );
  }

  /** Cria notificação, sem duplicar enquanto houver uma igual não resolvida. */
  async notify(n: {
    accountId: string;
    severity: NotificationSeverity;
    category: NotificationCategory;
    title: string;
    message: string;
    dedupeKey: string;
  }) {
    const existing = await this.prisma.systemNotification.findFirst({
      where: { dedupeKey: n.dedupeKey, resolvedAt: null },
    });
    if (existing) return existing;
    return tolerant(() => this.prisma.systemNotification.create({ data: n }));
  }

  /** Resolve as notificações de conexão pendentes quando a instância volta a funcionar. */
  resolveConnectionNotifications(accountId: string) {
    return this.prisma.systemNotification.updateMany({
      where: { accountId, category: 'CONNECTION', resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
  }
}
