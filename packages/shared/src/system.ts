import { z } from 'zod';

/** Fila de manutenção (worker): backups e limpeza. */
export const MAINTENANCE_QUEUE = 'maintenance';

export type MaintenanceJob = { type: 'backup'; backupId: string } | { type: 'cleanup' };

/** Conteúdo publicado pelo worker no heartbeat (lido pela API). */
export interface WorkerHeartbeat {
  at: string;
  pid: number;
  queues?: string[];
  backup?: {
    configured: boolean;
    storageOk: boolean | null;
    error: string | null;
    hourLocal: number;
    retentionDays: number;
    nextAt: string | null;
  };
}

/** Resultado da última limpeza (system_settings, chave maintenance_last_cleanup). */
export interface CleanupResult {
  at: string;
  toolJobsExpired: number;
  orphanUploadsRemoved: number;
  importFilesRemoved: number;
  sessionsRemoved: number;
  eventsRemoved: number;
  notificationsRemoved: number;
  errors: string[];
}
export const CLEANUP_SETTING_KEY = 'maintenance_last_cleanup';

export type ServiceState = 'up' | 'down' | 'unconfigured';
export interface ServiceCheck {
  status: ServiceState;
  latencyMs?: number;
  error?: string;
  detail?: string;
}

export interface QueueCounts {
  name: string;
  label: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export interface BackupDTO {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  trigger: string;
  sizeBytes: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface OperationsPauseState {
  paused: boolean;
  reason: string | null;
  at: string | null;
  by: string | null;
}

export interface SystemStatusDTO {
  checkedAt: string;
  services: Record<'api' | 'database' | 'redis' | 'storage' | 'worker' | 'gateway', ServiceCheck>;
  queues: QueueCounts[];
  connections: {
    total: number;
    byStatus: Record<string, number>;
    attention: {
      id: string;
      name: string;
      status: string;
      reason: string | null;
      lastError: string | null;
      lastCheckAt: string | null;
    }[];
  };
  errors24h: {
    systemEvents: number;
    importsFailed: number;
    toolJobsFailed: number;
    campaignSendsFailed: number;
    repliesFailed: number;
    backupsFailed: number;
  };
  notifications: { open: number; critical: number; error: number; warning: number };
  operations: OperationsPauseState;
  backups: {
    configured: boolean;
    storage: ServiceCheck;
    hourLocal: number | null;
    retentionDays: number | null;
    nextAt: string | null;
    lastSuccessAt: string | null;
    running: boolean;
    items: BackupDTO[];
  };
  cleanup: CleanupResult | null;
}

export interface SystemEventDTO {
  id: string;
  source: string;
  level: string;
  type: string;
  message: string;
  createdAt: string;
}

export interface AuditLogDTO {
  id: string;
  action: string;
  actorEmail: string | null;
  entityType: string | null;
  entityId: string | null;
  accountId: string | null;
  ip: string | null;
  details: unknown;
  createdAt: string;
}

export const operationsPauseSchema = z.object({
  paused: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

export const QUEUE_LABEL: Record<string, string> = {
  imports: 'Importações',
  'file-tools': 'Ferramentas',
  campaigns: 'Campanhas',
  'gateway-commands': 'Gateway',
  maintenance: 'Backups',
};

/** Rótulos das ações de auditoria exibidas no painel. */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Login',
  'auth.login_failed': 'Login recusado',
  'auth.logout': 'Logout',
  'auth.password_changed': 'Senha alterada',
  'auth.session_revoked': 'Sessão encerrada',
  'operations.paused': 'Operações pausadas',
  'operations.resumed': 'Operações retomadas',
  'backup.requested': 'Backup solicitado',
  'notification.resolved': 'Notificação resolvida',
  'account.created': 'Instância criada',
  'account.updated': 'Instância editada',
  'account.deleted': 'Instância excluída',
  'account.disabled': 'Instância desativada',
  'account.enabled': 'Instância reativada',
  'account.pairing_requested': 'Pareamento solicitado',
  'account.reconnect_requested': 'Reconexão solicitada',
  'account.connection_removed': 'Conexão removida',
  'contact.created': 'Contato criado',
  'contact.updated': 'Contato editado',
  'contact.deleted': 'Contato excluído',
  'contact.exported': 'Contatos exportados',
  'contact.imported_from_device': 'Contatos importados da agenda do aparelho',
  'contact.opted_out': 'Contato descadastrado',
  'contact.resubscribed': 'Contato reautorizado',
  'import.uploaded': 'Arquivo de importação enviado',
  'import.confirmed': 'Importação confirmada',
  'import.cancelled': 'Importação cancelada',
  'tool.started': 'Ferramenta executada',
  'tool.deleted': 'Resultado de ferramenta excluído',
  'asset.uploaded': 'Criativo enviado',
  'asset.created': 'Criativo criado',
  'asset.updated': 'Criativo editado',
  'asset.deleted': 'Criativo excluído',
  'campaign.message_confirmed': 'Envio de campanha confirmado',
  'conversation.replied': 'Resposta enviada',
  'conversation.started': 'Nova conversa iniciada',
  'ai.key_updated': 'Chave da OpenRouter salva',
  'ai.key_removed': 'Chave da OpenRouter removida',
  'ai.persona_created': 'Persona criada',
  'ai.persona_updated': 'Persona alterada',
  'ai.persona_deleted': 'Persona excluída',
  'ai.agent_created': 'Agente criado',
  'ai.agent_updated': 'Agente alterado',
  'ai.agent_accounts_updated': 'Instâncias do agente alteradas',
  'ai.agent_published': 'Agente publicado',
  'ai.agent_restored': 'Versão do agente restaurada',
  'ai.agent_deleted': 'Agente excluído',
  'conversation.closed': 'Conversa finalizada',
  'conversation.reopened': 'Conversa reaberta',
};
