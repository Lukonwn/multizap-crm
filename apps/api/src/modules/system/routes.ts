import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getOperationsPause,
  recordSystemEvent,
  setOperationsPause,
  type Backup,
  type Prisma,
} from '@multizap/database';
import {
  CLEANUP_SETTING_KEY,
  HEARTBEAT_KEYS,
  operationsPauseSchema,
  type AuditLogDTO,
  type BackupDTO,
  type CleanupResult,
  type ServiceCheck,
  type SystemEventDTO,
  type SystemStatusDTO,
  type WorkerHeartbeat,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';

async function timed(fn: () => Promise<unknown>): Promise<ServiceCheck> {
  const start = performance.now();
  try {
    await fn();
    return { status: 'up', latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message.slice(0, 200) : 'erro' };
  }
}

export function toBackupDTO(b: Backup): BackupDTO {
  return {
    id: b.id,
    status: b.status,
    trigger: b.trigger,
    sizeBytes: b.sizeBytes === null ? null : Number(b.sizeBytes),
    error: b.error,
    startedAt: b.startedAt?.toISOString() ?? null,
    finishedAt: b.finishedAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
  };
}

const ATTENTION_STATUSES = ['DISCONNECTED', 'ATTENTION', 'NEEDS_REPAIR'] as const;

export async function systemRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  const readHeartbeat = async <T>(key: string): Promise<T | null> => {
    if (!app.redis) return null;
    const raw = await app.redis.get(key).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  /** Painel de monitoramento: tudo calculado a partir do estado real dos serviços. */
  app.get('/system/status', auth, async () => {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const database = await timed(() => prisma.$queryRaw`SELECT 1`);
    const redis: ServiceCheck = app.redis
      ? await timed(() => app.redis!.ping())
      : { status: 'unconfigured' };
    const storage: ServiceCheck = app.storage
      ? {
          ...(await timed(() => app.storage!.check())),
          detail: app.storage.kind === 's3' ? 'Railway Bucket' : 'Disco local',
        }
      : { status: 'unconfigured' };
    const [workerHb, gatewayHb] = await Promise.all([
      readHeartbeat<WorkerHeartbeat>(HEARTBEAT_KEYS.worker),
      readHeartbeat<{ at: string }>(HEARTBEAT_KEYS.gateway),
    ]);
    const hbCheck = (hb: { at: string } | null): ServiceCheck =>
      redis.status !== 'up'
        ? { status: 'unconfigured', error: 'Redis indisponível.' }
        : hb
          ? {
              status: 'up',
              detail: `Último sinal há ${Math.max(0, Math.round((Date.now() - Date.parse(hb.at)) / 1000))} s`,
            }
          : { status: 'down', error: 'Sem sinal recente (mais de 45 s).' };

    const queues =
      app.systemQueues && redis.status === 'up'
        ? await app.systemQueues.counts().catch(() => [])
        : [];

    const [
      accounts,
      events,
      importsFailed,
      toolsFailed,
      sendsFailed,
      repliesFailed,
      backupsFailed,
      notif,
      pause,
      backups,
      lastOk,
      running,
      cleanupRow,
    ] = await Promise.all([
      prisma.account.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          status: true,
          statusReason: true,
          disabledAt: true,
          integration: { select: { lastError: true, lastCheckAt: true } },
        },
      }),
      prisma.systemEvent.count({ where: { level: 'error', createdAt: { gte: since } } }),
      prisma.import.count({ where: { status: 'FAILED', updatedAt: { gte: since } } }),
      prisma.fileJob.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
      prisma.campaignRecipient.count({ where: { status: 'FAILED', updatedAt: { gte: since } } }),
      prisma.message.count({
        where: {
          direction: 'OUTBOUND',
          status: 'FAILED',
          campaignRecipientId: null,
          updatedAt: { gte: since },
        },
      }),
      prisma.backup.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
      prisma.systemNotification.groupBy({
        by: ['severity'],
        where: { resolvedAt: null },
        _count: true,
      }),
      getOperationsPause(prisma),
      prisma.backup.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.backup.findFirst({ where: { status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' } }),
      prisma.backup.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
      prisma.systemSetting.findUnique({ where: { key: CLEANUP_SETTING_KEY } }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const a of accounts) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const sev = (s: string) => notif.find((n) => n.severity === s)?._count ?? 0;
    const b = workerHb?.backup;

    const dto: SystemStatusDTO = {
      checkedAt: new Date().toISOString(),
      services: {
        api: { status: 'up', detail: `Ativa há ${Math.floor(process.uptime() / 60)} min` },
        database,
        redis,
        storage,
        worker: hbCheck(workerHb),
        gateway: hbCheck(gatewayHb),
      },
      queues,
      connections: {
        total: accounts.length,
        byStatus,
        attention: accounts
          .filter(
            (a) => !a.disabledAt && (ATTENTION_STATUSES as readonly string[]).includes(a.status),
          )
          .map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            reason: a.statusReason,
            lastError: a.integration?.lastError ?? null,
            lastCheckAt: a.integration?.lastCheckAt?.toISOString() ?? null,
          })),
      },
      errors24h: {
        systemEvents: events,
        importsFailed,
        toolJobsFailed: toolsFailed,
        campaignSendsFailed: sendsFailed,
        repliesFailed,
        backupsFailed,
      },
      notifications: {
        open: notif.reduce((s, n) => s + n._count, 0),
        critical: sev('CRITICAL'),
        error: sev('ERROR'),
        warning: sev('WARNING'),
      },
      operations: pause,
      backups: {
        configured: b?.configured ?? false,
        storage: !workerHb
          ? {
              status: 'unconfigured',
              error: 'Worker sem sinal: estado do bucket de backup desconhecido.',
            }
          : !b?.configured
            ? { status: 'unconfigured', error: 'Bucket de backup não configurado.' }
            : b.storageOk === false
              ? { status: 'down', error: b.error ?? 'Bucket de backup inacessível.' }
              : { status: 'up' },
        hourLocal: b?.configured ? b.hourLocal : null,
        retentionDays: b?.configured ? b.retentionDays : null,
        nextAt: b?.configured ? b.nextAt : null,
        lastSuccessAt: lastOk?.finishedAt?.toISOString() ?? null,
        running: running > 0,
        items: backups.map(toBackupDTO),
      },
      cleanup: (cleanupRow?.value as CleanupResult | undefined) ?? null,
    };
    return dto;
  });

  /** Pausa global: interrompe envios de campanha, respostas e início de agendamentos. */
  app.get('/system/operations', auth, async () => ({
    operations: await getOperationsPause(prisma),
  }));

  app.put('/system/operations', auth, async (req) => {
    const input = parse(operationsPauseSchema, req.body);
    const current = await getOperationsPause(prisma);
    if (current.paused === input.paused) return { operations: current };
    const user = req.auth!.user;
    const operations = await setOperationsPause(prisma, input.paused, {
      reason: input.reason || null,
      by: user.email,
    });
    await audit(prisma, req, {
      action: input.paused ? 'operations.paused' : 'operations.resumed',
      actorId: user.id,
      entityType: 'system',
      details: input.reason ? { reason: input.reason } : {},
    });
    await recordSystemEvent(prisma, {
      source: 'api',
      level: input.paused ? 'warn' : 'info',
      type: input.paused ? 'operations_paused' : 'operations_resumed',
      message: input.paused
        ? `Operações pausadas pelo administrador${input.reason ? `: ${input.reason}` : '.'}`
        : 'Operações retomadas pelo administrador.',
    });
    return { operations };
  });

  app.get('/system/events', auth, async (req) => {
    const q = parse(
      z.object({
        level: z.enum(['info', 'warn', 'error']).optional(),
        source: z.enum(['api', 'worker', 'gateway']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(30),
      }),
      req.query,
    );
    const where: Prisma.SystemEventWhereInput = {
      ...(q.level && { level: q.level }),
      ...(q.source && { source: q.source }),
    };
    const [rows, total] = await Promise.all([
      prisma.systemEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.systemEvent.count({ where }),
    ]);
    const items: SystemEventDTO[] = rows.map((e) => ({
      id: e.id,
      source: e.source,
      level: e.level,
      type: e.type,
      message: e.message,
      createdAt: e.createdAt.toISOString(),
    }));
    return { items, total };
  });

  /** Backup manual: executado pelo worker, no bucket de backup separado. */
  app.post('/system/backups', auth, async (req, reply) => {
    if (!app.systemQueues)
      throw new AppError(503, 'QUEUE_UNAVAILABLE', 'Fila de manutenção indisponível.');
    const hb = await readHeartbeat<WorkerHeartbeat>(HEARTBEAT_KEYS.worker);
    if (!hb) throw new AppError(503, 'WORKER_UNAVAILABLE', 'O worker está sem sinal no momento.');
    if (!hb.backup?.configured)
      throw new AppError(
        409,
        'BACKUP_NOT_CONFIGURED',
        'Configure o bucket de backup (BACKUP_S3_*) no worker.',
      );
    const running = await prisma.backup.findFirst({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (running) throw new AppError(409, 'BACKUP_RUNNING', 'Já existe um backup em andamento.');
    const backup = await prisma.backup.create({ data: { trigger: 'manual' } });
    await app.systemQueues.addBackup(backup.id);
    await audit(prisma, req, {
      action: 'backup.requested',
      actorId: req.auth!.user.id,
      entityType: 'backup',
      entityId: backup.id,
    });
    reply.code(202);
    return { backup: toBackupDTO(backup) };
  });

  app.get('/system/backups', auth, async (req) => {
    const { page } = parse(
      z.object({ page: z.coerce.number().int().min(1).default(1) }),
      req.query,
    );
    const [rows, total] = await Promise.all([
      prisma.backup.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * 20, take: 20 }),
      prisma.backup.count(),
    ]);
    return { items: rows.map(toBackupDTO), total };
  });

  /** Registro de auditoria (somente leitura). */
  app.get('/audit', auth, async (req) => {
    const q = parse(
      z.object({
        action: z.string().trim().max(100).optional(),
        accountId: z.string().uuid().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(30),
      }),
      req.query,
    );
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action && { action: { startsWith: q.action } }),
      ...(q.accountId && { accountId: q.accountId }),
    };
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { actor: { select: { email: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);
    const items: AuditLogDTO[] = rows.map((a) => ({
      id: a.id,
      action: a.action,
      actorEmail: a.actor?.email ?? null,
      entityType: a.entityType,
      entityId: a.entityId,
      accountId: a.accountId,
      ip: a.ip,
      details: a.details,
      createdAt: a.createdAt.toISOString(),
    }));
    return { items, total };
  });

  /** Resolver manualmente uma notificação (sai da lista ativa). */
  app.post('/notifications/:id/resolve', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await prisma.systemNotification.updateMany({
      where: { id, resolvedAt: null },
      data: { resolvedAt: new Date(), readAt: new Date() },
    });
    if (r.count === 0) {
      if (!(await prisma.systemNotification.findUnique({ where: { id } })))
        throw Errors.notFound('Notificação não encontrada.');
      return { ok: true };
    }
    await audit(prisma, req, {
      action: 'notification.resolved',
      actorId: req.auth!.user.id,
      entityType: 'notification',
      entityId: id,
    });
    return { ok: true };
  });
}
