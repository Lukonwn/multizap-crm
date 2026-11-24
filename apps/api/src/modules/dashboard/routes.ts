import type { FastifyInstance } from 'fastify';
import {
  ACCOUNT_STATUSES,
  MAX_ACCOUNTS,
  type AccountStatusValue,
  type ActivityItem,
  type DashboardSummary,
} from '@multizap/shared';
import { toNotificationDTO } from '../notifications/routes';

/** Texto das ações de auditoria exibidas em "Atividades recentes". */
const AUDIT_MESSAGES: Record<string, string> = {
  'account.created': 'Instância cadastrada',
  'account.updated': 'Dados da instância alterados',
  'account.deleted': 'Instância excluída',
  'account.disabled': 'Instância desativada',
  'account.enabled': 'Instância reativada',
  'account.pairing_requested': 'Pareamento solicitado',
  'account.reconnect_requested': 'Reconexão solicitada',
  'account.connection_removed': 'Conexão removida',
  'auth.password_changed': 'Senha do administrador alterada',
};

/** Eventos de conexão relevantes para o painel (exclui ruído técnico). */
const ACTIVITY_EVENT_TYPES = [
  'paired',
  'connected',
  'disconnected',
  'logged_out',
  'connection_replaced',
  'forbidden',
  'pairing_expired',
  'pairing_failed',
  'connection_removed',
];

export async function dashboardRoutes(app: FastifyInstance) {
  app.get(
    '/dashboard/summary',
    { preHandler: app.requireAuth },
    async (): Promise<DashboardSummary> => {
      const { prisma } = app;
      const [accounts, contactsTotal, contactsConsented, campaignGroups, events, audits, alerts] =
        await Promise.all([
          prisma.account.findMany({ orderBy: { createdAt: 'asc' } }),
          prisma.contact.count(),
          prisma.contact.count({ where: { consentStatus: 'GRANTED', optedOutAt: null } }),
          prisma.campaign.groupBy({ by: ['status'], _count: { _all: true } }),
          prisma.connectionEvent.findMany({
            where: { type: { in: ACTIVITY_EVENT_TYPES } },
            orderBy: { createdAt: 'desc' },
            take: 20,
            include: { account: { select: { name: true } } },
          }),
          prisma.auditLog.findMany({
            where: { action: { in: Object.keys(AUDIT_MESSAGES) } },
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
          prisma.systemNotification.findMany({
            where: { resolvedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 10,
          }),
        ]);

      const byStatus = Object.fromEntries(ACCOUNT_STATUSES.map((s) => [s, 0])) as Record<
        AccountStatusValue,
        number
      >;
      for (const a of accounts) byStatus[a.status]++;

      const names = new Map(accounts.map((a) => [a.id, a.name]));
      const activity: ActivityItem[] = [
        ...events.map((e) => ({
          id: e.id,
          kind: 'connection' as const,
          type: e.type,
          message: e.message ?? e.type,
          accountId: e.accountId,
          accountName: e.account.name,
          createdAt: e.createdAt.toISOString(),
        })),
        ...audits.map((a) => ({
          id: a.id,
          kind: 'audit' as const,
          type: a.action,
          message: AUDIT_MESSAGES[a.action] ?? a.action,
          accountId: a.accountId,
          accountName:
            (a.accountId && names.get(a.accountId)) ||
            ((a.details as { name?: string } | null)?.name ?? null),
          createdAt: a.createdAt.toISOString(),
        })),
      ]
        .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
        .slice(0, 15);

      const count = (status: string) =>
        campaignGroups.find((g) => g.status === status)?._count._all ?? 0;

      return {
        accounts: { total: accounts.length, limit: MAX_ACCOUNTS, byStatus },
        contacts: { total: contactsTotal, consented: contactsConsented },
        campaigns: {
          total: campaignGroups.reduce((sum, g) => sum + g._count._all, 0),
          scheduled: count('SCHEDULED'),
          completed: count('COMPLETED'),
        },
        connections: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          connectionType: a.connectionType,
          phoneE164: a.phoneE164,
          lastActivityAt: a.lastActivityAt?.toISOString() ?? null,
        })),
        activity,
        alerts: alerts.map(toNotificationDTO),
      };
    },
  );
}
