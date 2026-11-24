import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Worker } from 'bullmq';
import pino from 'pino';
import { getPrisma, notify, recordSystemEvent, resolveNotifications } from '@multizap/database';
import { GATEWAY_QUEUE, HEARTBEAT_KEYS, type GatewayCommand } from '@multizap/shared';
import { cipherFromEnv } from '@multizap/shared/crypto';
import { onShutdown, startHealthServer, startHeartbeat } from '@multizap/shared/runtime';
import { DbAuthStore } from './whatsapp/auth-store';
import { BaileysFactory } from './whatsapp/baileys-factory';
import { LockManager } from './session/lock';
import { SessionManager } from './session/manager';
import { handleCommand } from './commands';
import { CampaignSender } from './campaigns/sender';
import { InboxIngest } from './inbox/ingest';
import { ReplySender } from './inbox/reply-sender';
import { PhotoSync } from './inbox/photo-sync';
import { storageFromEnv } from '@multizap/storage';

/**
 * multizap-gateway — dono das conexões WhatsApp (dispositivos conectados).
 * Restaura todas as sessões pareadas ao iniciar e executa os comandos da API.
 */
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL não configurada.');

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'multizap-gateway' },
});
const baileysLogger = pino({
  level: process.env.BAILEYS_LOG_LEVEL ?? 'warn',
  base: { service: 'baileys' },
});
const log = (msg: string, extra: Record<string, unknown> = {}) => logger.info(extra, msg);

const prisma = getPrisma();
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis'));

await prisma.$queryRaw`SELECT 1`;

const store = new DbAuthStore(prisma, cipherFromEnv());
const factory = new BaileysFactory(
  store,
  baileysLogger,
  process.env.GATEWAY_BROWSER_NAME || 'Chrome',
);
const locks = new LockManager(redis, `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`);
// Armazenamento (imagens de campanhas e mídias recebidas). Opcional: sem ele, só texto.
let storage = null;
try {
  storage = storageFromEnv();
} catch (err) {
  logger.warn(
    { err: (err as Error).message },
    'Armazenamento indisponível: imagens não serão enviadas nem armazenadas',
  );
}
const ingest = new InboxIngest(prisma, storage, log);
const manager = new SessionManager(prisma, redis, factory, store, locks, {
  log,
  onMessages: (accountId, messages, historical) => ingest.ingest(accountId, messages, historical),
  onIdentities: async (accountId, items) => {
    await ingest.identities.apply(accountId, items);
  },
  onHistory: async (accountId, h) => {
    const acc = await prisma.account.findUnique({
      where: { id: accountId },
      select: { name: true },
    });
    await recordSystemEvent(prisma, {
      source: 'gateway',
      level: 'info',
      type: 'history_received',
      message: `Sincronização do WhatsApp (${acc?.name ?? accountId}): ${h.chats} conversas, ${h.messages} mensagens, ${h.contacts} contatos e ${h.lidMappings} correspondências de LID${h.progress !== null ? ` (progresso ${h.progress}%)` : ''}.`,
    });
  },
});
// Fotos de perfil das conversas existentes (devagar, poucas por vez).
const stopPhotos = storage ? new PhotoSync(prisma, storage, manager, log).start() : () => undefined;
const replies = new ReplySender(prisma, manager, log);
const sender = new CampaignSender(prisma, storage, manager, log);
const interrupted = await sender.recoverInterrupted();
if (interrupted) log('Envios interrompidos marcados para conferência', { interrupted });

locks.startRenewal((accountId) => manager.onLockLost(accountId));
await manager.reconcile();
const reconcileTimer = setInterval(() => {
  manager.reconcile().catch((err: unknown) => logger.error({ err }, 'Falha no reconcile'));
}, 30_000);
reconcileTimer.unref();

const worker = new Worker<GatewayCommand>(
  GATEWAY_QUEUE,
  async (job) => {
    log('Comando recebido', { type: job.data.type, accountId: job.data.accountId });
    await handleCommand(manager, sender, job.data, replies);
  },
  { connection: redis.duplicate(), concurrency: 5, prefix: process.env.BULLMQ_PREFIX || 'bull' },
);
worker.on('failed', (job, err) => {
  logger.error({ err: err.message, type: job?.data.type }, 'Comando falhou');
  void recordSystemEvent(prisma, {
    source: 'gateway',
    level: 'error',
    type: 'command_failed',
    message: `Comando "${job?.data.type ?? '?'}" falhou: ${err.message}`,
  });
});

// O worker vigia o gateway; o gateway vigia o worker (cada um notifica a falha do outro).
const startedAt = Date.now();
let workerMissingSince: number | null = null;
const watchTimer = setInterval(async () => {
  const alive = await redis.get(HEARTBEAT_KEYS.worker).catch(() => null);
  if (alive) {
    workerMissingSince = null;
    await resolveNotifications(prisma, 'worker:down');
    return;
  }
  workerMissingSince ??= Math.max(Date.now(), startedAt);
  if (Date.now() - workerMissingSince < 2 * 60_000) return;
  await notify(prisma, {
    severity: 'ERROR',
    category: 'PROCESSING',
    title: 'Worker sem resposta',
    message:
      'O serviço de processamento não envia sinal há mais de 2 minutos. Importações, ferramentas, agendamentos e backups estão parados.',
    dedupeKey: 'worker:down',
  });
}, 60_000);
watchTimer.unref();

const stopHeartbeat = startHeartbeat(redis, HEARTBEAT_KEYS.gateway, () => ({
  sessions: manager.activeCount,
}));
const health = process.env.PORT
  ? startHealthServer(Number(process.env.PORT), () => redis.status === 'ready', 'multizap-gateway')
  : null;
log('Gateway pronto', { owner: locks.ownerId });

onShutdown(async () => {
  clearInterval(reconcileTimer);
  clearInterval(watchTimer);
  stopPhotos();
  stopHeartbeat();
  await worker.close();
  // Encerra sockets SEM logout: as sessões são restauradas na próxima inicialização.
  await manager.shutdown();
  health?.close();
  await prisma.$disconnect();
  redis.disconnect();
}, log);
