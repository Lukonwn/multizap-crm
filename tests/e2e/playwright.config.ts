import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Testes de ponta a ponta (fumaça) contra os builds de produção reais:
 * API, worker e painel, com PostgreSQL e Redis. O gateway não é iniciado
 * (o ambiente de testes não alcança o WhatsApp).
 *
 * Pré-requisitos: `pnpm build` e E2E_DATABASE_URL apontando para um banco
 * descartável (o nome precisa conter "e2e" ou "test"; ele é esvaziado).
 */
const root = resolve(__dirname, '../..');
const data = resolve(__dirname, '.data');
const dbUrl =
  process.env.E2E_DATABASE_URL ?? 'postgresql://multizap:multizap@localhost:5432/multizap_e2e';
export const ADMIN = {
  email: 'admin@e2e.local',
  initial: 'Senha-Inicial-E2E-1!',
  final: 'Senha-Final-E2E-2#',
};

const env = {
  NODE_ENV: 'production',
  DATABASE_URL: dbUrl,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  BULLMQ_PREFIX: 'mze2e',
  WEB_ORIGIN: 'http://localhost:3100',
  API_PORT: '4300',
  CREDENTIALS_MASTER_KEY: randomBytes(32).toString('base64'),
  INTERNAL_API_TOKEN: randomBytes(24).toString('hex'),
  ADMIN_EMAIL: ADMIN.email,
  ADMIN_INITIAL_PASSWORD: ADMIN.initial,
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: `${data}/storage`,
  STORAGE_ALLOW_LOCAL_IN_PRODUCTION: 'true',
  BACKUP_LOCAL_DIR: `${data}/backups`,
  BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  API_INTERNAL_URL: 'http://localhost:4300',
  LOGIN_RATE_LIMIT_PER_MINUTE: '100',
};

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: `${data}/report` }]]
    : 'list',
  outputDir: `${data}/results`,
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'off',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      // Prepara o banco (migrations + limpeza) antes de iniciar a API.
      command: 'node tests/e2e/prepare.mjs && node apps/api/dist/server.js',
      cwd: root,
      url: 'http://localhost:4300/health',
      env,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'node apps/worker/dist/main.js',
      cwd: root,
      url: 'http://localhost:4301/health',
      env: { ...env, PORT: '4301' },
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @multizap/web exec next start -p 3100',
      cwd: root,
      url: 'http://localhost:3100/healthz',
      env,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
