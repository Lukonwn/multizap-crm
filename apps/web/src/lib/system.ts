'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuditLogDTO,
  BackupDTO,
  OperationsPauseState,
  SystemEventDTO,
  SystemStatusDTO,
} from '@multizap/shared';
import { api } from './api';
import { toQueryString } from './contacts';

export const systemKeys = {
  status: ['system', 'status'] as const,
  operations: ['system', 'operations'] as const,
  events: (q: object) => ['system', 'events', q] as const,
  audit: (q: object) => ['audit', q] as const,
};

export function useSystemStatus() {
  return useQuery({
    queryKey: systemKeys.status,
    queryFn: () => api<SystemStatusDTO>('/system/status'),
    refetchInterval: 15_000,
  });
}

export function useOperations() {
  return useQuery({
    queryKey: systemKeys.operations,
    queryFn: () =>
      api<{ operations: OperationsPauseState }>('/system/operations').then((r) => r.operations),
    refetchInterval: 30_000,
  });
}

export function useSetOperations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { paused: boolean; reason?: string }) =>
      api<{ operations: OperationsPauseState }>('/system/operations', {
        method: 'PUT',
        json: body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['system'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useRequestBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ backup: BackupDTO }>('/system/backups', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: systemKeys.status }),
  });
}

export function useSystemEvents(q: { level?: string; page: number }) {
  return useQuery({
    queryKey: systemKeys.events(q),
    queryFn: () =>
      api<{ items: SystemEventDTO[]; total: number }>(
        `/system/events?${toQueryString({ ...q, pageSize: 15 })}`,
      ),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useResolveNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/resolve`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: systemKeys.status });
    },
  });
}

export function useAuditLog(q: { action?: string; page: number }) {
  return useQuery({
    queryKey: systemKeys.audit(q),
    queryFn: () =>
      api<{ items: AuditLogDTO[]; total: number }>(
        `/audit?${toQueryString({ ...q, pageSize: 20 })}`,
      ),
    placeholderData: (prev) => prev,
  });
}
