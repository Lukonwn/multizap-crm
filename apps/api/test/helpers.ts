import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { createPrisma, type PrismaClient } from '@multizap/database';
import { hashPassword } from '@multizap/shared/password';
import { CSRF_COOKIE, SESSION_COOKIE } from '@multizap/shared';
import { buildApp } from '../src/app';
import { CredentialCipher } from '@multizap/shared/crypto';
import { randomBytes } from 'node:crypto';
import { GatewayClient } from '../src/lib/gateway';
import { CampaignQueue, ImportQueue, SystemQueues, ToolQueue } from '../src/lib/queues';
import { LocalStorage } from '@multizap/storage';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';

export const WEB_ORIGIN = 'http://localhost:3000';
export const ADMIN = { email: 'admin@multizap.local', password: 'Senha-Inicial-123' };

export async function setupTestApp(
  env: Record<string, string> = {},
  extra: { aiFetch?: typeof fetch } = {},
): Promise<{
  app: FastifyInstance;
  prisma: PrismaClient;
  redis: Redis;
  gateway: GatewayClient;
  storage: LocalStorage;
  importQueue: ImportQueue;
  toolQueue: ToolQueue;
  campaignQueue: CampaignQueue;
  systemQueues: SystemQueues;
}> {
  const url = process.env.TEST_DATABASE_URL!;
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    WEB_ORIGIN,
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
    ...env,
  });
  const prisma = createPrisma(url);
  const redis = new Redis(config.redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  // Prefixo próprio: a fila de testes nunca é consumida por um gateway real.
  const gateway = new GatewayClient(config.redisUrl!, redis, 'mztest');
  const storage = new LocalStorage(mkdtempSync(join(tmpdir(), 'mz-api-')));
  const importQueue = new ImportQueue(config.redisUrl!, 'mztest');
  const toolQueue = new ToolQueue(config.redisUrl!, 'mztest');
  const campaignQueue = new CampaignQueue(config.redisUrl!, 'mztest');
  const systemQueues = new SystemQueues(config.redisUrl!, 'mztest');
  const app = await buildApp({
    config,
    prisma,
    redis,
    gateway,
    storage,
    importQueue,
    toolQueue,
    campaignQueue,
    systemQueues,
    cipher: new CredentialCipher(new Map([[1, randomBytes(32)]]), 1),
    ...(extra.aiFetch && { aiFetch: extra.aiFetch }),
    logger: false,
  });
  app.addHook('onClose', async () => {
    await gateway.close();
    await importQueue.close();
    await toolQueue.close();
    await campaignQueue.close();
    await systemQueues.close();
  });
  await app.ready();
  return {
    app,
    prisma,
    redis,
    gateway,
    storage,
    importQueue,
    toolQueue,
    campaignQueue,
    systemQueues,
  };
}

export async function resetDb(prisma: PrismaClient) {
  if (!/test/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname))
    throw new Error('resetDb só roda em banco de testes.');
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export async function createAdmin(
  prisma: PrismaClient,
  opts: { mustChangePassword?: boolean } = {},
) {
  return prisma.adminUser.create({
    data: {
      email: ADMIN.email,
      name: 'Admin',
      passwordHash: await hashPassword(ADMIN.password),
      mustChangePassword: opts.mustChangePassword ?? false,
    },
  });
}

export interface Session {
  token: string;
  csrf: string;
  cookie: string;
}

export async function login(app: FastifyInstance, password = ADMIN.password): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: WEB_ORIGIN },
    payload: { email: ADMIN.email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login falhou: ${res.statusCode} ${res.body}`);
  return sessionFrom(res.cookies as { name: string; value: string }[]);
}

export function sessionFrom(cookies: { name: string; value: string }[]): Session {
  const token = cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const csrf = cookies.find((c) => c.name === CSRF_COOKIE)!.value;
  return { token, csrf, cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${csrf}` };
}

export function authed(s: Session, withCsrf = true) {
  return { cookie: s.cookie, origin: WEB_ORIGIN, ...(withCsrf && { 'x-csrf-token': s.csrf }) };
}

/** Corpo multipart/form-data com um único arquivo (campos antes do arquivo). */
export function multipart(
  fileName: string,
  content: Buffer | string,
  fields: Record<string, string> = {},
) {
  const boundary = `----mz${Date.now()}`;
  const body = Buffer.concat([
    ...Object.entries(fields).map(([k, v]) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
