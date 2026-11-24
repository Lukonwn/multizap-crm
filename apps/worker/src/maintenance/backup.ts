import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import pg from 'pg';
import copyStreams from 'pg-copy-streams';
import {
  notify,
  recordSystemEvent,
  resolveNotifications,
  type PrismaClient,
} from '@multizap/database';
import { streamToBuffer, type StorageDriver } from '@multizap/storage';
import { decryptStream, encryptStream, keyFingerprint } from './crypto-stream';

const { from: copyFrom, to: copyTo } = copyStreams;

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** Pastas do armazenamento principal copiadas para o bucket de backup. */
export const BACKUP_FILE_PREFIXES = ['assets/', 'media/'] as const;
/** Quantidade mínima de backups concluídos mantidos, mesmo além da retenção. */
export const MIN_BACKUPS_KEPT = 3;

export interface BackupManifest {
  format: 1;
  app: 'multizap';
  backupId: string;
  createdAt: string;
  keyFingerprint: string;
  migrations: string[];
  tables: { name: string; rows: number; bytes: number; key: string }[];
  files: { count: number; bytes: number; keys: string[] };
}

export interface RestoreResult {
  tables: { name: string; rows: number }[];
  filesRestored: number;
  filesSkipped: number;
}

/** Remove parâmetros exclusivos do Prisma da URL do banco (o driver pg não os entende). */
export function pgConnectionString(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  for (const p of [
    'schema',
    'connection_limit',
    'pool_timeout',
    'pgbouncer',
    'statement_cache_size',
    'socket_timeout',
    'connect_timeout',
  ])
    u.searchParams.delete(p);
  return u.toString();
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Nome de tabela inesperado: ${name}`);
  return `"public"."${name}"`;
};

const tableAad = (backupId: string, table: string) => `${backupId}:db:${table}`;
const fileAad = (key: string) => `file:${key}`;

class Meter extends Transform {
  bytes = 0;
  override _transform(
    chunk: Buffer,
    _e: BufferEncoding,
    cb: (e?: Error | null, d?: Buffer) => void,
  ) {
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

export class BackupService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly databaseUrl: string,
    private readonly main: StorageDriver,
    private readonly backups: StorageDriver,
    private readonly key: Buffer,
    private readonly log: Log = () => undefined,
  ) {}

  private client() {
    return new pg.Client({ connectionString: pgConnectionString(this.databaseUrl) });
  }

  /** Grava em `key` o conteúdo de `source`, comprimido e criptografado. */
  private async putEncrypted(key: string, source: Readable, aad: string, opts: { gzip: boolean }) {
    const meter = new Meter();
    const out = new PassThrough();
    const stages: NodeJS.ReadWriteStream[] = [meter];
    if (opts.gzip) stages.push(createGzip());
    stages.push(encryptStream(this.key, aad));
    const done = pipeline(source, ...(stages as [Transform]), out);
    await Promise.all([
      this.backups.put(key, out, { contentType: 'application/octet-stream' }),
      done,
    ]);
    return meter.bytes;
  }

  /** Executa um backup (registro já criado em `backups`). */
  async run(backupId: string): Promise<void> {
    const claimed = await this.prisma.backup.updateMany({
      where: { id: backupId, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count === 0) return; // já processado ou cancelado
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = `backups/${stamp}-${backupId.slice(0, 8)}/`;
    await this.prisma.backup.update({
      where: { id: backupId },
      data: { dbKey: `${prefix}manifest.json` },
    });
    try {
      const manifest = await this.dump(backupId, prefix);
      await this.backups.put(
        `${prefix}manifest.json`,
        Buffer.from(JSON.stringify(manifest, null, 2)),
        {
          contentType: 'application/json',
        },
      );
      const size = manifest.tables.reduce((s, t) => s + t.bytes, 0) + manifest.files.bytes;
      await this.prisma.backup.update({
        where: { id: backupId },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          sizeBytes: BigInt(size),
          filesKey: 'files/',
        },
      });
      await resolveNotifications(this.prisma, 'backup:failed');
      await resolveNotifications(this.prisma, 'backup:overdue');
      this.log('Backup concluído', {
        backupId,
        tables: manifest.tables.length,
        files: manifest.files.count,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.backup.update({
        where: { id: backupId },
        data: { status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 500) },
      });
      await notify(this.prisma, {
        severity: 'ERROR',
        category: 'BACKUP',
        title: 'Falha no backup',
        message: `O backup não foi concluído: ${message.slice(0, 300)}`,
        dedupeKey: 'backup:failed',
      });
      await recordSystemEvent(this.prisma, {
        source: 'worker',
        level: 'error',
        type: 'backup_failed',
        message: `Falha no backup: ${message.slice(0, 300)}`,
        details: { backupId },
      });
      this.log('Falha no backup', { backupId, err: message });
      throw err;
    }
  }

  private async dump(backupId: string, prefix: string): Promise<BackupManifest> {
    const client = this.client();
    await client.connect();
    const tables: BackupManifest['tables'] = [];
    let migrations: string[];
    try {
      // Uma única transação: todas as tabelas no mesmo instante (snapshot consistente).
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      migrations = (
        await client.query<{ migration_name: string }>(
          `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
        )
      ).rows.map((r) => r.migration_name);
      const names = (
        await client.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`,
        )
      ).rows.map((r) => r.tablename);
      for (const name of names) {
        const key = `${prefix}db/${name}.copy.gz.enc`;
        const src = client.query(copyTo(`COPY ${ident(name)} TO STDOUT`));
        const bytes = await this.putEncrypted(key, src, tableAad(backupId, name), { gzip: true });
        tables.push({ name, rows: Number(src.rowCount ?? 0), bytes, key });
      }
      await client.query('COMMIT');
    } finally {
      await client.end().catch(() => undefined);
    }

    // Arquivos: espelho incremental (cada arquivo é copiado uma única vez).
    const mirrored = new Set<string>();
    for await (const o of this.backups.list('files/')) mirrored.add(o.key.slice('files/'.length));
    const keys: string[] = [];
    let bytes = 0;
    for (const p of BACKUP_FILE_PREFIXES) {
      for await (const o of this.main.list(p)) {
        keys.push(o.key);
        bytes += o.size;
        if (mirrored.has(o.key)) continue;
        await this.putEncrypted(`files/${o.key}`, await this.main.get(o.key), fileAad(o.key), {
          gzip: false,
        });
      }
    }
    keys.sort();
    return {
      format: 1,
      app: 'multizap',
      backupId,
      createdAt: new Date().toISOString(),
      keyFingerprint: keyFingerprint(this.key),
      migrations,
      tables,
      files: { count: keys.length, bytes, keys },
    };
  }

  /**
   * Retenção: remove backups com mais de `retentionDays` dias, mantendo sempre
   * os MIN_BACKUPS_KEPT concluídos mais recentes, e os arquivos do espelho que
   * nenhum backup restante referencia.
   */
  async prune(retentionDays: number): Promise<{ removed: number; filesRemoved: number }> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const keep = new Set(
      (
        await this.prisma.backup.findMany({
          where: { status: 'COMPLETED' },
          orderBy: { createdAt: 'desc' },
          take: MIN_BACKUPS_KEPT,
          select: { id: true },
        })
      ).map((b) => b.id),
    );
    const old = await this.prisma.backup.findMany({
      where: { createdAt: { lt: cutoff }, status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] } },
    });
    let removed = 0;
    for (const b of old) {
      if (keep.has(b.id)) continue;
      if (b.dbKey) {
        const prefix = b.dbKey.replace(/manifest\.json$/, '');
        for await (const o of this.backups.list(prefix)) await this.backups.delete(o.key);
      }
      await this.prisma.backup.delete({ where: { id: b.id } });
      removed++;
    }

    // Coleta dos arquivos do espelho que nenhum manifesto restante referencia.
    const referenced = new Set<string>();
    const remaining = await this.prisma.backup.findMany({ where: { status: 'COMPLETED' } });
    for (const b of remaining) {
      if (!b.dbKey) continue;
      const m = await this.readManifest(b.dbKey).catch(() => null);
      if (!m) return { removed, filesRemoved: 0 }; // manifesto ilegível: não apaga nada do espelho
      for (const k of m.files.keys) referenced.add(k);
    }
    let filesRemoved = 0;
    for await (const o of this.backups.list('files/')) {
      if (!referenced.has(o.key.slice('files/'.length))) {
        await this.backups.delete(o.key);
        filesRemoved++;
      }
    }
    return { removed, filesRemoved };
  }

  async readManifest(manifestKey: string): Promise<BackupManifest> {
    const m = JSON.parse(
      (await streamToBuffer(await this.backups.get(manifestKey))).toString('utf8'),
    ) as BackupManifest;
    if (m.format !== 1 || m.app !== 'multizap')
      throw new Error('Manifesto de backup desconhecido.');
    return m;
  }

  /** Backups disponíveis no bucket (pelos manifestos), mais recentes primeiro. */
  async available(): Promise<string[]> {
    const out: string[] = [];
    for await (const o of this.backups.list('backups/'))
      if (o.key.endsWith('/manifest.json')) out.push(o.key);
    return out.sort().reverse();
  }

  /**
   * Restaura um backup no banco configurado.
   *  - o banco deve ter as mesmas migrations aplicadas (prisma migrate deploy);
   *  - as tabelas devem estar vazias, a não ser com `force` (que as esvazia antes);
   *  - tudo em uma transação: ou restaura por completo, ou nada muda.
   */
  async restore(
    manifestKey: string,
    opts: { force?: boolean; files?: boolean } = {},
  ): Promise<RestoreResult> {
    const m = await this.readManifest(manifestKey);
    if (m.keyFingerprint !== keyFingerprint(this.key))
      throw new Error('A BACKUP_ENCRYPTION_KEY configurada não é a mesma usada neste backup.');
    const client = this.client();
    await client.connect();
    const result: RestoreResult = { tables: [], filesRestored: 0, filesSkipped: 0 };
    try {
      const migrations = (
        await client
          .query<{ migration_name: string }>(
            `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
          )
          .catch(() => ({ rows: [] }))
      ).rows.map((r) => r.migration_name);
      if (migrations.join(',') !== m.migrations.join(',')) {
        throw new Error(
          `As migrations do banco (${migrations.length}) não correspondem às do backup (${m.migrations.length}). ` +
            'Aplique as migrations da mesma versão do MultiZap (prisma migrate deploy) antes de restaurar.',
        );
      }
      const existing = new Set(
        (
          await client.query<{ tablename: string }>(
            `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
          )
        ).rows.map((r) => r.tablename),
      );
      const missing = m.tables.filter((t) => !existing.has(t.name)).map((t) => t.name);
      if (missing.length) throw new Error(`Tabelas ausentes no banco: ${missing.join(', ')}.`);

      await client.query('BEGIN');
      if (opts.force) {
        await client.query(`TRUNCATE ${m.tables.map((t) => ident(t.name)).join(', ')} CASCADE`);
      } else {
        for (const t of m.tables) {
          const r = await client.query(`SELECT EXISTS (SELECT 1 FROM ${ident(t.name)}) AS e`);
          if (r.rows[0].e)
            throw new Error(
              `A tabela ${t.name} já tem dados. Use um banco vazio ou --force para substituir.`,
            );
        }
      }
      for (const name of await this.restoreOrder(
        client,
        m.tables.map((t) => t.name),
      )) {
        const t = m.tables.find((x) => x.name === name)!;
        const sink = client.query(copyFrom(`COPY ${ident(name)} FROM STDIN`));
        await pipeline(
          await this.backups.get(t.key),
          decryptStream(this.key, tableAad(m.backupId, name)),
          createGunzip(),
          sink,
        );
        result.tables.push({ name, rows: Number(sink.rowCount ?? 0) });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await client.end().catch(() => undefined);
    }

    if (opts.files !== false) {
      for (const key of m.files.keys) {
        if (await this.main.exists(key)) {
          result.filesSkipped++;
          continue;
        }
        const out = new PassThrough();
        const done = pipeline(
          await this.backups.get(`files/${key}`),
          decryptStream(this.key, fileAad(key)),
          out,
        );
        await Promise.all([this.main.put(key, out), done]);
        result.filesRestored++;
      }
    }
    return result;
  }

  /** Ordem que respeita as chaves estrangeiras (tabelas referenciadas primeiro). */
  private async restoreOrder(client: pg.Client, tables: string[]): Promise<string[]> {
    const edges = (
      await client.query<{ child: string; parent: string }>(`
        SELECT ch.relname AS child, pa.relname AS parent
        FROM pg_constraint c
        JOIN pg_class ch ON ch.oid = c.conrelid
        JOIN pg_class pa ON pa.oid = c.confrelid
        WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`)
    ).rows.filter((e) => e.child !== e.parent);
    const set = new Set(tables);
    const deps = new Map(tables.map((t) => [t, new Set<string>()]));
    for (const e of edges)
      if (set.has(e.child) && set.has(e.parent)) deps.get(e.child)!.add(e.parent);
    const order: string[] = [];
    const done = new Set<string>();
    while (order.length < tables.length) {
      const ready = tables.filter(
        (t) => !done.has(t) && [...deps.get(t)!].every((d) => done.has(d)),
      );
      if (!ready.length) throw new Error('Dependência circular entre tabelas.');
      for (const t of ready) {
        order.push(t);
        done.add(t);
      }
    }
    return order;
  }
}

/** Converte "dia + hora local" em instante UTC no fuso informado. */
export function zonedHourToUtc(day: string, hour: number, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour);
  const offset = (t: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(new Date(t))
        .map((p) => [p.type, p.value]),
    );
    return (
      Date.UTC(
        +parts.year!,
        +parts.month! - 1,
        +parts.day!,
        +parts.hour!,
        +parts.minute!,
        +parts.second!,
      ) - t
    );
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t);
}

/** Horário do backup automático de hoje e o próximo a partir de `now`. */
export function backupSlots(now: Date, hour: number, tz: string): { last: Date; next: Date } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const slotToday = zonedHourToUtc(today, hour, tz);
  const shift = (day: string, n: number) => {
    const dt = new Date(`${day}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  };
  return slotToday <= now
    ? { last: slotToday, next: zonedHourToUtc(shift(today, 1), hour, tz) }
    : { last: zonedHourToUtc(shift(today, -1), hour, tz), next: slotToday };
}
