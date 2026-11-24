import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import { setupTestApp } from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;

beforeAll(async () => {
  ({ app, prisma, redis } = await setupTestApp({ LOGIN_RATE_LIMIT_PER_MINUTE: '3' }));
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});

describe('rate limit do login', () => {
  it('limita tentativas por IP', async () => {
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'x@y.com', password: 'abc' },
      });
    for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });
});
