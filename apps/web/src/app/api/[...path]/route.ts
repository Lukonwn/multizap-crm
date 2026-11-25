import type { NextRequest } from 'next/server';

/**
 * Proxy same-origin: /api/* → API interna (rede privada da Railway).
 * Mantém os cookies de sessão no domínio do painel (httpOnly + SameSite=Strict)
 * e evita expor a API publicamente.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FORWARD_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'cookie',
  'origin',
  'user-agent',
  'x-csrf-token',
  'sec-fetch-site',
  'x-forwarded-for',
  'x-real-ip',
  // Aviso de pagamento assinado (sistemas externos): a assinatura é conferida na API.
  'x-multizap-signature',
  'x-multizap-timestamp',
];
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'set-cookie',
]);

function error(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const base = process.env.API_INTERNAL_URL;
  if (!base) return error(500, 'API_UNCONFIGURED', 'API_INTERNAL_URL não configurada.');

  const { path } = await ctx.params;
  // Rotas internas (serviço → serviço) nunca são expostas pelo painel.
  if (path[0] === 'internal') return error(404, 'NOT_FOUND', 'Rota não encontrada.');

  const target = new URL(`${base.replace(/\/$/, '')}/${path.map(encodeURIComponent).join('/')}`);
  target.search = req.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set('x-forwarded-proto', req.nextUrl.protocol.replace(':', ''));

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
    redirect: 'manual',
    cache: 'no-store',
  };
  if (hasBody) {
    init.body = req.body;
    init.duplex = 'half'; // streaming do corpo (uploads) no Node/undici
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    return error(502, 'API_UNAVAILABLE', 'API indisponível no momento.');
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key)) out.set(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
