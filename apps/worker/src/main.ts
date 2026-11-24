import { Redis } from 'ioredis';
import { Worker, type Job } from 'bullmq';
import { getPrisma } from '@multizap/database';
import { HEARTBEAT_KEYS, IMPORTS_QUEUE, type ImportJob } from '@multizap/shared';
import { onShutdown, startHealthServer, startHeartbeat } from '@multizap/shared/runtime';
import { storageFromEnv } from '@multizap/storage';
import { ImportProcessor } from './imports/processor';
import { QUEUES } from './queues';

/**
 * multizap-worker — processamento assíncrono (BullMQ).
 * Fase 3: análise e importação de listas de contatos.
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

const stopHeartbeat = startHeartbeat(redis, HEARTBEAT_KEYS.worker, () => ({
  queues: Object.values(QUEUES),
}));
const health = process.env.PORT
  ? startHealthServer(Number(process.env.PORT), () => redis.status === 'ready', 'multizap-worker')
  : null;
log('Worker pronto', { storage: storage.kind });

onShutdown(async () => {
  stopHeartbeat();
  await importWorker.close(); // aguarda o job atual; jobs interrompidos são retomados
  health?.close();
  await prisma.$disconnect();
  redis.disconnect();
}, log);
