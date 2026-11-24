import type { PrismaClient } from '@prisma/client';
import { hashPassword } from '@multizap/shared/password';

/**
 * Cria o administrador inicial se nenhum existir.
 * Idempotente: não altera um administrador existente.
 */
export async function ensureBootstrapAdmin(
  prisma: PrismaClient,
  opts: { email?: string; password?: string; name?: string },
): Promise<'created' | 'exists' | 'skipped'> {
  const count = await prisma.adminUser.count();
  if (count > 0) return 'exists';
  if (!opts.email || !opts.password) return 'skipped';
  await prisma.adminUser.create({
    data: {
      email: opts.email.trim().toLowerCase(),
      name: opts.name ?? 'Administrador',
      passwordHash: await hashPassword(opts.password),
      mustChangePassword: true,
    },
  });
  return 'created';
}
