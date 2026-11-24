import { CSRF_COOKIE, CSRF_HEADER, type ApiErrorBody } from '@multizap/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/**
 * Cliente da API. Todas as chamadas passam por /api (mesmo domínio) e são
 * repassadas à API interna. O token CSRF é lido do cookie e enviado no cabeçalho.
 */
export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const h = new Headers(headers);
  h.set('accept', 'application/json');
  if (json !== undefined) h.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) h.set(CSRF_HEADER, csrf);
  }
  const res = await fetch(`/api${path}`, {
    ...rest,
    method,
    headers: h,
    credentials: 'same-origin',
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const body = data as Partial<ApiErrorBody> | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'HTTP_ERROR',
      body?.error?.message ?? 'Falha na comunicação com o servidor.',
      body?.error?.fields,
    );
  }
  return data as T;
}
