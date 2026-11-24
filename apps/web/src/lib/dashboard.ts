'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DashboardSummary, NotificationDTO } from '@multizap/shared';
import { api } from './api';

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<DashboardSummary>('/dashboard/summary'),
    refetchInterval: 15_000,
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ items: NotificationDTO[]; unread: number }>('/notifications?limit=20'),
    refetchInterval: 20_000,
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id?: string) =>
      api(id ? `/notifications/${id}/read` : '/notifications/read-all', { method: 'POST' }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['notifications'] }),
        qc.invalidateQueries({ queryKey: ['dashboard'] }),
      ]),
  });
}
