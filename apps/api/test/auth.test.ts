import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import { LOGIN_MAX_ATTEMPTS } from '@multizap/shared';
import {
  ADMIN,
  WEB_ORIGIN,
  authed,
  createAdmin,
  login,
  resetDb,
  sessionFrom,
  setupTestApp,
} from './helpers';

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
beforeEach(async () => {
  await resetDb(prisma);
});

describe('login', () => {
  it('autentica, define cookies seguros e registra auditoria', async () => {
    await createAdmin(prisma);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: WEB_ORIGIN },
      payload: { email: ' ADMIN@multizap.local ', password: ADMIN.password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(ADMIN.email);
    const session = res.cookies.find((c) => c.name === 'mz_session')!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe('Strict');
    const csrf = res.cookies.find((c) => c.name === 'mz_csrf')!;
    expect(csrf.httpOnly).toBeFalsy();

    // o token nunca é salvo em texto aberto
    const stored = await prisma.adminSession.findFirstOrThrow();
    expect(stored.tokenHash).not.toBe(session.value);
    expect(await prisma.auditLog.count({ where: { action: 'auth.login' } })).toBe(1);
  });

  it('retorna mensagem genérica para e-mail inexistente e senha errada', async () => {
    await createAdmin(prisma);
    const a = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'x@y.com', password: 'abc' },
    });
    const b = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN.email, password: 'errada' },
    });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error.message).toBe(b.json().error.message);
    expect(await prisma.auditLog.count({ where: { action: 'auth.login_failed' } })).toBe(2);
  });

  it('bloqueia temporariamente após tentativas excessivas', async () => {
    await createAdmin(prisma);
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: ADMIN.email, password: 'errada' },
      });
      expect(r.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN.email, password: 'errada' },
    });
    expect(locked.statusCode).toBe(423);
    // mesmo com a senha correta, permanece bloqueado
    const still = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(still.statusCode).toBe(423);
  });

  it('valida a entrada', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'invalido' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_ERROR');
    expect(r.json().error.fields.email).toBeDefined();
  });

  it('rejeita requisições de outra origem', async () => {
    await createAdmin(prisma);
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('ORIGIN_REJECTED');
  });
});

describe('sessão', () => {
  it('exige autenticação em /auth/me', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(r.statusCode).toBe(401);
  });

  it('retorna o perfil com sessão válida', async () => {
    await createAdmin(prisma);
    const s = await login(app);
    const r = await app.inject({ method: 'GET', url: '/auth/me', headers: authed(s, false) });
    expect(r.statusCode).toBe(200);
    expect(r.json().user).toMatchObject({ email: ADMIN.email, mustChangePassword: false });
  });

  it('exige CSRF em métodos que alteram estado', async () => {
    await createAdmin(prisma);
    const s = await login(app);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: authed(s, false),
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('CSRF_INVALID');
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...authed(s, false), 'x-csrf-token': 'forjado' },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('não aceita o CSRF de outra sessão', async () => {
    await createAdmin(prisma);
    const a = await login(app);
    const b = await login(app);
    const r = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: `mz_session=${a.token}; mz_csrf=${b.csrf}`,
        origin: WEB_ORIGIN,
        'x-csrf-token': b.csrf,
      },
    });
    expect(r.statusCode).toBe(403);
  });

  it('logout revoga a sessão', async () => {
    await createAdmin(prisma);
    const s = await login(app);
    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: authed(s) });
    expect(out.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: authed(s, false) });
    expect(me.statusCode).toBe(401);
  });

  it('rejeita sessão expirada por inatividade', async () => {
    await createAdmin(prisma);
    const s = await login(app);
    await prisma.adminSession.updateMany({
      data: { lastSeenAt: new Date(Date.now() - 13 * 3_600_000) },
    });
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: authed(s, false) });
    expect(me.statusCode).toBe(401);
  });

  it('lista e revoga outras sessões', async () => {
    await createAdmin(prisma);
    const a = await login(app);
    const b = await login(app);
    const list = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: authed(a, false),
    });
    const items = list.json().items as { id: string; current: boolean }[];
    expect(items).toHaveLength(2);
    const other = items.find((i) => !i.current)!;
    const del = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${other.id}`,
      headers: authed(a),
    });
    expect(del.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: authed(b, false) });
    expect(me.statusCode).toBe(401);
  });
});

describe('troca de senha', () => {
  it('troca obrigatória bloqueia as demais rotas até ser concluída', async () => {
    await createAdmin(prisma, { mustChangePassword: true });
    const s = await login(app);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: authed(s, false) });
    expect(me.json().user.mustChangePassword).toBe(true);
    const blocked = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: authed(s, false),
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: authed(s),
      payload: { currentPassword: ADMIN.password, newPassword: 'Nova-Senha-Forte-456' },
    });
    expect(changed.statusCode).toBe(200);

    // a sessão antiga foi revogada; a nova (dos cookies da resposta) funciona
    const old = await app.inject({ method: 'GET', url: '/auth/me', headers: authed(s, false) });
    expect(old.statusCode).toBe(401);
    const fresh = sessionFrom(changed.cookies as { name: string; value: string }[]);
    const ok = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: authed(fresh, false),
    });
    expect(ok.statusCode).toBe(200);

    await expect(login(app, 'Nova-Senha-Forte-456')).resolves.toBeDefined();
    await expect(login(app, ADMIN.password)).rejects.toThrow();
  });

  it('aplica a política de senha e confere a senha atual', async () => {
    await createAdmin(prisma);
    const s = await login(app);
    const weak = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: authed(s),
      payload: { currentPassword: ADMIN.password, newPassword: 'fraca' },
    });
    expect(weak.statusCode).toBe(400);
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: authed(s),
      payload: { currentPassword: 'Errada-Senha-000', newPassword: 'Nova-Senha-Forte-456' },
    });
    expect(wrong.statusCode).toBe(401);
  });
});
