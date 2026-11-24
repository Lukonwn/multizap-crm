import { Redis } from 'ioredis';
import { Worker, type Job } from 'bullmq';
import { getPrisma } from '@multizap/database';
import {
  AI_QUEUE,
  GATEWAY_QUEUE,
  HEARTBEAT_KEYS,
  IMPORTS_QUEUE,
  TOOLS_QUEUE,
  type ImportJob,
  type ToolJobData,
  CAMPAIGNS_QUEUE,
  MAINTENANCE_QUEUE,
  type AiInboundJob,
  type CampaignJob,
  type GatewayCommand,
  type MaintenanceJob,
  type WorkerHeartbeat,
} from '@multizap/shared';
import { Queue } from 'bullmq';
import { cipherFromEnv, type CredentialCipher } from '@multizap/shared/crypto';
import { onShutdown, startHealthServer, startHeartbeat } from '@multizap/shared/runtime';
import { backupStorageFromEnv, storageFromEnv } from '@multizap/storage';
import { ImportProcessor } from './imports/processor';
import { ToolJobProcessor } from './tools/processor';
import { CampaignPreparer } from './campaigns/preparer';
import { MetricsRollup } from './metrics/rollup';
import { AiResponder } from './ai/responder';
import {
  assertTimezone,
  isOperationsPaused,
  notify,
  recordSystemEvent,
  resolveNotifications,
} from '@multizap/database';
import { BackupService, backupSlots } from './maintenance/backup';
import { CleanupService, DEFAULT_CLEANUP } from './maintenance/cleanup';
import { Monitor } from './maintenance/monitor';
import { parseBackupKey } from './maintenance/crypto-stream';
import { QUEUES } from './queues';

/**
 * multizap-worker — processamento assíncrono (BullMQ).
 * Fase 3: análise e importação de listas de contatos.
 * Fase 4: ferramentas de processamento de listas.
 * Fase 6: preparação de campanhas. Fase 8: métricas diárias.
 * Fase 9: backups, limpeza e monitoramento.
 */
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL não configurada.');
const prefix = process.env.BULLMQ_PREFIX || 'bull';

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', service: 'multizap-worker', msg, ...extra }));
const prisma = getPrisma();
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => log(`Redis: ${err.message}`));
await prisma.$queryRaw`SELECT 1`;

const storage = storageFromEnv();
await storage.check();
const imports = new ImportProcessor(prisma, storage, log);

const importWorker = new Worker<ImportJob>(
  IMPORTS_QUEUE,
  async (job: Job<ImportJob>) => {
    log('Job de importação', {
      type: job.data.type,
      importId: job.data.importId,
      attempt: job.attemptsMade + 1,
    });
    if (job.data.type === 'analyze') await imports.analyze(job.data.importId);
    else await imports.run(job.data.importId);
  },
  { connection: redis.duplicate(), prefix, concurrency: 2 },
);
importWorker.on('failed', (job, err) => {
  if (!job) return;
  log('Job de importação falhou', {
    importId: job.data.importId,
    err: err.message,
    attempt: job.attemptsMade,
  });
  // Após esgotar as tentativas, marca a importação como falha e notifica.
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void imports.fail(job.data.importId, err);
    void recordSystemEvent(prisma, {
      source: 'worker',
      level: 'error',
      type: 'import_failed',
      message: err.message,
      details: { importId: job.data.importId },
    });
  }
});

const tools = new ToolJobProcessor(prisma, storage, log);
const toolWorker = new Worker<ToolJobData>(
  TOOLS_QUEUE,
  async (job) => {
    log('Job de ferramenta', { jobId: job.data.jobId, attempt: job.attemptsMade + 1 });
    await tools.run(job.data.jobId);
  },
  { connection: redis.duplicate(), prefix, concurrency: 2 },
);
toolWorker.on('failed', (job, err) => {
  if (!job) return;
  log('Job de ferramenta falhou', {
    jobId: job.data.jobId,
    err: err.message,
    attempt: job.attemptsMade,
  });
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void tools.fail(job.data.jobId, err);
    void recordSystemEvent(prisma, {
      source: 'worker',
      level: 'error',
      type: 'tool_failed',
      message: err.message,
      details: { jobId: job.data.jobId },
    });
  }
});

// MultiZap AI: responde às mensagens recebidas (rascunho para revisão ou envio automático).
// Falhas aqui ficam restritas ao módulo: o restante do worker não depende dele.
let aiCipher: CredentialCipher | null = null;
if (process.env.CREDENTIALS_MASTER_KEY) {
  try {
    aiCipher = cipherFromEnv();
  } catch (err) {
    log('CREDENTIALS_MASTER_KEY inválida: o MultiZap AI não conseguirá ler a chave da OpenRouter', {
      err: String(err),
    });
  }
} else {
  log('CREDENTIALS_MASTER_KEY ausente: o MultiZap AI não responderá até ser configurada');
}
const gatewayQueue = new Queue<GatewayCommand>(GATEWAY_QUEUE, {
  connection: redis.duplicate(),
  prefix,
  defaultJobOptions: { removeOnComplete: 200, removeOnFail: 500, attempts: 1 },
});
const responder = new AiResponder({
  prisma,
  cipher: aiCipher,
  gateway: { send: (cmd) => gatewayQueue.add(cmd.type, cmd) },
  appUrl: process.env.WEB_ORIGIN,
  log,
});
const aiWorker = new Worker<AiInboundJob>(
  AI_QUEUE,
  async (job) => {
    const out = await responder.handle(job.data);
    log('Atendimento da IA', { messageId: job.data.messageId, ...out });
  },
  { connection: redis.duplicate(), prefix, concurrency: 3 },
);
aiWorker.on('failed', (job, err) => {
  log('Atendimento da IA falhou', { messageId: job?.data.messageId, err: err.message });
});

const preparer = new CampaignPreparer(prisma, log);
const campaignWorker = new Worker<CampaignJob>(
  CAMPAIGNS_QUEUE,
  async (job) => {
    log('Preparando campanha', { campaignId: job.data.campaignId });
    await preparer.prepare(job.data.campaignId);
  },
  { connection: redis.duplicate(), prefix, concurrency: 1 },
);
campaignWorker.on('failed', (job, err) => {
  log('Preparação de campanha falhou', { campaignId: job?.data.campaignId, err: err.message });
  void recordSystemEvent(prisma, {
    source: 'worker',
    level: 'error',
    type: 'campaign_prepare_failed',
    message: err.message,
    details: { campaignId: job?.data.campaignId },
  });
});

// Agendamentos: a cada minuto, enfileira as campanhas cujo horário chegou.
const campaignQueue = new Queue<CampaignJob>(CAMPAIGNS_QUEUE, {
  connection: redis.duplicate(),
  prefix,
});
const scheduleTimer = setInterval(async () => {
  try {
    if (await isOperationsPaused(prisma)) return; // pausa global: agendamentos aguardam
    for (const id of await preparer.due()) {
      await campaignQueue.add(
        'prepare',
        { type: 'prepare', campaignId: id },
        { jobId: `prepare-${id}`, removeOnComplete: true, removeOnFail: 100 },
      );
    }
  } catch (err) {
    log('Falha ao verificar agendamentos', { err: (err as Error).message });
  }
}, 60_000);
scheduleTimer.unref();

// Métricas diárias: backfill ao iniciar e consolidação a cada hora.
const rollup = new MetricsRollup(
  prisma,
  assertTimezone(process.env.REPORTS_TZ || 'America/Sao_Paulo'),
  log,
);
void rollup
  .backfill()
  .then(() => rollup.run())
  .catch((err: unknown) => log('Falha ao consolidar métricas', { err: String(err) }));
const metricsTimer = setInterval(() => {
  rollup.run().catch((err: unknown) => log('Falha ao consolidar métricas', { err: String(err) }));
}, 3_600_000);
metricsTimer.unref();

// ─── Fase 9: backups, limpeza e monitoramento ───
const reportsTz = assertTimezone(process.env.REPORTS_TZ || 'America/Sao_Paulo');
const intEnv = (name: string, def: number, min: number, max: number) => {
  const v = Number(process.env[name] ?? def);
  return Number.isInteger(v) && v >= min && v <= max ? v : def;
};
const backupHour = intEnv('BACKUP_HOUR', 3, 0, 23);
const backupRetentionDays = intEnv('BACKUP_RETENTION_DAYS', 14, 1, 365);
let backupStorage = null as ReturnType<typeof backupStorageFromEnv>;
let backupService: BackupService | null = null;
let backupConfigError: string | null = null;
try {
  backupStorage = backupStorageFromEnv();
  if (backupStorage) {
    backupService = new BackupService(
      prisma,
      process.env.DATABASE_URL!,
      storage,
      backupStorage,
      parseBackupKey(process.env.BACKUP_ENCRYPTION_KEY),
      log,
    );
  }
} catch (err) {
  backupConfigError = (err as Error).message;
  log('Backup não configurado corretamente', { err: backupConfigError });
}
if (backupConfigError) {
  await notify(prisma, {
    severity: 'ERROR',
    category: 'BACKUP',
    title: 'Configuração de backup inválida',
    message: backupConfigError,
    dedupeKey: 'backup:config',
  });
} else {
  await resolveNotifications(prisma, 'backup:config');
  if (!backupService && process.env.NODE_ENV === 'production') {
    await notify(prisma, {
      severity: 'WARNING',
      category: 'BACKUP',
      title: 'Backups desativados',
      message:
        'Configure um bucket de backup separado (BACKUP_S3_*) e a BACKUP_ENCRYPTION_KEY no worker.',
      dedupeKey: 'backup:not_configured',
    });
  } else {
    await resolveNotifications(prisma, 'backup:not_configured');
  }
}

const maintenanceQueue = new Queue<MaintenanceJob>(MAINTENANCE_QUEUE, {
  connection: redis.duplicate(),
  prefix,
});
const maintenanceWorker = new Worker<MaintenanceJob>(
  MAINTENANCE_QUEUE,
  async (job) => {
    if (job.data.type !== 'backup') return;
    if (!backupService) {
      await prisma.backup.updateMany({
        where: { id: job.data.backupId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          error: backupConfigError ?? 'Backup não configurado.',
        },
      });
      return;
    }
    await backupService.run(job.data.backupId);
    const pruned = await backupService.prune(backupRetentionDays);
    if (pruned.removed || pruned.filesRemoved) log('Retenção de backups aplicada', pruned);
  },
  { connection: redis.duplicate(), prefix, concurrency: 1 },
);
maintenanceWorker.on('failed', (job, err) =>
  log('Job de manutenção falhou', { id: job?.id, err: err.message }),
);

// Backups interrompidos por reinício: marcados como falha (um novo é criado no próximo horário).
await prisma.backup.updateMany({
  where: { status: 'RUNNING' },
  data: { status: 'FAILED', finishedAt: new Date(), error: 'Interrompido por reinício do worker.' },
});

const scheduleBackup = async () => {
  if (!backupService) return;
  const { last } = backupSlots(new Date(), backupHour, reportsTz);
  const exists = await prisma.backup.findFirst({
    where: {
      OR: [
        { trigger: 'scheduled', createdAt: { gte: last } },
        { status: { in: ['QUEUED', 'RUNNING'] } },
      ],
    },
  });
  if (exists) return;
  const b = await prisma.backup.create({ data: { trigger: 'scheduled' } });
  await maintenanceQueue.add(
    'backup',
    { type: 'backup', backupId: b.id },
    { jobId: `backup-${b.id}`, removeOnComplete: 100, removeOnFail: 200 },
  );
  log('Backup automático enfileirado', { backupId: b.id });
};

const cleanup = new CleanupService(
  prisma,
  storage,
  {
    ...DEFAULT_CLEANUP,
    toolRetentionDays: intEnv('TOOL_RETENTION_DAYS', DEFAULT_CLEANUP.toolRetentionDays, 1, 365),
    importFileRetentionDays: intEnv(
      'IMPORT_FILE_RETENTION_DAYS',
      DEFAULT_CLEANUP.importFileRetentionDays,
      1,
      3650,
    ),
  },
  log,
);
const runCleanup = () =>
  cleanup.run().catch(async (err: unknown) => {
    log('Falha na limpeza', { err: String(err) });
    await recordSystemEvent(prisma, {
      source: 'worker',
      level: 'error',
      type: 'cleanup_failed',
      message: String(err),
    });
  });
const cleanupStart = setTimeout(() => void runCleanup(), 5 * 60_000);
cleanupStart.unref();
const cleanupTimer = setInterval(() => void runCleanup(), 6 * 3_600_000);
cleanupTimer.unref();

const monitor = new Monitor(prisma, redis, storage, backupStorage);
const maintenanceTick = async () => {
  await monitor.tick().catch((err: unknown) => log('Falha no monitoramento', { err: String(err) }));
  await scheduleBackup().catch((err: unknown) =>
    log('Falha ao agendar backup', { err: String(err) }),
  );
};
void maintenanceTick();
const maintenanceTimer = setInterval(() => void maintenanceTick(), 60_000);
maintenanceTimer.unref();

const stopHeartbeat = startHeartbeat(
  redis,
  HEARTBEAT_KEYS.worker,
  (): Omit<WorkerHeartbeat, 'at' | 'pid'> => ({
    queues: Object.values(QUEUES),
    backup: {
      configured: !!backupService,
      storageOk: backupService ? monitor.backupStorageOk : null,
      error: backupConfigError ?? monitor.backupStorageError,
      hourLocal: backupHour,
      retentionDays: backupRetentionDays,
      nextAt: backupService
        ? backupSlots(new Date(), backupHour, reportsTz).next.toISOString()
        : null,
    },
  }),
);
const health = process.env.PORT
  ? startHealthServer(Number(process.env.PORT), () => redis.status === 'ready', 'multizap-worker')
  : null;
log('Worker pronto', { storage: storage.kind });

onShutdown(async () => {
  stopHeartbeat();
  // aguarda os jobs atuais; jobs interrompidos são retomados pelo BullMQ
  clearInterval(scheduleTimer);
  clearInterval(metricsTimer);
  clearInterval(maintenanceTimer);
  clearInterval(cleanupTimer);
  clearTimeout(cleanupStart);
  await Promise.all([
    maintenanceWorker.close(),
    maintenanceQueue.close(),
    importWorker.close(),
    toolWorker.close(),
    campaignWorker.close(),
    aiWorker.close(),
    gatewayQueue.close(),
    campaignQueue.close(),
  ]);
  health?.close();
  await prisma.$disconnect();
  redis.disconnect();
}, log);
