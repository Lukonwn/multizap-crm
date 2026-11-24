import { Redis } from 'ioredis';
import { getPrisma } from '@multizap/database';
import { HEARTBEAT_KEYS } from '@multizap/shared';
import { onShutdown, startHealthServer, startHeartbeat } from '@multizap/shared/runtime';

/**
 * multizap-gateway — dono das conexões WhatsApp (dispositivos conectados).
 *
 * Fase 1: inicialização, heartbeat e health check.
 * Fase 2: gerenciador de sessões — trava por instância no Redis (um único dono
 * por conta), restauração das credenciais criptografadas do PostgreSQL após
 * qualquer reinício, pareamento por QR Code / código e reconexão com backoff.
 */
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL não configurada.');

const log = (msg: string) => console.log(`[gateway] ${msg}`);
const prisma = getPrisma();
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => log(`Redis: ${err.message}`));

await prisma.$queryRaw`SELECT 1`;
log('PostgreSQL conectado.');

const stopHeartbeat = startHeartbeat(redis, HEARTBEAT_KEYS.gateway, () => ({ sessions: 0 }));
const health = process.env.PORT
  ? startHealthServer(Number(process.env.PORT), () => redis.status === 'ready', 'multizap-gateway')
  : null;
log('Pronto. Gerenciador de sessões será ativado na Fase 2.');

onShutdown(async () => {
  stopHeartbeat();
  health?.close();
  await prisma.$disconnect();
  redis.disconnect();
}, log);
