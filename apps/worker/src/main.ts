import { Redis } from 'ioredis';
import { Worker, type Job } from 'bullmq';
import { getPrisma } from '@multizap/database';
import {
  HEARTBEAT_KEYS,
  IMPORTS_QUEUE,
  TOOLS_QUEUE,
  type ImportJob,
  type ToolJobData,
  CAMPAIGNS_QUEUE,
  type CampaignJob,
} from '@multizap/shared';
import { Queue } from 'bullmq';
import { onShutdown, startHealthServer, startHeartbeat } from '@multizap/shared/runtime';
import { storageFromEnv } from '@multizap/storage';
import { ImportProcessor } from './imports/processor';
import { ToolJobProcessor } from './tools/processor';
import { CampaignPreparer } from './campaigns/preparer';
import { MetricsRollup } from './metrics/rollup';
import { assertTimezone } from '@multizap/database';
import { QUEUES } from './queues';

/**
 * multizap-worker — processamento assíncrono (BullMQ).
 * Fase 3: análise e importação de listas de contatos.
 * Fase 4: ferramentas de processamento de listas.
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
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) void imports.fail(job.data.importId, err);
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
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) void tools.fail(job.data.jobId, err);
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
campaignWorker.on('failed', (job, err) =>
  log('Preparação de campanha falhou', { campaignId: job?.data.campaignId, err: err.message }),
);

// Agendamentos: a cada minuto, enfileira as campanhas cujo horário chegou.
const campaignQueue = new Queue<CampaignJob>(CAMPAIGNS_QUEUE, {
  connection: redis.duplicate(),
  prefix,
});
const scheduleTimer = setInterval(async () => {
  try {
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
const rollup = new MetricsRollup(prisma, assertTimezone(process.env.REPORTS_TZ || 'America/Sao_Paulo'), log);
void rollup.backfill().then(() => rollup.run()).catch((err: unknown) => log('Falha ao consolidar métricas', { err: String(err) }));
const metricsTimer = setInterval(() => {
  rollup.run().catch((err: unknown) => log('Falha ao consolidar métricas', { err: String(err) }));
}, 3_600_000);
metricsTimer.unref();

const stopHeartbeat = startHeartbeat(redis, HEARTBEAT_KEYS.worker, () => ({
  queues: Object.values(QUEUES),
}));
const health = process.env.PORT
  ? startHealthServer(Number(process.env.PORT), () => redis.status === 'ready', 'multizap-worker')
  : null;
log('Worker pronto', { storage: storage.kind });

onShutdown(async () => {
  stopHeartbeat();
  // aguarda os jobs atuais; jobs interrompidos são retomados pelo BullMQ
  clearInterval(scheduleTimer);
  clearInterval(metricsTimer);
  await Promise.all([
    importWorker.close(),
    toolWorker.close(),
    campaignWorker.close(),
    campaignQueue.close(),
  ]);
  health?.close();
  await prisma.$disconnect();
  redis.disconnect();
}, log);
