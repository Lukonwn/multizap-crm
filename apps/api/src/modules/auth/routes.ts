import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  changePasswordSchema,
  loginSchema,
  type AdminProfile,
  type SessionInfo,
} from '@multizap/shared';
import { parse } from '../../lib/validate';
import { Errors } from '../../lib/errors';
import { audit } from '../audit/service';
import { AuthService, type CreatedSession } from './service';

export async function authRoutes(
  app: FastifyInstance,
  opts: { sessionTtlMs: number; secureCookies: boolean; loginRateLimitPerMinute: number },
) {
  const service = new AuthService(app.prisma, opts.sessionTtlMs);

  const setSessionCookies = (reply: FastifyReply, s: CreatedSession) => {
    const base = {
      path: '/',
      sameSite: 'strict' as const,
      secure: opts.secureCookies,
      expires: s.expiresAt,
    };
    reply.setCookie(SESSION_COOKIE, s.token, { ...base, httpOnly: true });
    // Legível pelo frontend para ser reenviado no cabeçalho x-csrf-token.
    reply.setCookie(CSRF_COOKIE, s.csrfToken, { ...base, httpOnly: false });
  };
  const clearSessionCookies = (reply: FastifyReply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
  };
  const toProfile = (u: {
    id: string;
    email: string;
    name: string;
    mustChangePassword: boolean;
    lastLoginAt: Date | null;
  }): AdminProfile => ({
    id: u.id,
    email: u.email,
    name: u.name,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  });

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: opts.loginRateLimitPerMinute, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = parse(loginSchema, req.body);
      let user;
      try {
        user = await service.verifyCredentials(input.email, input.password);
      } catch (err) {
        await audit(app.prisma, req, {
          action: 'auth.login_failed',
          details: { email: input.email },
        });
        throw err;
      }
      const session = await service.createSession(user.id, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      setSessionCookies(reply, session);
      await audit(app.prisma, req, {
        action: 'auth.login',
        actorId: user.id,
        entityType: 'admin_session',
        entityId: session.sessionId,
      });
      return { user: toProfile({ ...user, lastLoginAt: new Date() }) };
    },
  );

  app.post(
    '/auth/logout',
    { preHandler: app.requireAuth, config: { allowDuringPasswordChange: true } },
    async (req, reply) => {
      await service.revokeSession(req.auth!.sessionId);
      clearSessionCookies(reply);
      await audit(app.prisma, req, { action: 'auth.logout', actorId: req.auth!.user.id });
      return { ok: true };
    },
  );

  app.get(
    '/auth/me',
    { preHandler: app.requireAuth, config: { allowDuringPasswordChange: true } },
    async (req) => ({ user: toProfile(req.auth!.user) }),
  );

  app.post(
    '/auth/change-password',
    {
      preHandler: app.requireAuth,
      config: { allowDuringPasswordChange: true, rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const input = parse(changePasswordSchema, req.body);
      const userId = req.auth!.user.id;
      await service.changePassword(userId, input.currentPassword, input.newPassword);
      // Todas as sessões anteriores foram revogadas; emite uma nova para este navegador.
      const session = await service.createSession(userId, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      setSessionCookies(reply, session);
      await audit(app.prisma, req, { action: 'auth.password_changed', actorId: userId });
      return {
        user: toProfile({ ...req.auth!.user, mustChangePassword: false, lastLoginAt: new Date() }),
      };
    },
  );

  app.get('/auth/sessions', { preHandler: app.requireAuth }, async (req) => {
    const sessions = await service.listActiveSessions(req.auth!.user.id);
    const items: SessionInfo[] = sessions.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      current: s.id === req.auth!.sessionId,
    }));
    return { items };
  });

  app.delete('/auth/sessions/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const session = await app.prisma.adminSession.findFirst({
      where: { id, userId: req.auth!.user.id },
    });
    if (!session) throw Errors.notFound('Sessão não encontrada.');
    await service.revokeSession(id);
    await audit(app.prisma, req, {
      action: 'auth.session_revoked',
      actorId: req.auth!.user.id,
      entityType: 'admin_session',
      entityId: id,
    });
    return { ok: true };
  });
}
