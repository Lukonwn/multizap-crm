import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@multizap/shared';
import { safeEqual, sha256 } from '@multizap/shared/crypto';
import { Errors } from '../lib/errors';

export interface AuthContext {
  sessionId: string;
  csrfTokenHash: string;
  user: {
    id: string;
    email: string;
    name: string;
    mustChangePassword: boolean;
    lastLoginAt: Date | null;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyContextConfig {
    /** Rota permitida enquanto a troca de senha obrigatória estiver pendente. */
    allowDuringPasswordChange?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

/**
 * Autenticação por sessão:
 *  - cookie httpOnly com token aleatório (no banco só o hash SHA-256);
 *  - expiração absoluta e por inatividade;
 *  - CSRF double-submit vinculado à sessão (cookie legível + cabeçalho);
 *  - troca de senha obrigatória bloqueia as demais rotas.
 */
export default fp(async function authPlugin(app: FastifyInstance, opts: { sessionIdleMs: number }) {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await app.prisma.adminSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    const now = Date.now();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now ||
      session.lastSeenAt.getTime() + opts.sessionIdleMs <= now
    ) {
      return;
    }
    if (now - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await app.prisma.adminSession.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(now) },
      });
    }
    req.auth = {
      sessionId: session.id,
      csrfTokenHash: session.csrfTokenHash,
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        mustChangePassword: session.user.mustChangePassword,
        lastLoginAt: session.user.lastLoginAt,
      },
    };
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.auth) throw Errors.unauthorized();
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers[CSRF_HEADER];
      const cookie = req.cookies[CSRF_COOKIE];
      if (
        typeof header !== 'string' ||
        !cookie ||
        !safeEqual(header, cookie) ||
        !safeEqual(sha256(header), req.auth.csrfTokenHash)
      ) {
        throw Errors.csrf();
      }
    }
    if (req.auth.user.mustChangePassword && !req.routeOptions.config.allowDuringPasswordChange) {
      throw Errors.passwordChangeRequired();
    }
  });
});
