import type { Account, ConnectionEvent, Integration } from '@multizap/database';
import type { AccountDTO, ConnectionEventDTO } from '@multizap/shared';

export function toAccountDTO(a: Account & { integration: Integration | null }): AccountDTO {
  return {
    id: a.id,
    name: a.name,
    phoneE164: a.phoneE164,
    connectionType: a.connectionType,
    status: a.status,
    statusReason: a.statusReason,
    lastActivityAt: a.lastActivityAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    integration: a.integration
      ? {
          provider: a.integration.provider,
          waJid: a.integration.waJid,
          deviceName: a.integration.deviceName,
          pairedAt: a.integration.pairedAt?.toISOString() ?? null,
          lastCheckAt: a.integration.lastCheckAt?.toISOString() ?? null,
          lastError: a.integration.lastError,
          hasCredentials: !!a.integration.credentialsEnc,
        }
      : null,
  };
}

export function toEventDTO(e: ConnectionEvent): ConnectionEventDTO {
  return {
    id: e.id,
    type: e.type,
    message: e.message,
    details: (e.details ?? {}) as Record<string, unknown>,
    createdAt: e.createdAt.toISOString(),
  };
}
