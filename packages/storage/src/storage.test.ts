import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalStorage, assertKey, storageFromEnv, streamToBuffer } from './index';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('LocalStorage', () => {
  it('grava, lê, verifica e remove arquivos (buffer e stream)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mz-'));
    dirs.push(dir);
    const s = new LocalStorage(dir);
    await s.put('imports/a/b.csv', Buffer.from('x,y'));
    await s.put('imports/a/c.csv', Readable.from(['1', '2']));
    expect((await streamToBuffer(await s.get('imports/a/b.csv'))).toString()).toBe('x,y');
    expect((await streamToBuffer(await s.get('imports/a/c.csv'))).toString()).toBe('12');
    expect(await s.exists('imports/a/b.csv')).toBe(true);
    await s.delete('imports/a/b.csv');
    expect(await s.exists('imports/a/b.csv')).toBe(false);
    await expect(s.get('imports/a/b.csv')).rejects.toThrow();
  });

  it('bloqueia chaves perigosas (path traversal)', () => {
    for (const k of ['../etc/passwd', '/abs', 'a/../b', 'a//b', 'a/./b', 'com espaço']) {
      expect(() => assertKey(k)).toThrow();
    }
    expect(() => assertKey('imports/uuid/arquivo-1.csv')).not.toThrow();
  });

  it('exige Railway Bucket em produção', () => {
    expect(() => storageFromEnv({ NODE_ENV: 'production' })).toThrow(/Railway Bucket/);
    expect(() => storageFromEnv({ STORAGE_DRIVER: 's3', STORAGE_S3_BUCKET: 'b' })).toThrow(
      /incompleto/,
    );
    expect(
      storageFromEnv({
        STORAGE_DRIVER: 's3',
        STORAGE_S3_BUCKET: 'b',
        STORAGE_S3_ACCESS_KEY_ID: 'k',
        STORAGE_S3_SECRET_ACCESS_KEY: 's',
      }).kind,
    ).toBe('s3');
    expect(storageFromEnv({ NODE_ENV: 'development' }).kind).toBe('local');
  });
});

describe('list e backupStorageFromEnv', () => {
  it('lista objetos por prefixo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mz-'));
    dirs.push(dir);
    const s = new LocalStorage(dir);
    await s.put('assets/a/1.png', Buffer.from('1'));
    await s.put('assets/b.png', Buffer.from('22'));
    await s.put('assetsx/c.png', Buffer.from('3'));
    await s.put('tools/d.csv', Buffer.from('4'));
    const keys: string[] = [];
    for await (const o of s.list('assets/')) keys.push(`${o.key}:${o.size}`);
    expect(keys.sort()).toEqual(['assets/a/1.png:1', 'assets/b.png:2']);
    const all: string[] = [];
    for await (const o of s.list('')) all.push(o.key);
    expect(all).toHaveLength(4);
    const none: string[] = [];
    for await (const o of s.list('nada/')) none.push(o.key);
    expect(none).toEqual([]);
  });

  it('configura o bucket de backup separado', async () => {
    const { backupStorageFromEnv } = await import('./index');
    expect(backupStorageFromEnv({})).toBeNull();
    expect(() => backupStorageFromEnv({ BACKUP_S3_BUCKET: 'b' })).toThrow(/incompleto/);
    expect(() =>
      backupStorageFromEnv({
        BACKUP_S3_BUCKET: 'b',
        BACKUP_S3_ACCESS_KEY_ID: 'k',
        BACKUP_S3_SECRET_ACCESS_KEY: 's',
        STORAGE_S3_BUCKET: 'b',
      }),
    ).toThrow(/diferente/);
    expect(
      backupStorageFromEnv({
        BACKUP_S3_BUCKET: 'bk',
        BACKUP_S3_ACCESS_KEY_ID: 'k',
        BACKUP_S3_SECRET_ACCESS_KEY: 's',
        STORAGE_S3_BUCKET: 'b',
      })?.kind,
    ).toBe('s3');
    expect(() =>
      backupStorageFromEnv({ BACKUP_LOCAL_DIR: '/tmp/x', NODE_ENV: 'production' }),
    ).toThrow();
    expect(backupStorageFromEnv({ BACKUP_LOCAL_DIR: '/tmp/x' })?.kind).toBe('local');
  });
});
