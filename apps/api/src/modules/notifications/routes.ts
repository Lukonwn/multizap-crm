import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SystemNotification } from '@multizap/database';
import type { NotificationDTO } from '@multizap/shared';
import { Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';

export function toNotificationDTO(n: SystemNotification): NotificationDTO {
  return {
    id: n.id,
    severity: n.severity,
    category: n.category,
    title: n.title,
    message: n.message,
    accountId: n.accountId,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

export async function notificationRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.requireAuth };

  /** Notificações ativas (não resolvidas), mais recentes primeiro. */
  app.get('/notifications', auth, async (req) => {
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
      req.query,
    );
    const where = { resolvedAt: null };
    const [items, unread] = await Promise.all([
      app.prisma.systemNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      app.prisma.systemNotification.count({ where: { ...where, readAt: null } }),
    ]);
    return { items: items.map(toNotificationDTO), unread };
  });

  app.post('/notifications/:id/read', auth, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await app.prisma.systemNotification.updateMany({
      where: { id, readAt: null },
      data: { readAt: new Date() },
    });
    if (r.count === 0 && !(await app.prisma.systemNotification.findUnique({ where: { id } }))) {
      throw Errors.notFound('Notificação não encontrada.');
    }
    return { ok: true };
  });

  app.post('/notifications/read-all', auth, async () => {
    await app.prisma.systemNotification.updateMany({
      where: { readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  });
}
