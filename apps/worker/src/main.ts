import { Redis } from 'ioredis';
import { getPrisma } from '@multizap/database';
import { HEARTBEAT_KEYS } from '@multizap/shared';
import { onShutdown, startHealthServer, startHeartbeat } from '@multizap/shared/runtime';
import { QUEUES } from './queues';

/**
 * multizap-worker — processamento assíncrono (BullMQ).
 * Fase 1: inicialização, conexão com Redis/PostgreSQL, heartbeat e health check.
 * Nenhum processador de fila é registrado ainda (ver queues.ts).
 */
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL não configurada.');

const log = (msg: string) => console.log(`[worker] ${msg}`);
const prisma = getPrisma();
// BullMQ exige maxRetriesPerRequest = null nas conexões dos Workers.
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => log(`Redis: ${err.message}`));

await prisma.$queryRaw`SELECT 1`;
log('PostgreSQL conectado.');

const stopHeartbeat = startHeartbeat(redis, HEARTBEAT_KEYS.worker, () => ({
  queues: Object.values(QUEUES),
}));
const health = process.env.PORT
  ? startHealthServer(Number(process.env.PORT), () => redis.status === 'ready', 'multizap-worker')
  : null;
log('Pronto. Aguardando processadores das próximas fases.');

onShutdown(async () => {
  stopHeartbeat();
  health?.close();
  await prisma.$disconnect();
  redis.disconnect();
}, log);
