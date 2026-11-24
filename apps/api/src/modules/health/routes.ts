import type { FastifyInstance } from 'fastify';
import { HEARTBEAT_KEYS } from '@multizap/shared';

type Check = { status: 'up' | 'down' | 'unconfigured'; latencyMs?: number; error?: string };

async function timed(fn: () => Promise<unknown>): Promise<Check> {
  const start = performance.now();
  try {
    await fn();
    return { status: 'up', latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message.slice(0, 200) : 'erro' };
  }
}

export async function healthRoutes(app: FastifyInstance) {
  /** Liveness: usado pelo health check da Railway. Não depende de serviços externos. */
  app.get('/health', async () => ({
    status: 'ok',
    service: 'multizap-api',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  /** Readiness: banco, Redis e heartbeat dos serviços de segundo plano. */
  app.get('/health/ready', async (_req, reply) => {
    const database = await timed(() => app.prisma.$queryRaw`SELECT 1`);
    const redis: Check = app.redis
      ? await timed(() => app.redis!.ping())
      : { status: 'unconfigured' };
    const heartbeat = async (key: string): Promise<Check> => {
      if (!app.redis || redis.status !== 'up') return { status: 'unconfigured' };
      const v = await app.redis.get(key).catch(() => null);
      return v ? { status: 'up' } : { status: 'down', error: 'Sem heartbeat recente.' };
    };
    const storage: Check = app.storage
      ? await timed(() => app.storage!.check())
      : { status: 'unconfigured' };
    const checks = {
      database,
      redis,
      storage,
      worker: await heartbeat(HEARTBEAT_KEYS.worker),
      gateway: await heartbeat(HEARTBEAT_KEYS.gateway),
    };
    const ready = database.status === 'up' && redis.status !== 'down';
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'degraded', checks };
  });
}
