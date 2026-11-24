import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import { createPrisma, ensureBootstrapAdmin } from '@multizap/database';
import { HEARTBEAT_KEYS } from '@multizap/shared';
import { resetDb, setupTestApp } from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;

beforeAll(async () => {
  ({ app, prisma, redis } = await setupTestApp());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});

describe('health', () => {
  it('liveness responde sem dependências', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('ok');
  });

  it('readiness verifica banco, Redis e heartbeats', async () => {
    await redis.del(HEARTBEAT_KEYS.worker, HEARTBEAT_KEYS.gateway);
    const r = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.checks.database.status).toBe('up');
    expect(body.checks.redis.status).toBe('up');
    expect(body.checks.worker.status).toBe('down');
    await redis.set(HEARTBEAT_KEYS.worker, '1', 'EX', 10);
    const r2 = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r2.json().checks.worker.status).toBe('up');
  });

  it('aplica cabeçalhos de segurança', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('rota inexistente retorna 404 padronizado', async () => {
    const r = await app.inject({ method: 'GET', url: '/nao-existe' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });
});

describe('administrador inicial', () => {
  it('é criado uma única vez e exige troca de senha', async () => {
    await resetDb(prisma);
    const p = createPrisma(process.env.TEST_DATABASE_URL!);
    expect(await ensureBootstrapAdmin(p, {})).toBe('skipped');
    expect(
      await ensureBootstrapAdmin(p, { email: 'Root@X.com', password: 'Senha-Inicial-123' }),
    ).toBe('created');
    expect(
      await ensureBootstrapAdmin(p, { email: 'outro@x.com', password: 'Senha-Inicial-123' }),
    ).toBe('exists');
    const users = await p.adminUser.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]!.email).toBe('root@x.com');
    expect(users[0]!.mustChangePassword).toBe(true);
    await p.$disconnect();
  });
});
