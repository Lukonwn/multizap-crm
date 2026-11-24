import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, type PrismaClient } from '@multizap/database';
import { HEARTBEAT_KEYS, CLEANUP_SETTING_KEY } from '@multizap/shared';
import { LocalStorage, type StorageDriver } from '@multizap/storage';
import { CleanupService, DEFAULT_CLEANUP } from '../src/maintenance/cleanup';
import { GATEWAY_GRACE_MS, Monitor } from '../src/maintenance/monitor';

const prisma: PrismaClient = createPrisma(process.env.TEST_DATABASE_URL!);
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe('limpeza', () => {
  it('remove apenas dados temporários vencidos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-clean-'));
    const storage = new LocalStorage(dir);
    for (const k of [
      'tools/uploads/old-in.csv',
      'tools/out/old.csv',
      'tools/uploads/new-in.csv',
      'tools/out/new.csv',
      'tools/uploads/orphan.csv',
      'tools/uploads/fresh-orphan.csv',
      'imports/a/old.csv',
      'imports/a/rej.csv',
      'imports/b/new.csv',
      'assets/x.png',
    ])
      await storage.put(k, Buffer.from('x'));
    const old = daysAgo(2);
    utimesSync(join(dir, 'tools/uploads/orphan.csv'), old, old);
    utimesSync(join(dir, 'tools/uploads/old-in.csv'), old, old);

    await prisma.fileJob.create({
      data: {
        tool: 'cleaner',
        status: 'COMPLETED',
        createdAt: daysAgo(10),
        inputKeys: [{ key: 'tools/uploads/old-in.csv' }],
        outputKeys: [{ key: 'tools/out/old.csv' }],
      },
    });
    await prisma.fileJob.create({
      data: {
        tool: 'cleaner',
        status: 'COMPLETED',
        createdAt: daysAgo(1),
        inputKeys: [{ key: 'tools/uploads/new-in.csv' }],
        outputKeys: [{ key: 'tools/out/new.csv' }],
      },
    });
    const a = await prisma.account.create({
      data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB' },
    });
    const oldImp = await prisma.import.create({
      data: {
        accountId: a.id,
        fileName: 'a',
        fileKey: 'imports/a/old.csv',
        rejectedFileKey: 'imports/a/rej.csv',
        fileHash: 'h',
        fileSize: BigInt(1),
        format: 'csv',
        status: 'COMPLETED',
      },
    });
    await prisma.$executeRaw`UPDATE imports SET updated_at = ${daysAgo(40)} WHERE id = ${oldImp.id}::uuid`;
    await prisma.import.create({
      data: {
        accountId: a.id,
        fileName: 'b',
        fileKey: 'imports/b/new.csv',
        fileHash: 'h2',
        fileSize: BigInt(1),
        format: 'csv',
        status: 'COMPLETED',
      },
    });
    const admin = await prisma.adminUser.create({
      data: { email: 'a@a.com', name: 'A', passwordHash: 'x' },
    });
    await prisma.adminSession.create({
      data: { userId: admin.id, tokenHash: 't1', csrfTokenHash: 'c', expiresAt: daysAgo(1) },
    });
    await prisma.adminSession.create({
      data: {
        userId: admin.id,
        tokenHash: 't2',
        csrfTokenHash: 'c',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.systemEvent.create({
      data: {
        source: 'worker',
        level: 'info',
        type: 'x',
        message: 'velho',
        createdAt: daysAgo(40),
      },
    });
    await prisma.systemEvent.create({
      data: { source: 'worker', level: 'info', type: 'x', message: 'novo' },
    });
    await prisma.systemNotification.create({
      data: {
        severity: 'INFO',
        category: 'SYSTEM',
        title: 't',
        message: 'm',
        resolvedAt: daysAgo(100),
      },
    });
    await prisma.systemNotification.create({
      data: { severity: 'INFO', category: 'SYSTEM', title: 't', message: 'm' },
    });

    const r = await new CleanupService(prisma, storage, DEFAULT_CLEANUP).run();
    expect(r).toMatchObject({
      toolJobsExpired: 1,
      orphanUploadsRemoved: 1,
      importFilesRemoved: 1,
      sessionsRemoved: 1,
      eventsRemoved: 1,
      notificationsRemoved: 1,
      errors: [],
    });
    const left: string[] = [];
    for await (const o of storage.list('')) left.push(o.key);
    expect(left.sort()).toEqual([
      'assets/x.png',
      'imports/b/new.csv',
      'tools/out/new.csv',
      'tools/uploads/fresh-orphan.csv',
      'tools/uploads/new-in.csv',
    ]);
    expect(await prisma.fileJob.count()).toBe(1);
    expect(
      (await prisma.import.findUniqueOrThrow({ where: { id: oldImp.id } })).rejectedFileKey,
    ).toBeNull();
    expect(await prisma.contact.count()).toBe(0);
    expect(
      (await prisma.systemSetting.findUniqueOrThrow({ where: { key: CLEANUP_SETTING_KEY } })).value,
    ).toMatchObject({ toolJobsExpired: 1 });
    // idempotente
    expect((await new CleanupService(prisma, storage).run()).importFilesRemoved).toBe(0);
  });
});

describe('monitoramento', () => {
  it('notifica e resolve: armazenamento, gateway e bucket de backup', async () => {
    let storageOk = true;
    let backupOk = true;
    const main = {
      check: async () => {
        if (!storageOk) throw new Error('timeout');
      },
    } as unknown as StorageDriver;
    const backups = {
      check: async () => {
        if (!backupOk) throw new Error('403');
      },
    } as unknown as StorageDriver;
    let gateway: string | null = null;
    let now = Date.now();
    const m = new Monitor(
      prisma,
      { get: async (k) => (k === HEARTBEAT_KEYS.gateway ? gateway : null) },
      main,
      backups,
      () => now,
    );
    const open = (k: string) =>
      prisma.systemNotification.count({ where: { dedupeKey: k, resolvedAt: null } });

    await m.tick();
    expect(await open('gateway:down')).toBe(0); // ainda dentro da tolerância
    now += GATEWAY_GRACE_MS + 1000;
    storageOk = false;
    backupOk = false;
    await m.tick();
    await m.tick();
    expect(await open('gateway:down')).toBe(1);
    expect(await open('storage:main')).toBe(1);
    expect(await open('backup:storage')).toBe(1);
    expect(m.backupStorageOk).toBe(false);

    gateway = '{"at":"x"}';
    storageOk = true;
    backupOk = true;
    await m.tick();
    expect(await open('gateway:down')).toBe(0);
    expect(await open('storage:main')).toBe(0);
    expect(await open('backup:storage')).toBe(0);
    expect(m.backupStorageOk).toBe(true);
    expect(await prisma.systemEvent.count({ where: { type: 'gateway_back' } })).toBe(1);

    // backup atrasado (depois de 1 h de worker ativo e sem backup concluído)
    now += 3_600_000;
    await m.tick();
    expect(await open('backup:overdue')).toBe(1);
  });
});
