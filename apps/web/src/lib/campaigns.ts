'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CampaignDTO,
  CampaignStatusValue,
  NextRecipientDTO,
  RecipientDTO,
} from '@multizap/shared';
import type { Tone } from '@multizap/ui';
import { api } from './api';
import { toQueryString } from './contacts';

export const CAMPAIGN_TONE: Record<CampaignStatusValue, Tone> = {
  DRAFT: 'neutral',
  SCHEDULED: 'info',
  READY: 'accent',
  RUNNING: 'accent',
  PAUSED: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
  FAILED: 'danger',
};

export const RECIPIENT_TONE: Record<string, Tone> = {
  PENDING: 'neutral',
  SENDING: 'info',
  SENT: 'accent',
  DELIVERED: 'success',
  READ: 'success',
  FAILED: 'danger',
  SKIPPED: 'warning',
};

const ACTIVE = ['SCHEDULED', 'READY', 'RUNNING'];

export function useCampaigns(q: { status?: string; from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['campaigns', q],
    queryFn: () =>
      api<{ items: CampaignDTO[] }>(`/campaigns?${toQueryString(q)}`).then((r) => r.items),
    refetchInterval: 15_000,
  });
}

export function useCampaign(id: string) {
  return useQuery({
    queryKey: ['campaign', id],
    queryFn: () =>
      api<{
        campaign: CampaignDTO;
        history: {
          id: string;
          action: string;
          details: Record<string, unknown>;
          createdAt: string;
        }[];
      }>(`/campaigns/${id}`),
    // Confirmações de entrega/leitura continuam chegando depois da conclusão.
    refetchInterval: (q) => {
      const st = q.state.data?.campaign.status;
      if (!st) return false;
      if (ACTIVE.includes(st)) return 3000;
      return st === 'COMPLETED' || st === 'PAUSED' ? 10_000 : false;
    },
  });
}

export function useRecipients(
  id: string,
  q: { accountId?: string; status?: string; page: number },
) {
  return useQuery({
    queryKey: ['campaign', id, 'recipients', q],
    queryFn: () =>
      api<{ items: RecipientDTO[]; total: number }>(
        `/campaigns/${id}/recipients?${toQueryString({ ...q, pageSize: 20 })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 3000,
  });
}

export function useNextRecipient(id: string, accountId: string | null) {
  return useQuery({
    queryKey: ['campaign', id, 'next', accountId],
    queryFn: () => api<NextRecipientDTO>(`/campaigns/${id}/next?accountId=${accountId}`),
    enabled: !!accountId,
    staleTime: 0,
  });
}

export function useCampaignAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      path,
      method = 'POST',
      json,
    }: {
      path: string;
      method?: 'POST' | 'PATCH' | 'DELETE';
      json?: unknown;
    }) => api<{ campaign?: CampaignDTO }>(path, { method, json }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['campaigns'] }),
        qc.invalidateQueries({ queryKey: ['campaign'] }),
        qc.invalidateQueries({ queryKey: ['dashboard'] }),
      ]),
  });
}
