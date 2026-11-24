'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderCapabilities } from '@multizap/integrations';
import type {
  AccountDTO,
  AccountStatusValue,
  ConnectionEventDTO,
  CreateAccountInput,
  PairingState,
  StartPairingInput,
} from '@multizap/shared';
import type { Tone } from '@multizap/ui';
import { api } from './api';

export const accountKeys = {
  all: ['accounts'] as const,
  detail: (id: string) => ['accounts', id] as const,
  events: (id: string) => ['accounts', id, 'events'] as const,
  pairing: (id: string) => ['accounts', id, 'pairing'] as const,
};

export const STATUS_TONE: Record<AccountStatusValue, Tone> = {
  CONNECTED: 'success',
  AWAITING_CONNECTION: 'info',
  NOT_CONFIGURED: 'neutral',
  DISCONNECTED: 'warning',
  ATTENTION: 'warning',
  NEEDS_REPAIR: 'danger',
  DISABLED: 'neutral',
};

export function useAccounts() {
  return useQuery({
    queryKey: accountKeys.all,
    queryFn: () => api<{ items: AccountDTO[]; limit: number }>('/accounts'),
    refetchInterval: 10_000,
  });
}

export function useAccount(id: string) {
  return useQuery({
    queryKey: accountKeys.detail(id),
    queryFn: () =>
      api<{ account: AccountDTO; capabilities: ProviderCapabilities }>(`/accounts/${id}`),
    refetchInterval: 10_000,
  });
}

export function useAccountEvents(id: string) {
  return useQuery({
    queryKey: accountKeys.events(id),
    queryFn: () =>
      api<{ items: ConnectionEventDTO[] }>(`/accounts/${id}/events?limit=50`).then((r) => r.items),
    refetchInterval: 10_000,
  });
}

export function usePairingState(id: string, enabled: boolean) {
  return useQuery({
    queryKey: accountKeys.pairing(id),
    queryFn: () =>
      api<{ state: PairingState | null; status: AccountStatusValue; statusReason: string | null }>(
        `/accounts/${id}/pairing`,
      ),
    enabled,
    refetchInterval: enabled ? 1_500 : false,
    staleTime: 0,
  });
}

/** Invalida tudo o que depende do estado das instâncias. */
export function useInvalidateAccounts() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: accountKeys.all }),
      qc.invalidateQueries({ queryKey: ['dashboard'] }),
      qc.invalidateQueries({ queryKey: ['notifications'] }),
    ]);
}

export function useCreateAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (input: CreateAccountInput) =>
      api<{ account: AccountDTO }>('/accounts', { method: 'POST', json: input }),
    onSuccess: () => invalidate(),
  });
}

export function useStartPairing(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartPairingInput) =>
      api(`/accounts/${id}/pairing`, { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: accountKeys.pairing(id) }),
  });
}

/** Ação simples sobre a instância (POST/DELETE sem retorno relevante). */
export function useAccountAction(id: string) {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: ({
      path,
      method = 'POST',
      json,
    }: {
      path: string;
      method?: 'POST' | 'DELETE' | 'PATCH';
      json?: unknown;
    }) => api(`/accounts/${id}${path}`, { method, json }),
    onSuccess: () => invalidate(),
  });
}
