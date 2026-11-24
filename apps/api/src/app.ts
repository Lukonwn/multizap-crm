import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import type { StorageDriver } from '@multizap/storage';
import type { CampaignQueue, ImportQueue, SystemQueues, ToolQueue } from './lib/queues';
import { campaignRoutes } from './modules/campaigns/routes';
import { inboxRoutes } from './modules/inbox/routes';
import { reportRoutes } from './modules/reports/routes';
import { toolRoutes } from './modules/tools/routes';
import { assetRoutes } from './modules/assets/routes';
import { contactRoutes } from './modules/contacts/routes';
import { importRoutes } from './modules/imports/routes';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import type { AppConfig } from './config';
import { AppError } from './lib/errors';
import securityPlugin from './plugins/security';
import authPlugin from './plugins/auth';
import { authRoutes } from './modules/auth/routes';
import { healthRoutes } from './modules/health/routes';
import { accountRoutes } from './modules/accounts/routes';
import { notificationRoutes } from './modules/notifications/routes';
import { dashboardRoutes } from './modules/dashboard/routes';
import { systemRoutes } from './modules/system/routes';
import { deviceContactRoutes } from './modules/device-contacts/routes';
import type { GatewayClient } from './lib/gateway';
import type { CredentialCipher } from '@multizap/shared/crypto';
import { aiRoutes } from './modules/ai/routes';
import { aiServiceRoutes } from './modules/ai/service-routes';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis | null;
    config: AppConfig;
    gateway: GatewayClient | null;
    storage: StorageDriver | null;
    importQueue: ImportQueue | null;
    toolQueue: ToolQueue | null;
    campaignQueue: CampaignQueue | null;
    systemQueues: SystemQueues | null;
    /** Cifra das credenciais (chave da OpenRouter). Null sem CREDENTIALS_MASTER_KEY. */
    cipher: CredentialCipher | null;
    /** fetch usado nas chamadas à OpenRouter (injetável nos testes). */
    aiFetch: typeof fetch;
  }
}

export interface BuildDeps {
  config: AppConfig;
  prisma: PrismaClient;
  redis: Redis | null;
  gateway?: GatewayClient | null;
  storage?: StorageDriver | null;
  importQueue?: ImportQueue | null;
  toolQueue?: ToolQueue | null;
  campaignQueue?: CampaignQueue | null;
  systemQueues?: SystemQueues | null;
  cipher?: CredentialCipher | null;
  aiFetch?: typeof fetch;
  logger?: boolean;
}

export async function buildApp({
  config,
  prisma,
  redis,
  gateway = null,
  storage = null,
  importQueue = null,
  toolQueue = null,
  campaignQueue = null,
  systemQueues = null,
  cipher = null,
  aiFetch = fetch,
  logger = true,
}: BuildDeps): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 1_048_576,
    logger: logger
      ? {
          level: config.logLevel,
          redact: {
            paths: [
              'req.headers.cookie',
              'req.headers.authorization',
              'req.headers["x-csrf-token"]',
              'req.headers["x-internal-token"]',
              'res.headers["set-cookie"]',
            ],
            censor: '[redacted]',
          },
        }
      : false,
  });

  app.decorate('prisma', prisma);
  app.decorate('redis', redis);
  app.decorate('config', config);
  app.decorate('gateway', gateway);
  app.decorate('storage', storage);
  app.decorate('importQueue', importQueue);
  app.decorate('toolQueue', toolQueue);
  app.decorate('campaignQueue', campaignQueue);
  app.decorate('systemQueues', systemQueues);
  app.decorate('cipher', cipher);
  app.decorate('aiFetch', aiFetch);

  await app.register(sensible);
  await app.register(multipart, {
    limits: {
      fileSize: Math.max(config.maxImportBytes, config.maxAssetBytes),
      files: 1,
      fields: 5,
    },
  });
  await app.register(securityPlugin, { webOrigin: config.webOrigin });
  await app.register(authPlugin, { sessionIdleMs: config.sessionIdleMs });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.fields && { fields: err.fields }) },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'Muitas requisições. Aguarde um instante.' },
      });
    }
    if (status && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: { code: 'BAD_REQUEST', message: 'Requisição inválida.' } });
    }
    req.log.error({ err }, 'Erro não tratado');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }),
  );

  await app.register(healthRoutes);
  await app.register(authRoutes, {
    sessionTtlMs: config.sessionTtlMs,
    secureCookies: config.isProduction,
    loginRateLimitPerMinute: config.loginRateLimitPerMinute,
  });
  await app.register(accountRoutes);
  await app.register(notificationRoutes);
  await app.register(dashboardRoutes);
  await app.register(contactRoutes);
  await app.register(importRoutes);
  await app.register(toolRoutes);
  await app.register(assetRoutes);
  await app.register(campaignRoutes);
  await app.register(inboxRoutes);
  await app.register(reportRoutes);
  await app.register(systemRoutes);
  await app.register(deviceContactRoutes);
  await app.register(aiRoutes);
  await app.register(aiServiceRoutes);

  return app;
}
