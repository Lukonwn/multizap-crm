import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  isOperationsPaused,
  notify,
  resolveNotifications,
  type PrismaClient,
} from '@multizap/database';
import { HEARTBEAT_KEYS, type SystemStatusDTO } from '@multizap/shared';
import type { SystemQueues } from '../src/lib/queues';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let systemQueues: SystemQueues;
let s: Session;

beforeAll(async () => {
  ({ app, prisma, redis, systemQueues } = await setupTestApp());
});
afterAll(async () => {
  await redis.del(HEARTBEAT_KEYS.worker, HEARTBEAT_KEYS.gateway);
  await systemQueues.maintenance.obliterate({ force: true });
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await redis.del(HEARTBEAT_KEYS.worker, HEARTBEAT_KEYS.gateway);
  await systemQueues.maintenance.obliterate({ force: true });
  await createAdmin(prisma);
  s = await login(app);
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });
const send = (method: 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s), ...(payload && { payload }) });

const workerBeat = (backup: object | undefined) =>
  redis.set(
    HEARTBEAT_KEYS.worker,
    JSON.stringify({ at: new Date().toISOString(), pid: 1, backup }),
    'EX',
    45,
  );

describe('GET /system/status', () => {
  it('exige autenticação', async () => {
    expect((await app.inject({ method: 'GET', url: '/system/status' })).statusCode).toBe(401);
  });

  it('reflete o estado real: serviços, conexões, erros, notificações e filas', async () => {
    const a = await prisma.account.create({
      data: {
        name: 'Vendas',
        connectionType: 'WHATSAPP_WEB',
        status: 'NEEDS_REPAIR',
        statusReason: 'logged_out',
      },
    });
    await prisma.account.create({
      data: { name: 'Suporte', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    });
    await prisma.integration.create({
      data: {
        accountId: a.id,
        provider: 'whatsapp-web',
        lastError: 'logged_out',
        lastCheckAt: new Date(),
      },
    });
    await prisma.fileJob.create({ data: { tool: 'cleaner', status: 'FAILED', error: 'x' } });
    await prisma.systemEvent.create({
      data: { source: 'worker', level: 'error', type: 'x', message: 'falhou' },
    });
    await prisma.systemEvent.create({
      data: {
        source: 'worker',
        level: 'error',
        type: 'x',
        message: 'antigo',
        createdAt: new Date(Date.now() - 48 * 3_600_000),
      },
    });
    await notify(prisma, {
      severity: 'CRITICAL',
      category: 'STORAGE',
      title: 'Bucket',
      message: 'fora',
      dedupeKey: 'k1',
    });
    await notify(prisma, {
      severity: 'CRITICAL',
      category: 'STORAGE',
      title: 'Bucket',
      message: 'fora',
      dedupeKey: 'k1',
    });
    await notify(prisma, { severity: 'WARNING', category: 'SYSTEM', title: 'Aviso', message: 'x' });

    let r = await get('/system/status');
    expect(r.statusCode).toBe(200);
    let d = r.json<SystemStatusDTO>();
    expect(d.services.database.status).toBe('up');
    expect(d.services.redis.status).toBe('up');
    expect(d.services.storage.status).toBe('up');
    expect(d.services.worker.status).toBe('down');
    expect(d.services.gateway.status).toBe('down');
    expect(d.connections.total).toBe(2);
    expect(d.connections.byStatus).toEqual({ NEEDS_REPAIR: 1, CONNECTED: 1 });
    expect(d.connections.attention).toEqual([
      expect.objectContaining({ name: 'Vendas', status: 'NEEDS_REPAIR', lastError: 'logged_out' }),
    ]);
    expect(d.errors24h.systemEvents).toBe(1);
    expect(d.errors24h.toolJobsFailed).toBe(1);
    expect(d.notifications).toEqual({ open: 2, critical: 1, error: 0, warning: 1 });
    expect(d.queues.map((q) => q.name).sort()).toEqual([
      'campaigns',
      'file-tools',
      'gateway-commands',
      'imports',
      'maintenance',
    ]);
    expect(d.backups.configured).toBe(false);
    expect(d.backups.storage.status).toBe('unconfigured');
    expect(d.operations.paused).toBe(false);

    await resolveNotifications(prisma, 'k1');
    await workerBeat({
      configured: true,
      storageOk: true,
      error: null,
      hourLocal: 3,
      retentionDays: 14,
      nextAt: '2026-11-25T06:00:00.000Z',
    });
    await redis.set(
      HEARTBEAT_KEYS.gateway,
      JSON.stringify({ at: new Date().toISOString() }),
      'EX',
      45,
    );
    d = (await get('/system/status')).json<SystemStatusDTO>();
    expect(d.services.worker.status).toBe('up');
    expect(d.services.gateway.status).toBe('up');
    expect(d.notifications.critical).toBe(0);
    expect(d.backups).toMatchObject({
      configured: true,
      hourLocal: 3,
      retentionDays: 14,
      storage: { status: 'up' },
    });
    r = await get('/system/status');
    expect(r.statusCode).toBe(200);
  });
});

describe('pausa global', () => {
  it('pausa e retoma, com auditoria e evento', async () => {
    let r = await send('PUT', '/system/operations', {
      paused: true,
      reason: 'Manutenção do número',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().operations).toMatchObject({
      paused: true,
      reason: 'Manutenção do número',
      by: 'admin@multizap.local',
    });
    expect(await isOperationsPaused(prisma)).toBe(true);
    expect((await get('/system/status')).json<SystemStatusDTO>().operations.paused).toBe(true);
    r = await send('PUT', '/system/operations', { paused: false });
    expect(r.json().operations.paused).toBe(false);
    expect(await isOperationsPaused(prisma)).toBe(false);
    const actions = (await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['operations.paused', 'operations.resumed']));
    expect(await prisma.systemEvent.count({ where: { type: { startsWith: 'operations_' } } })).toBe(
      2,
    );
  });

  it('bloqueia o envio de respostas pela Central quando pausado', async () => {
    const a = await prisma.account.create({
      data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    });
    const c = await prisma.conversation.create({
      data: { accountId: a.id, remoteJid: '5511999990000@s.whatsapp.net' },
    });
    await send('PUT', '/system/operations', { paused: true });
    const r = await get(`/conversations/${c.id}`);
    expect(r.json().reply).toEqual({
      allowed: false,
      reason: 'As operações estão pausadas globalmente.',
    });
  });

  it('exige CSRF e valida o corpo', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/system/operations',
      headers: authed(s, false),
      payload: { paused: true },
    });
    expect(r.statusCode).toBe(403);
    expect((await send('PUT', '/system/operations', { paused: 'sim' })).statusCode).toBe(400);
  });
});

describe('backups manuais', () => {
  it('recusa sem worker ou sem bucket e enfileira quando configurado', async () => {
    expect((await send('POST', '/system/backups')).json().error.code).toBe('WORKER_UNAVAILABLE');
    await workerBeat({
      configured: false,
      storageOk: null,
      error: null,
      hourLocal: 3,
      retentionDays: 14,
      nextAt: null,
    });
    expect((await send('POST', '/system/backups')).json().error.code).toBe('BACKUP_NOT_CONFIGURED');
    await workerBeat({
      configured: true,
      storageOk: true,
      error: null,
      hourLocal: 3,
      retentionDays: 14,
      nextAt: null,
    });
    const r = await send('POST', '/system/backups');
    expect(r.statusCode).toBe(202);
    const id = r.json().backup.id as string;
    expect(await systemQueues.maintenance.getJob(`backup-${id}`)).toBeTruthy();
    expect((await send('POST', '/system/backups')).json().error.code).toBe('BACKUP_RUNNING');
    const list = (await get('/system/backups')).json();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id, status: 'QUEUED', trigger: 'manual' });
  });
});

describe('eventos, auditoria e notificações', () => {
  it('lista eventos com filtro', async () => {
    await prisma.systemEvent.createMany({
      data: [
        { source: 'worker', level: 'error', type: 'a', message: '1' },
        { source: 'gateway', level: 'info', type: 'b', message: '2' },
      ],
    });
    expect((await get('/system/events')).json().total).toBe(2);
    const r = (await get('/system/events?level=error')).json();
    expect(r.items.map((e: { message: string }) => e.message)).toEqual(['1']);
    expect((await get('/system/events?level=x')).statusCode).toBe(400);
  });

  it('lista a auditoria com o e-mail do autor e filtro por ação', async () => {
    const r = (await get('/audit')).json();
    expect(r.items[0]).toMatchObject({ action: 'auth.login', actorEmail: 'admin@multizap.local' });
    expect(JSON.stringify(r)).not.toMatch(/password|token/i);
    expect((await get('/audit?action=operations')).json().total).toBe(0);
  });

  it('resolve manualmente uma notificação', async () => {
    await notify(prisma, { severity: 'ERROR', category: 'IMPORT', title: 'Falha', message: 'x' });
    const n = await prisma.systemNotification.findFirstOrThrow();
    expect((await send('POST', `/notifications/${n.id}/resolve`)).statusCode).toBe(200);
    expect((await get('/notifications')).json().items).toHaveLength(0);
    expect(
      (await send('POST', '/notifications/00000000-0000-0000-0000-000000000000/resolve'))
        .statusCode,
    ).toBe(404);
  });
});
