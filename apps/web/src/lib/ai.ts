'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentDTO,
  AiConversationDTO,
  AiDraftDTO,
  AiUsageSummaryDTO,
  AgentVersionDTO,
  AiModelDTO,
  AiSettingsDTO,
  PersonaDTO,
  PersonaRevisionDTO,
  TestSessionDTO,
} from '@multizap/shared';
import { api } from './api';
import { toQueryString } from './contacts';

export const aiKeys = {
  all: ['ai'] as const,
  settings: ['ai', 'settings'] as const,
  models: (q: string) => ['ai', 'models', q] as const,
  personas: (templates?: string) => ['ai', 'personas', templates ?? 'all'] as const,
  persona: (id: string) => ['ai', 'persona', id] as const,
  revisions: (id: string) => ['ai', 'persona', id, 'revisions'] as const,
  agents: ['ai', 'agents'] as const,
  agent: (id: string) => ['ai', 'agent', id] as const,
  versions: (id: string) => ['ai', 'agent', id, 'versions'] as const,
  session: (id: string) => ['ai', 'session', id] as const,
  conversations: (filter: string, accountId: string) =>
    ['ai', 'conversations', filter, accountId] as const,
  drafts: (conversationId: string) => ['ai', 'drafts', conversationId] as const,
  usage: (agentId: string) => ['ai', 'usage', agentId] as const,
};

export function useAiSettings() {
  return useQuery({ queryKey: aiKeys.settings, queryFn: () => api<AiSettingsDTO>('/ai/settings') });
}

export function useAiModels(q: string, enabled = true) {
  return useQuery({
    queryKey: aiKeys.models(q),
    queryFn: () =>
      api<{ items: AiModelDTO[]; total: number }>(
        `/ai/models?${toQueryString({ q: q || undefined })}`,
      ),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}

export function usePersonas(templates?: 'true' | 'false') {
  return useQuery({
    queryKey: aiKeys.personas(templates),
    queryFn: () => api<{ items: PersonaDTO[] }>(`/ai/personas?${toQueryString({ templates })}`),
  });
}

export function usePersona(id: string | null) {
  return useQuery({
    queryKey: aiKeys.persona(id ?? ''),
    queryFn: () => api<{ persona: PersonaDTO }>(`/ai/personas/${id}`).then((r) => r.persona),
    enabled: !!id,
  });
}

export function usePersonaRevisions(id: string | null) {
  return useQuery({
    queryKey: aiKeys.revisions(id ?? ''),
    queryFn: () =>
      api<{ items: PersonaRevisionDTO[] }>(`/ai/personas/${id}/revisions`).then((r) => r.items),
    enabled: !!id,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: aiKeys.agents,
    queryFn: () => api<{ items: AgentDTO[] }>('/ai/agents'),
  });
}

export function useAgent(id: string | null) {
  return useQuery({
    queryKey: aiKeys.agent(id ?? ''),
    queryFn: () => api<{ agent: AgentDTO }>(`/ai/agents/${id}`).then((r) => r.agent),
    enabled: !!id,
  });
}

export function useAgentVersions(id: string | null) {
  return useQuery({
    queryKey: aiKeys.versions(id ?? ''),
    queryFn: () =>
      api<{ items: AgentVersionDTO[] }>(`/ai/agents/${id}/versions`).then((r) => r.items),
    enabled: !!id,
  });
}

export function useTestSession(id: string | null) {
  return useQuery({
    queryKey: aiKeys.session(id ?? ''),
    queryFn: () =>
      api<{ session: TestSessionDTO }>(`/ai/test-sessions/${id}`).then((r) => r.session),
    enabled: !!id,
  });
}

export function useAiConversations(filter: string, accountId: string) {
  return useQuery({
    queryKey: aiKeys.conversations(filter, accountId),
    queryFn: () =>
      api<{ items: AiConversationDTO[] }>(
        `/ai/conversations?${toQueryString({ filter, accountId: accountId || undefined })}`,
      ).then((r) => r.items),
    refetchInterval: 5000,
  });
}

export function useAiDrafts(conversationId: string | null) {
  return useQuery({
    queryKey: aiKeys.drafts(conversationId ?? ''),
    queryFn: () =>
      api<{ items: AiDraftDTO[] }>(
        `/ai/drafts?${toQueryString({ status: 'PENDING', conversationId: conversationId ?? undefined })}`,
      ).then((r) => r.items),
    enabled: !!conversationId,
    refetchInterval: 4000,
  });
}

export function useAiUsage(agentId: string | null) {
  return useQuery({
    queryKey: aiKeys.usage(agentId ?? ''),
    queryFn: () =>
      api<AiUsageSummaryDTO>(`/ai/usage?${toQueryString({ agentId: agentId ?? undefined })}`),
    enabled: !!agentId,
  });
}

/** Mutação genérica do MultiZap AI: invalida os dados da área ao terminar. */
export function useAiMutation<T = unknown>() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      path,
      method = 'POST',
      json,
    }: {
      path: string;
      method?: string;
      json?: unknown;
    }) => api<T>(path, { method, ...(json !== undefined && { json }) }),
    // Exclusões só marcam os dados como desatualizados: a tela recarrega o que ainda existe
    // (evita buscar de novo o item que acabou de ser removido).
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({
        queryKey: aiKeys.all,
        ...(vars.method === 'DELETE' && { refetchType: 'none' as const }),
      }),
  });
}

/** Dólares com casas suficientes para valores pequenos. */
export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v === 0) return 'US$ 0';
  return `US$ ${v < 0.01 ? v.toFixed(5) : v.toFixed(2)}`;
}
