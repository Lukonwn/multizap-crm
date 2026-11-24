// Prepara o banco descartável dos testes de ponta a ponta.
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url || !/(e2e|test)/i.test(new URL(url).pathname)) {
  throw new Error(
    'E2E_DATABASE_URL deve apontar para um banco descartável (nome com "e2e" ou "test").',
  );
}
execSync('pnpm exec prisma migrate deploy', {
  cwd: resolve(here, '../../packages/database'),
  env: process.env,
  stdio: 'inherit',
});
const prisma = new PrismaClient({ datasources: { db: { url } } });
const tables = await prisma.$queryRaw`
  SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
await prisma.$executeRawUnsafe(
  `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
);
await prisma.$disconnect();
rmSync(resolve(here, '.data/storage'), { recursive: true, force: true });
rmSync(resolve(here, '.data/backups'), { recursive: true, force: true });
console.log('Banco de e2e preparado.');
