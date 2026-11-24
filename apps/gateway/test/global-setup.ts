import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Aplica as migrations reais no banco de testes (operação não destrutiva).
 * Cada suíte limpa as tabelas com TRUNCATE antes dos testes (ver helpers.ts).
 * Use sempre um banco dedicado a testes em TEST_DATABASE_URL.
 */
export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgresql://multizap:multizap@localhost:5432/multizap_test';
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error('TEST_DATABASE_URL deve apontar para um banco cujo nome contenha "test".');
  }
  process.env.TEST_DATABASE_URL = url;
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(__dirname, '../../../packages/database'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
