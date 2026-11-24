import type {
  NotificationCategory,
  NotificationSeverity,
  Prisma,
  PrismaClient,
} from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export const OPERATIONS_PAUSED_KEY = 'operations_paused';

export interface OperationsPause {
  paused: boolean;
  reason: string | null;
  at: string | null;
  by: string | null;
}

/** Estado da pausa global. Aceita o formato antigo (valor booleano). */
export async function getOperationsPause(db: Db): Promise<OperationsPause> {
  const row = await db.systemSetting.findUnique({ where: { key: OPERATIONS_PAUSED_KEY } });
  const v = row?.value as unknown;
  if (v === true) return { paused: true, reason: null, at: row!.updatedAt.toISOString(), by: null };
  if (v && typeof v === 'object' && (v as OperationsPause).paused === true) {
    const o = v as Partial<OperationsPause>;
    return {
      paused: true,
      reason: o.reason ?? null,
      at: o.at ?? row!.updatedAt.toISOString(),
      by: o.by ?? null,
    };
  }
  return { paused: false, reason: null, at: null, by: null };
}

export async function isOperationsPaused(db: Db): Promise<boolean> {
  return (await getOperationsPause(db)).paused;
}

export async function setOperationsPause(
  db: Db,
  paused: boolean,
  info: { reason?: string | null; by?: string | null } = {},
): Promise<OperationsPause> {
  const value: OperationsPause = paused
    ? {
        paused: true,
        reason: info.reason ?? null,
        at: new Date().toISOString(),
        by: info.by ?? null,
      }
    : { paused: false, reason: null, at: null, by: null };
  await db.systemSetting.upsert({
    where: { key: OPERATIONS_PAUSED_KEY },
    create: { key: OPERATIONS_PAUSED_KEY, value: value as unknown as Prisma.InputJsonValue },
    update: { value: value as unknown as Prisma.InputJsonValue },
  });
  return value;
}

export interface NotifyInput {
  severity: NotificationSeverity;
  category: NotificationCategory;
  title: string;
  message: string;
  accountId?: string | null;
  /** Evita duplicar enquanto houver uma notificação igual não resolvida. */
  dedupeKey?: string;
}

/** Cria uma notificação do sistema (sem duplicar pela dedupeKey). Nunca lança. */
export async function notify(db: Db, n: NotifyInput): Promise<void> {
  try {
    if (n.dedupeKey) {
      const existing = await db.systemNotification.findFirst({
        where: { dedupeKey: n.dedupeKey, resolvedAt: null },
        select: { id: true },
      });
      if (existing) return;
    }
    await db.systemNotification.create({
      data: {
        severity: n.severity,
        category: n.category,
        title: n.title.slice(0, 200),
        message: n.message.slice(0, 1000),
        accountId: n.accountId ?? null,
        dedupeKey: n.dedupeKey ?? null,
      },
    });
  } catch {
    /* notificação nunca deve derrubar a operação principal */
  }
}

/** Marca como resolvidas as notificações abertas com a dedupeKey informada. */
export async function resolveNotifications(db: Db, dedupeKey: string): Promise<number> {
  try {
    const r = await db.systemNotification.updateMany({
      where: { dedupeKey, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
    return r.count;
  } catch {
    return 0;
  }
}

export type SystemEventLevel = 'info' | 'warn' | 'error';

/** Registra um evento do sistema (exibido no System Health). Nunca lança. */
export async function recordSystemEvent(
  db: Db,
  e: {
    source: 'api' | 'worker' | 'gateway';
    level: SystemEventLevel;
    type: string;
    message: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.systemEvent.create({
      data: {
        source: e.source,
        level: e.level,
        type: e.type.slice(0, 100),
        message: e.message.slice(0, 1000),
        details: (e.details ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch {
    /* ignora */
  }
}
