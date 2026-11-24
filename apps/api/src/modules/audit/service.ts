import type { PrismaClient, Prisma } from '@multizap/database';
import type { FastifyRequest } from 'fastify';

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  entityType?: string;
  entityId?: string;
  accountId?: string;
  details?: Prisma.InputJsonValue;
}

/** Registro de auditoria. Nunca incluir segredos em `details`. */
export async function audit(prisma: PrismaClient, req: FastifyRequest | null, entry: AuditEntry) {
  await prisma.auditLog.create({
    data: {
      action: entry.action,
      actorId: entry.actorId ?? null,
      entityType: entry.entityType,
      entityId: entry.entityId,
      accountId: entry.accountId,
      details: entry.details ?? {},
      ip: req?.ip ?? null,
      userAgent: req?.headers['user-agent']?.slice(0, 500) ?? null,
    },
  });
}
