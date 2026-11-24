import { getPrisma } from '@multizap/database';
import { backupStorageFromEnv, storageFromEnv } from '@multizap/storage';
import { BackupService } from './maintenance/backup';
import { parseBackupKey } from './maintenance/crypto-stream';

/**
 * Restauração de backup (linha de comando, executada manualmente).
 *
 *   node dist/restore.js --list
 *   node dist/restore.js <manifesto|latest> [--force] [--no-files]
 *
 * Requer DATABASE_URL (banco de destino com as migrations aplicadas),
 * BACKUP_S3_* (ou BACKUP_LOCAL_DIR), BACKUP_ENCRYPTION_KEY e o armazenamento
 * principal (STORAGE_*) para onde os arquivos voltam.
 */
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const target = args.find((a) => !a.startsWith('--'));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL não configurada.');
const backups = backupStorageFromEnv();
if (!backups)
  throw new Error('Bucket de backup não configurado (BACKUP_S3_* ou BACKUP_LOCAL_DIR).');
const prisma = getPrisma();
const service = new BackupService(
  prisma,
  databaseUrl,
  storageFromEnv(),
  backups,
  parseBackupKey(process.env.BACKUP_ENCRYPTION_KEY),
  (msg, extra) => console.log(msg, extra ?? ''),
);

try {
  const available = await service.available();
  if (flag('--list') || !target) {
    if (!available.length) console.log('Nenhum backup encontrado no bucket.');
    for (const key of available) {
      const m = await service.readManifest(key);
      const rows = m.tables.reduce((s, t) => s + t.rows, 0);
      console.log(`${key}  ${m.createdAt}  ${rows} registros  ${m.files.count} arquivos`);
    }
    if (!target)
      console.log('\nUso: node dist/restore.js <manifesto|latest> [--force] [--no-files]');
  } else {
    const key = target === 'latest' ? available[0] : target;
    if (!key) throw new Error('Nenhum backup encontrado no bucket.');
    console.log(`Restaurando ${key}${flag('--force') ? ' (substituindo os dados atuais)' : ''}...`);
    const r = await service.restore(key, { force: flag('--force'), files: !flag('--no-files') });
    for (const t of r.tables) if (t.rows) console.log(`  ${t.name}: ${t.rows}`);
    console.log(`Arquivos restaurados: ${r.filesRestored} (já existentes: ${r.filesSkipped}).`);
    console.log('Restauração concluída.');
  }
} catch (err) {
  console.error(`Falha: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
