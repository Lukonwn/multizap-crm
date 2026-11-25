'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentDTO,
  AiAnalyticsDTO,
  AiConversationDTO,
  AiHealthDTO,
  AiDeliverableDTO,
  AiDeliveryDTO,
  AiPaymentWebhookDTO,
  AiGenerationDTO,
  AiKnowledgeSourceDTO,
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
  knowledge: (q: string) => ['ai', 'knowledge', q] as const,
  knowledgeDetail: (id: string) => ['ai', 'knowledge', 'detail', id] as const,
  agentKnowledge: (id: string) => ['ai', 'agent', id, 'knowledge'] as const,
  deliverables: ['ai', 'deliverables'] as const,
  agentDeliverables: (id: string) => ['ai', 'agent', id, 'deliverables'] as const,
  deliveries: (conversationId: string) => ['ai', 'deliveries', conversationId] as const,
  paymentWebhook: ['ai', 'payments', 'webhook'] as const,
  analytics: (days: number, agentId: string, accountId: string) =>
    ['ai', 'analytics', days, agentId, accountId] as const,
  health: ['ai', 'health'] as const,
  generations: ['ai', 'generator'] as const,
  generation: (id: string) => ['ai', 'generator', id] as const,
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

/** Fontes de conhecimento. Enquanto alguma está na fila ou processando, a lista se atualiza sozinha. */
export function useKnowledge(filters: { kind?: string; status?: string; q?: string } = {}) {
  const qs = toQueryString(filters);
  return useQuery({
    queryKey: aiKeys.knowledge(qs),
    queryFn: () => api<{ items: AiKnowledgeSourceDTO[]; limit: number }>(`/ai/knowledge?${qs}`),
    refetchInterval: (q) =>
      q.state.data?.items.some((i) => i.status === 'PENDING' || i.status === 'PROCESSING')
        ? 2500
        : false,
  });
}

export function useKnowledgeDetail(id: string | null) {
  return useQuery({
    queryKey: aiKeys.knowledgeDetail(id ?? ''),
    queryFn: () =>
      api<{
        source: AiKnowledgeSourceDTO & { content: string | null };
        chunks: { id: string; position: number; title: string | null; content: string }[];
      }>(`/ai/knowledge/${id}`),
    enabled: !!id,
  });
}

export function useAgentKnowledge(agentId: string | null) {
  return useQuery({
    queryKey: aiKeys.agentKnowledge(agentId ?? ''),
    queryFn: () =>
      api<{ sourceIds: string[] }>(`/ai/agents/${agentId}/knowledge`).then((r) => r.sourceIds),
    enabled: !!agentId,
  });
}

/** Envio de arquivo (multipart) para a base de conhecimento. */
export async function uploadKnowledgeFile(file: File, name: string): Promise<AiKnowledgeSourceDTO> {
  const form = new FormData();
  if (name.trim()) form.append('name', name.trim());
  form.append('file', file);
  const csrf = document.cookie
    .split('; ')
    .find((c) => c.startsWith('mz_csrf='))
    ?.slice('mz_csrf='.length);
  const res = await fetch('/api/ai/knowledge/file', {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
    headers: csrf ? { 'x-csrf-token': csrf } : {},
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? 'Não foi possível enviar o arquivo.');
  return data.source;
}

export function useDeliverables() {
  return useQuery({
    queryKey: aiKeys.deliverables,
    queryFn: () => api<{ items: AiDeliverableDTO[] }>('/ai/deliverables').then((r) => r.items),
  });
}

export function useAgentDeliverables(agentId: string | null) {
  return useQuery({
    queryKey: aiKeys.agentDeliverables(agentId ?? ''),
    queryFn: () =>
      api<{ deliverableIds: string[] }>(`/ai/agents/${agentId}/deliverables`).then(
        (r) => r.deliverableIds,
      ),
    enabled: !!agentId,
  });
}

/** Entregas de uma conversa; atualiza sozinha enquanto há algo em andamento. */
export function useDeliveries(conversationId: string | null) {
  return useQuery({
    queryKey: aiKeys.deliveries(conversationId ?? ''),
    queryFn: () =>
      api<{ items: AiDeliveryDTO[] }>(
        `/ai/deliveries?${toQueryString({ conversationId: conversationId ?? undefined })}`,
      ).then((r) => r.items),
    enabled: !!conversationId,
    refetchInterval: 4000,
  });
}

export function usePaymentWebhook() {
  return useQuery({
    queryKey: aiKeys.paymentWebhook,
    queryFn: () => api<AiPaymentWebhookDTO>('/ai/payments/webhook'),
  });
}

export function useAnalytics(days: number, agentId: string, accountId: string) {
  return useQuery({
    queryKey: aiKeys.analytics(days, agentId, accountId),
    queryFn: () =>
      api<AiAnalyticsDTO>(
        `/ai/analytics?${toQueryString({ days, agentId: agentId || undefined, accountId: accountId || undefined })}`,
      ),
    refetchInterval: 30_000,
  });
}

export function useAiHealth() {
  return useQuery({
    queryKey: aiKeys.health,
    queryFn: () => api<AiHealthDTO>('/ai/health'),
    refetchInterval: 15_000,
  });
}

/** Gerações recentes do Gerador de Persona (sem o pacote). */
export function useGenerations() {
  return useQuery({
    queryKey: aiKeys.generations,
    queryFn: () => api<{ items: AiGenerationDTO[] }>('/ai/generator').then((r) => r.items),
    refetchInterval: (q) =>
      q.state.data?.some((g) => g.status === 'PENDING' || g.status === 'PROCESSING') ? 3000 : false,
  });
}

/** Uma geração, atualizada sozinha enquanto está na fila ou processando. */
export function useGeneration(id: string | null) {
  return useQuery({
    queryKey: aiKeys.generation(id ?? ''),
    queryFn: () =>
      api<{ generation: AiGenerationDTO }>(`/ai/generator/${id}`).then((r) => r.generation),
    enabled: !!id,
    refetchInterval: (q) =>
      q.state.data?.status === 'PENDING' || q.state.data?.status === 'PROCESSING' ? 2500 : false,
  });
}

/** Envia o pedido do Gerador de Persona (multipart: descrição, links, documentos e imagens). */
export async function createGeneration(input: {
  description: string;
  model: string;
  links: string[];
  targetAgentId?: string;
  docs: File[];
  images: File[];
}): Promise<AiGenerationDTO> {
  const form = new FormData();
  form.append('description', input.description);
  form.append('model', input.model);
  form.append('links', JSON.stringify(input.links));
  if (input.targetAgentId) form.append('targetAgentId', input.targetAgentId);
  for (const f of [...input.docs, ...input.images]) form.append('files', f);
  const csrf = document.cookie
    .split('; ')
    .find((c) => c.startsWith('mz_csrf='))
    ?.slice('mz_csrf='.length);
  const res = await fetch('/api/ai/generator', {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
    headers: csrf ? { 'x-csrf-token': csrf } : {},
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? 'Não foi possível enviar o pedido.');
  return data.generation;
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
