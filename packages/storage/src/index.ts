import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

/**
 * Armazenamento de arquivos do MultiZap.
 *  - s3: Railway Bucket (ou qualquer serviço compatível com S3) — produção.
 *  - local: diretório no disco — desenvolvimento e testes.
 * Nenhum serviço depende do filesystem efêmero do container em produção.
 */
export interface StorageDriver {
  readonly kind: 's3' | 'local';
  put(key: string, body: Readable | Buffer, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Verificação de saúde (credenciais/bucket acessíveis). */
  check(): Promise<void>;
  /** Lista os objetos sob um prefixo (ex.: "assets/"), sem ordem garantida. */
  list(prefix: string): AsyncIterable<StoredObject>;
}

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/_.\-]*$/;

/** Chaves restritas: sem "..", sem barra inicial, apenas caracteres seguros. */
export function assertKey(key: string): void {
  if (!KEY_RE.test(key) || key.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    throw new Error(`Chave de armazenamento inválida: ${key}`);
  }
}

export class LocalStorage implements StorageDriver {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private path(key: string): string {
    assertKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Caminho fora do diretório de armazenamento.');
    return p;
  }

  async put(key: string, body: Readable | Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, createWriteStream(p));
  }

  async get(key: string): Promise<Readable> {
    const p = this.path(key);
    await access(p);
    return createReadStream(p);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.path(key)).then(() => true, () => false);
  }

  async check(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root);
  }

  async *list(prefix: string): AsyncIterable<StoredObject> {
    const walk = async function* (dir: string): AsyncGenerator<string> {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = resolve(dir, e.name);
        if (e.isDirectory()) yield* walk(p);
        else if (e.isFile()) yield p;
      }
    };
    // Começa pela pasta do prefixo (ou a raiz) e filtra pelo prefixo exato.
    const slash = prefix.lastIndexOf('/');
    const base = slash >= 0 ? resolve(this.root, prefix.slice(0, slash)) : this.root;
    if (base !== this.root && !base.startsWith(this.root + sep)) return;
    for await (const p of walk(base)) {
      const key = relative(this.root, p).split(sep).join('/');
      if (!key.startsWith(prefix)) continue;
      const st = await stat(p).catch(() => null);
      if (st) yield { key, size: st.size, lastModified: st.mtime };
    }
  }
}

export interface S3Options {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export class S3Storage implements StorageDriver {
  readonly kind = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({
      endpoint: opts.endpoint || undefined,
      region: opts.region,
      forcePathStyle: opts.forcePathStyle ?? false,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, body: Readable | Buffer, opts: { contentType?: string } = {}): Promise<void> {
    assertKey(key);
    // Upload multipart em streaming: suporta arquivos grandes sem carregar em memória.
    await new Upload({
      client: this.client,
      params: { Bucket: this.opts.bucket, Key: key, Body: body, ContentType: opts.contentType },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    }).done();
  }

  async get(key: string): Promise<Readable> {
    assertKey(key);
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    if (!r.Body) throw new Error('Objeto vazio.');
    return r.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    assertKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return true;
    } catch (err) {
      if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }

  async check(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
  }

  async *list(prefix: string): AsyncIterable<StoredObject> {
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.opts.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of r.Contents ?? []) {
        if (o.Key) yield { key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) };
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }
}

/**
 * STORAGE_DRIVER=s3 → STORAGE_S3_* (Railway Bucket)
 * STORAGE_DRIVER=local → STORAGE_LOCAL_DIR (padrão ./storage; somente desenvolvimento)
 */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  const driver = env.STORAGE_DRIVER ?? (env.STORAGE_S3_BUCKET ? 's3' : 'local');
  if (driver === 's3') {
    const required = ['STORAGE_S3_BUCKET', 'STORAGE_S3_ACCESS_KEY_ID', 'STORAGE_S3_SECRET_ACCESS_KEY'] as const;
    const missing = required.filter((k) => !env[k]);
    if (missing.length) throw new Error(`Armazenamento S3 incompleto: defina ${missing.join(', ')}.`);
    return new S3Storage({
      endpoint: env.STORAGE_S3_ENDPOINT,
      region: env.STORAGE_S3_REGION || 'auto',
      bucket: env.STORAGE_S3_BUCKET!,
      accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE === 'true',
    });
  }
  if (env.NODE_ENV === 'production' && env.STORAGE_ALLOW_LOCAL_IN_PRODUCTION !== 'true') {
    throw new Error('Em produção configure o Railway Bucket (STORAGE_DRIVER=s3 e STORAGE_S3_*).');
  }
  return new LocalStorage(env.STORAGE_LOCAL_DIR || './storage');
}

/**
 * Armazenamento dos backups: um bucket separado do principal, para que uma
 * falha ou exclusão no bucket principal não leve os backups junto.
 *  BACKUP_S3_BUCKET + BACKUP_S3_* → S3 (Railway Bucket próprio para backups)
 *  BACKUP_LOCAL_DIR → diretório local (desenvolvimento e testes)
 * Retorna null quando nada foi configurado (backups desativados).
 */
export function backupStorageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageDriver | null {
  if (env.BACKUP_S3_BUCKET) {
    const required = ['BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'] as const;
    const missing = required.filter((k) => !env[k]);
    if (missing.length) throw new Error(`Bucket de backup incompleto: defina ${missing.join(', ')}.`);
    if (env.STORAGE_S3_BUCKET && env.BACKUP_S3_BUCKET === env.STORAGE_S3_BUCKET && (env.BACKUP_S3_ENDPOINT ?? '') === (env.STORAGE_S3_ENDPOINT ?? '')) {
      throw new Error('O bucket de backup deve ser diferente do bucket principal.');
    }
    return new S3Storage({
      endpoint: env.BACKUP_S3_ENDPOINT,
      region: env.BACKUP_S3_REGION || 'auto',
      bucket: env.BACKUP_S3_BUCKET,
      accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE === 'true',
    });
  }
  if (env.BACKUP_LOCAL_DIR) {
    if (env.NODE_ENV === 'production' && env.STORAGE_ALLOW_LOCAL_IN_PRODUCTION !== 'true') {
      throw new Error('Em produção configure um bucket de backup (BACKUP_S3_*).');
    }
    return new LocalStorage(env.BACKUP_LOCAL_DIR);
  }
  return null;
}

/** Lê um stream inteiro para memória (somente arquivos pequenos). */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
