import type { PrismaClient, AdminUser } from '@multizap/database';
import { LOGIN_LOCK_MINUTES, LOGIN_MAX_ATTEMPTS } from '@multizap/shared';
import { randomToken, sha256 } from '@multizap/shared/crypto';
import { hashPassword, verifyPassword } from '@multizap/shared/password';
import { Errors } from '../../lib/errors';

// Hash fixo usado quando o e-mail não existe, para equalizar o tempo de resposta.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomToken()));

export interface CreatedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessionTtlMs: number,
  ) {}

  /** Verifica credenciais com bloqueio progressivo. Mensagem genérica em qualquer falha. */
  async verifyCredentials(email: string, password: string): Promise<AdminUser> {
    const user = await this.prisma.adminUser.findUnique({ where: { email } });
    if (!user) {
      await verifyPassword(await getDummyHash(), password);
      throw Errors.invalidCredentials();
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) throw Errors.locked();

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= LOGIN_MAX_ATTEMPTS;
      await this.prisma.adminUser.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000) : null,
        },
      });
      throw lock ? Errors.locked() : Errors.invalidCredentials();
    }
    return user;
  }

  async createSession(
    userId: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<CreatedSession> {
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);
    const [session] = await this.prisma.$transaction([
      this.prisma.adminSession.create({
        data: {
          userId,
          tokenHash: sha256(token),
          csrfTokenHash: sha256(csrfToken),
          ip: meta.ip ?? null,
          userAgent: meta.userAgent?.slice(0, 500) ?? null,
          expiresAt,
        },
      }),
      this.prisma.adminUser.update({
        where: { id: userId },
        data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      }),
    ]);
    return { sessionId: session.id, token, csrfToken, expiresAt };
  }

  revokeSession(sessionId: string) {
    return this.prisma.adminSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Troca a senha e revoga todas as sessões; o chamador cria uma nova sessão. */
  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, current))) {
      throw Errors.invalidCredentials();
    }
    const passwordHash = await hashPassword(next);
    await this.prisma.$transaction([
      this.prisma.adminUser.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
      }),
      this.prisma.adminSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  listActiveSessions(userId: string) {
    return this.prisma.adminSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
  }
}
