import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, type PrismaClient } from '@multizap/database';
import { LocalStorage, streamToBuffer } from '@multizap/storage';
import { BackupService, backupSlots, zonedHourToUtc } from '../src/maintenance/backup';
import { decryptStream, encryptStream } from '../src/maintenance/crypto-stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const url = process.env.TEST_DATABASE_URL!;
const prisma: PrismaClient = createPrisma(url);
afterAll(() => prisma.$disconnect());

const truncateAll = async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
};

/** Fotografia completa do banco (todas as tabelas, ordenadas), para comparar. */
const snapshot = async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`;
  const out: Record<string, string[]> = {};
  for (const { tablename } of tables) {
    const rows = await prisma.$queryRawUnsafe<{ j: string }[]>(
      `SELECT row_to_json(t)::text AS j FROM "${tablename}" t`,
    );
    out[tablename] = rows.map((r) => r.j).sort();
  }
  return out;
};

let main: LocalStorage;
let bucket: LocalStorage;
let key: Buffer;
let service: BackupService;

beforeEach(async () => {
  await truncateAll();
  main = new LocalStorage(mkdtempSync(join(tmpdir(), 'mz-main-')));
  bucket = new LocalStorage(mkdtempSync(join(tmpdir(), 'mz-bkp-')));
  key = randomBytes(32);
  service = new BackupService(prisma, url, main, bucket, key);
});

async function seed() {
  const a = await prisma.account.create({
    data: { name: 'Vendas "SP"', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
  });
  await prisma.integration.create({
    data: {
      accountId: a.id,
      provider: 'whatsapp-web',
      credentialsEnc: new Uint8Array(randomBytes(64)),
      lastError: 'linha\ttab\\barra\nquebra',
    },
  });
  const tag = await prisma.tag.create({ data: { accountId: a.id, name: 'VIP ✨' } });
  const c = await prisma.contact.create({
    data: {
      accountId: a.id,
      phoneE164: '+5511900000001',
      name: 'José Ñandú',
      notes: 'çãõ "aspas" \\N',
      consentStatus: 'GRANTED',
    },
  });
  await prisma.contactTag.create({ data: { contactId: c.id, tagId: tag.id } });
  const imp = await prisma.import.create({
    data: {
      accountId: a.id,
      fileName: 'x.csv',
      fileKey: 'imports/x.csv',
      fileHash: 'h',
      fileSize: BigInt(10),
      format: 'csv',
    },
  });
  await prisma.importRow.create({
    data: {
      importId: imp.id,
      rowNumber: 1,
      raw: { cidade: 'São Paulo', n: [1, 2], v: null },
      status: 'VALID',
      tags: ['a', 'b,c', 'd"e'],
    },
  });
  const folder = await prisma.assetFolder.create({ data: { name: 'Raiz' } });
  await prisma.assetFolder.create({ data: { name: 'Filha', parentId: folder.id } });
  await prisma.asset.create({
    data: {
      kind: 'IMAGE',
      name: 'Banner',
      storageKey: 'assets/banner.png',
      mimeType: 'image/png',
      sizeBytes: BigInt(3),
      sha256: 'abc',
      folderId: folder.id,
    },
  });
  // MultiZap AI: agente e versão publicada se referenciam (chave adiável na restauração).
  const persona = await prisma.aiPersona.create({ data: { name: 'Ana' } });
  const agent = await prisma.aiAgent.create({
    data: { name: 'Atendente', personaId: persona.id, model: 'openai/gpt-4o-mini' },
  });
  const version = await prisma.aiAgentVersion.create({
    data: { agentId: agent.id, number: 1, snapshot: { name: 'Atendente' } },
  });
  await prisma.aiAgent.update({
    where: { id: agent.id },
    data: { publishedVersionId: version.id },
  });
  await prisma.aiAgentAccount.create({ data: { agentId: agent.id, accountId: a.id } });
  // Base de conhecimento: fonte, trecho (com acentos) e vínculo com o agente.
  const kb = await prisma.aiKnowledgeSource.create({
    data: {
      name: 'Políticas',
      kind: 'TEXT',
      content: 'Troca em até 7 dias.',
      status: 'READY',
      chunkCount: 1,
    },
  });
  await prisma.aiKnowledgeChunk.create({
    data: {
      sourceId: kb.id,
      position: 0,
      title: 'Trocas',
      content: 'Aceitamos trocas em até 7 dias.',
    },
  });
  await prisma.aiAgentKnowledge.create({ data: { agentId: agent.id, sourceId: kb.id } });
  await main.put('assets/banner.png', Buffer.from([1, 2, 3]));
  await main.put('media/inbox/foto.jpg', Buffer.from('jpeg'));
  await main.put('tools/uploads/temp.csv', Buffer.from('nao vai para o backup'));
  return { a };
}

describe('criptografia dos backups', () => {
  it('ida e volta, e rejeita chave errada ou arquivo adulterado', async () => {
    const k = randomBytes(32);
    const data = randomBytes(100_000);
    const enc = await streamToBuffer(Readable.from([data]).pipe(encryptStream(k, 'aad')));
    const dec = await streamToBuffer(Readable.from([enc]).pipe(decryptStream(k, 'aad')));
    expect(dec.equals(data)).toBe(true);
    const run = (buf: Buffer, kk: Buffer, aad = 'aad') =>
      pipeline(Readable.from([buf]), decryptStream(kk, aad), async function* (s) {
        for await (const _ of s) {
          /* consome */
        }
      });
    await expect(run(enc, randomBytes(32))).rejects.toThrow(/descriptografar/);
    await expect(run(enc, k, 'outro')).rejects.toThrow(/descriptografar/);
    const bad = Buffer.from(enc);
    bad[500] = bad[500]! ^ 1;
    await expect(run(bad, k)).rejects.toThrow(/descriptografar/);
    await expect(run(enc.subarray(0, 10), k)).rejects.toThrow();
  });
});

describe('backup e restauração', () => {
  it('restaura exatamente o mesmo banco e os arquivos', async () => {
    await seed();
    const before = await snapshot();
    const b = await prisma.backup.create({ data: { trigger: 'manual' } });
    await service.run(b.id);

    const done = await prisma.backup.findUniqueOrThrow({ where: { id: b.id } });
    expect(done.status).toBe('COMPLETED');
    expect(Number(done.sizeBytes)).toBeGreaterThan(0);
    const manifest = await service.readManifest(done.dbKey!);
    expect(manifest.files.keys).toEqual(['assets/banner.png', 'media/inbox/foto.jpg']);
    expect(manifest.tables.find((t) => t.name === 'contacts')!.rows).toBe(1);
    // nada em texto aberto no bucket
    for await (const o of bucket.list('')) {
      if (o.key.endsWith('manifest.json')) continue;
      const raw = (await streamToBuffer(await bucket.get(o.key))).toString('latin1');
      expect(raw).not.toContain('José');
      expect(raw.startsWith('MZB1')).toBe(true);
    }

    // desastre: banco e arquivos perdidos
    await truncateAll();
    await main.delete('assets/banner.png');
    await main.delete('media/inbox/foto.jpg');

    const r = await service.restore(done.dbKey!);
    expect(r.filesRestored).toBe(2);
    const after = await snapshot();
    // o próprio registro do backup é anterior à conclusão: comparar o resto
    delete before.backups;
    delete after.backups;
    expect(after).toEqual(before);
    expect([...(await streamToBuffer(await main.get('assets/banner.png')))]).toEqual([1, 2, 3]);
  });

  it('recusa banco com dados (sem --force), chave diferente e migrations divergentes', async () => {
    await seed();
    const b = await prisma.backup.create({ data: { trigger: 'manual' } });
    await service.run(b.id);
    const manifestKey = (await prisma.backup.findUniqueOrThrow({ where: { id: b.id } })).dbKey!;

    await expect(service.restore(manifestKey)).rejects.toThrow(/já tem dados/);
    const other = new BackupService(prisma, url, main, bucket, randomBytes(32));
    await expect(other.restore(manifestKey)).rejects.toThrow(/BACKUP_ENCRYPTION_KEY/);

    // --force substitui os dados atuais (transação única)
    await prisma.contact.updateMany({ data: { name: 'Alterado' } });
    await prisma.contact.create({
      data: {
        accountId: (await prisma.account.findFirstOrThrow()).id,
        phoneE164: '+5511900000099',
      },
    });
    await service.restore(manifestKey, { force: true, files: false });
    expect((await prisma.contact.findMany()).map((c) => c.name)).toEqual(['José Ñandú']);

    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ('teste-x', 'x', '99999999_teste', now(), now(), 1)`,
    );
    try {
      await expect(service.restore(manifestKey, { force: true })).rejects.toThrow(/migrations/);
    } finally {
      await prisma.$executeRawUnsafe(`DELETE FROM _prisma_migrations WHERE id = 'teste-x'`);
    }
  });

  it('falha de backup marca o registro, notifica e não deixa o processo travado', async () => {
    const broken = new BackupService(
      prisma,
      'postgresql://ninguem:x@127.0.0.1:1/nada',
      main,
      bucket,
      key,
    );
    const b = await prisma.backup.create({ data: { trigger: 'scheduled' } });
    await expect(broken.run(b.id)).rejects.toThrow();
    expect((await prisma.backup.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('FAILED');
    expect(
      await prisma.systemNotification.count({
        where: { dedupeKey: 'backup:failed', resolvedAt: null },
      }),
    ).toBe(1);
    // sucesso seguinte resolve a notificação
    const ok = await prisma.backup.create({ data: { trigger: 'manual' } });
    await service.run(ok.id);
    expect(
      await prisma.systemNotification.count({
        where: { dedupeKey: 'backup:failed', resolvedAt: null },
      }),
    ).toBe(0);
    // não processa duas vezes
    await service.run(ok.id);
    expect((await service.available()).length).toBe(1);
  });

  it('retenção remove backups antigos, mantém os 3 mais recentes e limpa o espelho', async () => {
    await seed();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const b = await prisma.backup.create({ data: { trigger: 'scheduled' } });
      await service.run(b.id);
      ids.push(b.id);
      if (i === 0) await main.delete('media/inbox/foto.jpg'); // a foto só existe no 1º backup
    }
    // os 4 primeiros ficam "antigos"
    for (let i = 0; i < 4; i++)
      await prisma.backup.update({
        where: { id: ids[i]! },
        data: { createdAt: new Date(Date.now() - (34 - i) * 86_400_000) },
      });
    const r = await service.prune(14);
    expect(r.removed).toBe(2); // mantém o mais novo + 2 antigos (mínimo de 3)
    expect(await prisma.backup.count()).toBe(3);
    expect(await service.available()).toHaveLength(3);
    // a foto só estava no 1º backup (removido): sai do espelho
    expect(r.filesRemoved).toBe(1);
    expect(await bucket.exists('files/assets/banner.png')).toBe(true);
    expect(await bucket.exists('files/media/inbox/foto.jpg')).toBe(false);
  });
});

describe('agenda do backup automático', () => {
  it('converte o horário local para UTC e calcula o último e o próximo', () => {
    expect(zonedHourToUtc('2026-11-24', 3, 'America/Sao_Paulo').toISOString()).toBe(
      '2026-11-24T06:00:00.000Z',
    );
    expect(zonedHourToUtc('2026-07-01', 3, 'Europe/Lisbon').toISOString()).toBe(
      '2026-07-01T02:00:00.000Z',
    );
    const s1 = backupSlots(new Date('2026-11-24T05:00:00Z'), 3, 'America/Sao_Paulo');
    expect(s1.last.toISOString()).toBe('2026-11-23T06:00:00.000Z');
    expect(s1.next.toISOString()).toBe('2026-11-24T06:00:00.000Z');
    const s2 = backupSlots(new Date('2026-11-24T07:00:00Z'), 3, 'America/Sao_Paulo');
    expect(s2.last.toISOString()).toBe('2026-11-24T06:00:00.000Z');
    expect(s2.next.toISOString()).toBe('2026-11-25T06:00:00.000Z');
  });
});
