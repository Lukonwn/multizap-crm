import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

/** Erro com mensagem própria para o administrador. */
export class LinkError extends Error {}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
const ALLOWED_TYPES = /^(text\/html|text\/plain|application\/xhtml\+xml)\b/i;

/** Endereços que nunca devem ser acessados a partir do servidor (rede interna, nuvem, etc.). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local e metadados de nuvem
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast e reservados
    );
  }
  if (isIP(ip) === 6) {
    const h = expandV6(ip);
    if (!h) return true;
    // IPv4 embutido (mapeado ::ffff:a.b.c.d ou compatível ::a.b.c.d): vale a regra do IPv4.
    const first5Zero = h.slice(0, 5).every((x) => x === 0);
    if (first5Zero && (h[5] === 0xffff || (h[5] === 0 && (h[6]! > 0 || h[7]! > 1))))
      return isPrivateAddress(`${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`);
    const v = ip.toLowerCase();
    return (
      h.every((x) => x === 0) || // ::
      (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) || // ::1
      (h[0]! & 0xfe00) === 0xfc00 || // fc00::/7
      (h[0]! & 0xffc0) === 0xfe80 || // fe80::/10
      (h[0]! & 0xff00) === 0xff00 || // multicast
      v.startsWith('64:ff9b:') || // NAT64
      v.startsWith('2001:db8') // documentação
    );
  }
  return true; // não é um IP válido
}

/** Expande um IPv6 para 8 grupos numéricos (aceita "::" e IPv4 no final). */
function expandV6(ip: string): number[] | null {
  let addr = ip.toLowerCase().split('%')[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const p = v4[1]!.split('.').map(Number) as [number, number, number, number];
    addr =
      addr.slice(0, -v4[1]!.length) +
      `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail, extra] = addr.split('::');
  if (extra !== undefined) return null;
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0 || (tail === undefined && left.length !== 8)) return null;
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

export type Lookup = (
  host: string,
  cb: (err: Error | null, addrs: { address: string; family: number }[]) => void,
) => void;

const systemLookup: Lookup = (host, cb) =>
  dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => cb(err, addrs ?? []));

export interface FetchedPage {
  url: string;
  title: string | null;
  text: string;
}

export interface SafeFetchOptions {
  /** Somente testes: nomes/endereços que podem ser acessados mesmo sendo internos (servidor local). */
  allowHosts?: string[];
  lookup?: Lookup;
}

/**
 * Baixa uma página pública (http/https) e devolve o texto. Protegida contra acesso à rede interna:
 * o nome é resolvido uma única vez, TODOS os endereços são validados e a conexão é feita nesse
 * mesmo endereço (sem nova consulta de DNS); cada redirecionamento passa pela mesma validação.
 * Limites: portas 80/443, 3 redirecionamentos, 15 s, 2 MB, só HTML e texto.
 */
export async function fetchPage(rawUrl: string, opts: SafeFetchOptions = {}): Promise<FetchedPage> {
  let url = parseUrl(rawUrl, opts);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await request(url, opts);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = parseUrl(new URL(res.location, url).toString(), opts);
      continue;
    }
    if (res.status < 200 || res.status >= 300)
      throw new LinkError(`A página respondeu com erro ${res.status}.`);
    if (!ALLOWED_TYPES.test(res.type))
      throw new LinkError('O link não é uma página de texto (só HTML e texto são aceitos).');
    const body = res.body.toString('utf8');
    const html = /html/i.test(res.type);
    return { url: url.toString(), ...(html ? htmlToText(body) : { title: null, text: body }) };
  }
  throw new LinkError('Redirecionamentos demais.');
}

const isAllowed = (host: string, opts: SafeFetchOptions) =>
  !!opts.allowHosts?.includes(host.replace(/^\[|\]$/g, ''));

function parseUrl(raw: string, opts: SafeFetchOptions = {}): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new LinkError('Endereço inválido.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new LinkError('Só links http e https são aceitos.');
  if (u.username || u.password) throw new LinkError('Links com usuário e senha não são aceitos.');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (!isAllowed(u.hostname, opts) && port !== '80' && port !== '443')
    throw new LinkError('Só as portas 80 e 443 são aceitas.');
  return u;
}

function request(
  url: URL,
  opts: SafeFetchOptions,
): Promise<{ status: number; type: string; location: string | null; body: Buffer }> {
  const resolve = opts.lookup ?? systemLookup;
  // O Node não consulta o DNS (nem chama `lookup`) quando o endereço já é um número: valida aqui.
  // O analisador de URLs já normaliza formas como http://2130706433/ para 127.0.0.1.
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) && !isAllowed(bare, opts) && isPrivateAddress(bare))
    return Promise.reject(new LinkError('Esse endereço não pode ser acessado.'));
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((ok, fail) => {
    let refused: LinkError | null = null;
    const req = lib.request(
      url,
      {
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: {
          'user-agent': 'MultiZapKnowledgeBot/1.0',
          accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
        },
        // A conexão usa exatamente o endereço validado aqui.
        lookup: ((host: string, o: { all?: boolean }, rawCb: (...a: unknown[]) => void) => {
          // O motivo da recusa é guardado à parte: o Node pode embrulhar o erro da resolução.
          const cb = (...a: unknown[]) => {
            if (a[0] instanceof LinkError) refused = a[0];
            rawCb(...a);
          };
          const literal = isIP(host.replace(/^\[|\]$/g, ''));
          const finish = (addrs: { address: string; family: number }[]) => {
            if (!addrs.length) return cb(new LinkError('Não foi possível encontrar o endereço.'));
            if (!isAllowed(host, opts) && addrs.some((a) => isPrivateAddress(a.address)))
              return cb(new LinkError('Esse endereço não pode ser acessado.'));
            // O Node pede a lista inteira (`all`) quando tenta mais de um endereço.
            if (o?.all) return cb(null, addrs);
            cb(null, addrs[0]!.address, addrs[0]!.family);
          };
          if (literal) return finish([{ address: host.replace(/^\[|\]$/g, ''), family: literal }]);
          resolve(host, (err, addrs) =>
            err ? cb(new LinkError('Não foi possível encontrar o endereço.')) : finish(addrs),
          );
        }) as never,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const status = res.statusCode ?? 0;
        const location = (res.headers.location as string | undefined) ?? null;
        if (status >= 300 && status < 400) {
          res.resume();
          return ok({ status, type: '', location, body: Buffer.alloc(0) });
        }
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new LinkError('A página é grande demais (máximo de 2 MB).'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          ok({
            status,
            type: String(res.headers['content-type'] ?? ''),
            location,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', fail);
      },
    );
    req.on('timeout', () => req.destroy(new LinkError('A página demorou demais para responder.')));
    req.on('error', (err) =>
      fail(
        err instanceof LinkError
          ? err
          : (refused ?? new LinkError('Não foi possível acessar a página.')),
      ),
    );
    req.end();
  });
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ccedil: 'ç',
  atilde: 'ã',
  otilde: 'õ',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  acirc: 'â',
  ecirc: 'ê',
  ocirc: 'ô',
  agrave: 'à',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}
const safeChar = (n: number) => (n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '');

/** Texto visível de uma página HTML (sem scripts, estilos nem menus de navegação). */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head|nav|footer|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/table)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  return {
    title: title ? decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 120) || null : null,
    text: decodeEntities(body),
  };
}
