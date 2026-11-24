import { Writable } from 'node:stream';

export type AppStateKind = 'blocked' | 'key' | 'synced' | 'complete' | 'gaveup' | 'retry';

export interface AppStateEvent {
  accountId: string;
  kind: AppStateKind;
  level: 'info' | 'warn';
  /** Texto para o administrador (sem o nome da instância). */
  text: string;
}

const COLLECTION_LABEL: Record<string, string> = {
  critical_unblock_low: 'agenda e contatos',
  critical_block: 'bloqueios',
  regular: 'preferências',
  regular_high: 'conversas fixadas e arquivadas',
  regular_low: 'demais dados',
};
const label = (c: string) => COLLECTION_LABEL[c] ?? c;

const EVENTS_PER_HOUR = 40;

/**
 * Observa as mensagens que a biblioteca do WhatsApp registra durante a sincronização do
 * "estado do aplicativo" (é por onde a agenda do celular chega ao aparelho conectado) e as
 * transforma em eventos para o System Health. Assim o diagnóstico não depende do nível de
 * log da hospedagem. Também diz quais coleções ficaram paradas esperando a chave do celular,
 * para que o gateway tente sincronizar de novo.
 */
export class AppStateMonitor {
  private readonly blockedBy = new Map<string, Set<string>>();
  private readonly lastSeen = new Map<string, number>();
  private readonly perHour = new Map<string, { at: number; n: number }>();
  /** Nível mínimo repassado ao stdout (o restante só é observado). */
  readonly forwardLevel: number;

  constructor(
    private readonly emit: (e: AppStateEvent) => void,
    forwardLevel = 40,
    private readonly out: { write(s: string): unknown } = process.stdout,
  ) {
    this.forwardLevel = forwardLevel;
  }

  /** Destino do pino para o logger da biblioteca. */
  stream(): Writable {
    let pending = '';
    return new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) this.line(l);
        cb();
      },
    });
  }

  line(raw: string): void {
    let o: { level?: number; msg?: string; accountId?: string; name?: string };
    try {
      o = JSON.parse(raw);
    } catch {
      this.out.write(raw + '\n');
      return;
    }
    if ((o.level ?? 30) >= this.forwardLevel) this.out.write(raw + '\n');
    const accountId = o.accountId;
    const msg = String(o.msg ?? '');
    if (!accountId || !msg) return;

    let m: RegExpExecArray | null;
    if ((m = /^(\w+) blocked on missing key from v(\d+), parking/.exec(msg))) {
      const name = o.name ?? m[1]!;
      const set = this.blockedBy.get(accountId) ?? new Set<string>();
      set.add(name);
      this.blockedBy.set(accountId, set);
      this.push(
        accountId,
        'blocked',
        'warn',
        `parada esperando a chave que o celular deve enviar (${label(name)}).`,
        name,
      );
    } else if (/App state sync key arrived/i.test(msg)) {
      this.push(accountId, 'key', 'info', 'o celular enviou a chave de sincronização; retomando.');
    } else if (
      (m = /^synced (\w+) to v(\d+)/.exec(msg)) ||
      (m = /^restored state of (\w+) from snapshot to v(\d+)/.exec(msg))
    ) {
      this.blockedBy.get(accountId)?.delete(m[1]!);
      this.push(
        accountId,
        'synced',
        'info',
        `${label(m[1]!)} sincronizado(a) (versão ${m[2]}).`,
        m[1],
      );
    } else if (/App state sync complete/i.test(msg)) {
      this.push(accountId, 'complete', 'info', 'sincronização inicial concluída.');
    } else if ((m = /^failed to sync (\w+) from v\d+, giving up/.exec(msg))) {
      this.push(accountId, 'gaveup', 'warn', `não foi possível sincronizar ${label(m[1]!)}.`, m[1]);
    }
  }

  /** Coleções que ficaram paradas esperando a chave. */
  blocked(accountId: string): string[] {
    return [...(this.blockedBy.get(accountId) ?? [])];
  }

  clear(accountId: string): void {
    this.blockedBy.delete(accountId);
  }

  /** Registra uma tentativa de nova sincronização feita pelo gateway. */
  retry(accountId: string, attempt: number, collections: string[]): void {
    this.push(
      accountId,
      'retry',
      'info',
      `nova tentativa de sincronização (${attempt}ª): ${collections.map(label).join(', ')}.`,
    );
  }

  private push(
    accountId: string,
    kind: AppStateKind,
    level: 'info' | 'warn',
    text: string,
    key = '',
  ) {
    const now = Date.now();
    // Mesmo aviso repetido em menos de 1 minuto não vira outro evento.
    const id = `${accountId}:${kind}:${key}`;
    if (now - (this.lastSeen.get(id) ?? 0) < 60_000 && kind !== 'retry') return;
    this.lastSeen.set(id, now);
    const h = this.perHour.get(accountId);
    if (!h || now - h.at > 3_600_000) this.perHour.set(accountId, { at: now, n: 1 });
    else if (++h.n > EVENTS_PER_HOUR) return;
    this.emit({ accountId, kind, level, text });
  }
}
