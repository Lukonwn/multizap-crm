'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssetDTO, AssetFolderDTO, AssetUsageDTO } from '@multizap/shared';
import { api } from './api';
import { toQueryString } from './contacts';

export function useFolders() {
  return useQuery({
    queryKey: ['asset-folders'],
    queryFn: () => api<{ items: AssetFolderDTO[] }>('/asset-folders').then((r) => r.items),
  });
}

export function useAssets(q: { folder?: string; kind?: string; q?: string; page: number }) {
  return useQuery({
    queryKey: ['assets', q],
    queryFn: () =>
      api<{ items: AssetDTO[]; total: number; pageSize: number }>(`/assets?${toQueryString(q)}`),
    placeholderData: keepPreviousData,
  });
}

export function useAsset(id: string | null) {
  return useQuery({
    queryKey: ['asset', id],
    queryFn: () => api<{ asset: AssetDTO; usages: AssetUsageDTO[] }>(`/assets/${id}`),
    enabled: !!id,
  });
}

export function useAssetMutation<T = unknown>() {
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
    }) => api<T>(path, { method, json }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['assets'] }),
        qc.invalidateQueries({ queryKey: ['asset'] }),
        qc.invalidateQueries({ queryKey: ['asset-folders'] }),
      ]),
  });
}

/** Upload com progresso. Os campos vão ANTES do arquivo (exigência do parser multipart). */
export function uploadAsset(
  file: File,
  fields: { kind: string; folderId?: string | null },
  onProgress: (pct: number) => void,
): Promise<AssetDTO> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/assets/upload');
    const csrf = document.cookie
      .split('; ')
      .find((c) => c.startsWith('mz_csrf='))
      ?.slice(8);
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: { asset?: AssetDTO; error?: { message: string } } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* resposta não JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.asset) resolve(body.asset);
      else reject(new Error(body.error?.message ?? 'Falha no envio.'));
    };
    xhr.onerror = () => reject(new Error('Falha de rede durante o envio.'));
    const form = new FormData();
    form.append('kind', fields.kind);
    if (fields.folderId) form.append('folderId', fields.folderId);
    form.append('file', file);
    xhr.send(form);
  });
}

export function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
