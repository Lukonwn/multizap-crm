import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Worker } from 'bullmq';
import pino from 'pino';
import { getPrisma } from '@multizap/database';
import { GATEWAY_QUEUE, HEARTBEAT_KEYS, type GatewayCommand } from '@multizap/shared';
import { cipherFromEnv } from '@multizap/shared/crypto';
import { onShutdown, startHealthServer, startHeartbeat } from '@multizap/shared/runtime';
import { DbAuthStore } from './whatsapp/auth-store';
import { BaileysFactory } from './whatsapp/baileys-factory';
import { LockManager } from './session/lock';
import { SessionManager } from './session/manager';
import { handleCommand } from './commands';

/**
 * multizap-gateway — dono das conexões WhatsApp (dispositivos conectados).
 * Restaura todas as sessões pareadas ao iniciar e executa os comandos da API.
 */
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL não configurada.');

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'multizap-gateway' },
});
const baileysLogger = pino({
  level: process.env.BAILEYS_LOG_LEVEL ?? 'warn',
  base: { service: 'baileys' },
});
const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info(extra, msg);

const prisma = getPrisma();
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis'));

await prisma.$queryRaw`SELECT 1`;

const store = new DbAuthStore(prisma, cipherFromEnv());
const factory = new BaileysFactory(
  store,
  baileysLogger,
  process.env.GATEWAY_BROWSER_NAME || 'Chrome',
);
const locks = new LockManager(redis, `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`);
const manager = new SessionManager(prisma, redis, factory, store, locks, { log });

locks.startRenewal((accountId) => manager.onLockLost(accountId));
await manager.reconcile();
const reconcileTimer = setInterval(() => {
  manager.reconcile().catch((err: unknown) => logger.error({ err }, 'Falha no reconcile'));
}, 30_000);
reconcileTimer.unref();

const worker = new Worker<GatewayCommand>(
  GATEWAY_QUEUE,
  async (job) => {
    log('Comando recebido', { type: job.data.type, accountId: job.data.accountId });
    await handleCommand(manager, job.data);
  },
  { connection: redis.duplicate(), concurrency: 5 },
);
worker.on('failed', (job, err) =>
  logger.error({ err: err.message, type: job?.data.type }, 'Comando falhou'),
);

const stopHeartbeat = startHeartbeat(redis, HEARTBEAT_KEYS.gateway, () => ({
  sessions: manager.activeCount,
}));
const health = process.env.PORT
  ? startHealthServer(Number(process.env.PORT), () => redis.status === 'ready', 'multizap-gateway')
  : null;
log('Gateway pronto', { owner: locks.ownerId });

onShutdown(async () => {
  clearInterval(reconcileTimer);
  stopHeartbeat();
  await worker.close();
  // Encerra sockets SEM logout: as sessões são restauradas na próxima inicialização.
  await manager.shutdown();
  health?.close();
  await prisma.$disconnect();
  redis.disconnect();
}, log);
