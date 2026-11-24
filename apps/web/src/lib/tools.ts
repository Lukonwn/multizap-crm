'use client';
import { useQuery } from '@tanstack/react-query';
import type { ToolJobDTO, ToolUploadDTO } from '@multizap/shared';

import { api } from './api';

const ACTIVE = ['QUEUED', 'RUNNING'];

export function useToolJobs(tool?: string) {
  return useQuery({
    queryKey: ['tool-jobs', tool ?? 'all'],
    queryFn: () =>
      api<{ items: ToolJobDTO[] }>(`/tools/jobs?limit=20${tool ? `&tool=${tool}` : ''}`).then(
        (r) => r.items,
      ),
    refetchInterval: (q) => (q.state.data?.some((j) => ACTIVE.includes(j.status)) ? 2000 : false),
  });
}

export function useToolJob(id: string | null) {
  return useQuery({
    queryKey: ['tool-job', id],
    queryFn: () => api<{ job: ToolJobDTO }>(`/tools/jobs/${id}`).then((r) => r.job),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.status) ? 1000 : false),
  });
}

/** Envio com progresso (XMLHttpRequest), incluindo o token CSRF. */
export function uploadToolFile(
  file: File,
  onProgress: (pct: number) => void,
): Promise<ToolUploadDTO> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/tools/uploads');
    const csrf = document.cookie
      .split('; ')
      .find((c) => c.startsWith('mz_csrf='))
      ?.slice(8);
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let body: { upload?: ToolUploadDTO; error?: { message: string } } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* resposta não JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.upload) resolve(body.upload);
      else reject(new Error(body.error?.message ?? 'Falha no envio do arquivo.'));
    };
    xhr.onerror = () => reject(new Error('Falha de rede durante o envio.'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

/** Rótulos dos indicadores retornados pelas ferramentas. */
export const SUMMARY_LABELS: Record<string, string> = {
  rows: 'Linhas gravadas',
  emptyRowsSkipped: 'Linhas vazias ignoradas',
  from: 'Formato de origem',
  to: 'Formato de destino',
  parts: 'Partes geradas',
  rowsPerPart: 'Linhas por parte',
  headerRepeated: 'Cabeçalho repetido em cada parte',
  totalA: 'Registros na lista A',
  totalB: 'Registros na lista B',
  onlyA: 'Somente na lista A',
  onlyB: 'Somente na lista B',
  both: 'Em ambas',
  uniquePhonesA: 'Telefones únicos na A',
  uniquePhonesB: 'Telefones únicos na B',
  withoutValidPhoneA: 'Sem telefone válido na A',
  withoutValidPhoneB: 'Sem telefone válido na B',
  total: 'Registros',
  kept: 'Mantidos',
  duplicatesRemoved: 'Duplicados removidos',
  keptWithoutValidPhone: 'Mantidos sem telefone válido',
  by: 'Critério',
  linesScanned: 'Linhas analisadas',
  candidates: 'Sequências numéricas encontradas',
  phonesWritten: 'Telefones gravados',
  uniquePhones: 'Telefones únicos',
  duplicatesFound: 'Repetições encontradas',
  groups: 'Grupos',
  counts: 'Distribuição',
  emptyRowsRemoved: 'Linhas vazias removidas',
  valid: 'Válidos',
  duplicate: 'Duplicados',
  incomplete: 'Incompletos',
  invalid: 'Inválidos',
  empty: 'Sem telefone',
  mobile: 'Celulares',
  fixed: 'Fixos',
  byCountry: 'Válidos por país',
  topDdd: 'Válidos por DDD (principais)',
};
