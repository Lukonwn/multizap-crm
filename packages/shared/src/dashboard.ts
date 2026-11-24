import type { AccountStatusValue, ConnectionTypeValue } from './accounts';

export interface ActivityItem {
  id: string;
  kind: 'connection' | 'audit';
  type: string;
  message: string;
  accountId: string | null;
  accountName: string | null;
  createdAt: string;
}

export interface NotificationDTO {
  id: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  category: string;
  title: string;
  message: string;
  accountId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface DashboardSummary {
  accounts: { total: number; limit: number; byStatus: Record<AccountStatusValue, number> };
  contacts: { total: number; consented: number };
  campaigns: { total: number; scheduled: number; completed: number };
  connections: {
    id: string;
    name: string;
    status: AccountStatusValue;
    connectionType: ConnectionTypeValue;
    phoneE164: string | null;
    lastActivityAt: string | null;
  }[];
  activity: ActivityItem[];
  alerts: NotificationDTO[];
}
