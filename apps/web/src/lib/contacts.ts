'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ContactDTO,
  ContactHistoryItem,
  ContactListQuery,
  ImportDTO,
  ImportRowDTO,
  TagDTO,
} from '@multizap/shared';
import type { Tone } from '@multizap/ui';
import { api } from './api';

export const CONSENT_TONE: Record<ContactDTO['consentStatus'], Tone> = {
  PENDING: 'neutral',
  GRANTED: 'success',
  REVOKED: 'danger',
};

export const contactKeys = {
  list: (accountId: string, q: object) => ['contacts', accountId, 'list', q] as const,
  detail: (accountId: string, id: string) => ['contacts', accountId, id] as const,
  history: (accountId: string, id: string) => ['contacts', accountId, id, 'history'] as const,
  tags: (accountId: string) => ['tags', accountId] as const,
  imports: (accountId: string) => ['imports', accountId] as const,
  import: (accountId: string, id: string) => ['imports', accountId, id] as const,
};

export function toQueryString(q: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return p.toString();
}

export function useContacts(accountId: string | null, q: ContactListQuery) {
  return useQuery({
    queryKey: contactKeys.list(accountId ?? '', q),
    queryFn: () =>
      api<{ items: ContactDTO[]; total: number; page: number; pageSize: number }>(
        `/accounts/${accountId}/contacts?${toQueryString(q)}`,
      ),
    enabled: !!accountId,
    placeholderData: keepPreviousData,
    staleTime: 0, // sempre recarrega ao abrir: importações alteram a base em segundo plano
  });
}

export function useContact(accountId: string, id: string) {
  return useQuery({
    queryKey: contactKeys.detail(accountId, id),
    queryFn: () =>
      api<{ contact: ContactDTO }>(`/accounts/${accountId}/contacts/${id}`).then((r) => r.contact),
  });
}

export function useContactHistory(accountId: string, id: string) {
  return useQuery({
    queryKey: contactKeys.history(accountId, id),
    queryFn: () =>
      api<{ items: ContactHistoryItem[] }>(`/accounts/${accountId}/contacts/${id}/history`).then(
        (r) => r.items,
      ),
  });
}

export function useTags(accountId: string | null) {
  return useQuery({
    queryKey: contactKeys.tags(accountId ?? ''),
    queryFn: () => api<{ items: TagDTO[] }>(`/accounts/${accountId}/tags`).then((r) => r.items),
    enabled: !!accountId,
  });
}

/** Mutação genérica sobre contatos/etiquetas de uma instância; invalida as listas. */
export function useContactsMutation<T = unknown>(accountId: string) {
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
    }) => api<T>(`/accounts/${accountId}${path}`, { method, json }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['contacts', accountId] }),
        qc.invalidateQueries({ queryKey: ['tags', accountId] }),
        qc.invalidateQueries({ queryKey: ['dashboard'] }),
      ]),
  });
}

export function useImports(accountId: string | null) {
  return useQuery({
    queryKey: contactKeys.imports(accountId ?? ''),
    queryFn: () =>
      api<{ items: ImportDTO[] }>(`/accounts/${accountId}/imports`).then((r) => r.items),
    enabled: !!accountId,
    refetchInterval: (q) =>
      q.state.data?.some((i) => ['ANALYZING', 'CONFIRMED', 'PROCESSING'].includes(i.status))
        ? 2000
        : false,
  });
}

const ACTIVE = ['ANALYZING', 'CONFIRMED', 'PROCESSING'];

export function useImport(accountId: string, id: string | null) {
  return useQuery({
    queryKey: contactKeys.import(accountId, id ?? ''),
    queryFn: () =>
      api<{ import: ImportDTO }>(`/accounts/${accountId}/imports/${id}`).then((r) => r.import),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.status) ? 1200 : false),
  });
}

export function useImportRows(
  accountId: string,
  id: string,
  status: string | undefined,
  page: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['imports', accountId, id, 'rows', status, page],
    queryFn: () =>
      api<{ items: ImportRowDTO[]; total: number }>(
        `/accounts/${accountId}/imports/${id}/rows?${toQueryString({ status, page, pageSize: 25 })}`,
      ),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** Upload com progresso (XMLHttpRequest) — inclui o token CSRF. */
export function uploadImport(
  accountId: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<ImportDTO> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/accounts/${accountId}/imports`);
    const csrf = document.cookie
      .split('; ')
      .find((c) => c.startsWith('mz_csrf='))
      ?.slice(8);
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: {
        import?: ImportDTO;
        error?: { message: string; code: string; fields?: Record<string, string[]> };
      } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* resposta não JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.import) resolve(body.import);
      else
        reject(
          Object.assign(new Error(body.error?.message ?? 'Falha no envio do arquivo.'), {
            code: body.error?.code,
            fields: body.error?.fields,
          }),
        );
    };
    xhr.onerror = () => reject(new Error('Falha de rede durante o envio.'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}
