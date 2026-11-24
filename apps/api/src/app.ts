import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import type { AppConfig } from './config';
import { AppError } from './lib/errors';
import securityPlugin from './plugins/security';
import authPlugin from './plugins/auth';
import { authRoutes } from './modules/auth/routes';
import { healthRoutes } from './modules/health/routes';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis | null;
    config: AppConfig;
  }
}

export interface BuildDeps {
  config: AppConfig;
  prisma: PrismaClient;
  redis: Redis | null;
  logger?: boolean;
}

export async function buildApp({
  config,
  prisma,
  redis,
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

  await app.register(sensible);
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

  return app;
}
