import { ensureBootstrapAdmin, getPrisma } from '@multizap/database';
import { loadConfig } from './config';
import { buildApp } from './app';
import { createRedis } from './lib/redis';
import { GatewayClient } from './lib/gateway';
import { CampaignQueue, ImportQueue, SystemQueues, ToolQueue } from './lib/queues';
import { storageFromEnv } from '@multizap/storage';
import { cipherFromEnv } from '@multizap/shared/crypto';

const config = loadConfig();
const prisma = getPrisma();
const redis = config.redisUrl ? createRedis(config.redisUrl) : null;
redis?.on('error', () => {
  /* reconexão automática; estado exposto em /health/ready */
});
await redis?.connect().catch(() => undefined);

const gateway =
  redis && config.redisUrl ? new GatewayClient(config.redisUrl, redis, config.queuePrefix) : null;
const storage = storageFromEnv();
const importQueue = config.redisUrl ? new ImportQueue(config.redisUrl, config.queuePrefix) : null;
const toolQueue = config.redisUrl ? new ToolQueue(config.redisUrl, config.queuePrefix) : null;
const campaignQueue = config.redisUrl
  ? new CampaignQueue(config.redisUrl, config.queuePrefix)
  : null;
const systemQueues = config.redisUrl ? new SystemQueues(config.redisUrl, config.queuePrefix) : null;
// Cifra das credenciais (chave da OpenRouter). Sem CREDENTIALS_MASTER_KEY, a IA não guarda chave.
const cipher = process.env.CREDENTIALS_MASTER_KEY ? cipherFromEnv() : null;
const app = await buildApp({
  config,
  prisma,
  redis,
  gateway,
  storage,
  importQueue,
  toolQueue,
  campaignQueue,
  systemQueues,
  cipher,
});

const bootstrap = await ensureBootstrapAdmin(prisma, config.bootstrapAdmin);
if (bootstrap === 'created') app.log.info('Administrador inicial criado a partir de ADMIN_EMAIL.');
if (bootstrap === 'skipped')
  app.log.warn('Nenhum administrador cadastrado: defina ADMIN_EMAIL e ADMIN_INITIAL_PASSWORD.');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Encerrando API');
  await app.close();
  await gateway?.close();
  await importQueue?.close();
  await toolQueue?.close();
  await campaignQueue?.close();
  await systemQueues?.close();
  await prisma.$disconnect();
  redis?.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
