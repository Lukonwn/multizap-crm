import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cabeçalhos de segurança, cookies, rate limit e bloqueio de requisições
 * entre sites (Origin / Sec-Fetch-Site) em métodos que alteram estado.
 */
export default fp(async function securityPlugin(app: FastifyInstance, opts: { webOrigin: string }) {
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    // Rotas internas (serviço → serviço) usam token próprio, sem navegador.
    if (req.url.startsWith('/internal/')) return;
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    if ((origin && origin !== opts.webOrigin) || fetchSite === 'cross-site') {
      throw new AppError(403, 'ORIGIN_REJECTED', 'Origem da requisição não permitida.');
    }
  });
});
