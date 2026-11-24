import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import { HEARTBEAT_KEYS } from '@multizap/shared';
import type { GatewayClient } from '../src/lib/gateway';
import { InboxIngest } from '../../gateway/src/inbox/ingest';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let gateway: GatewayClient;
let ingest: InboxIngest;
let s: Session;
let A: string;
let B: string;

beforeAll(async () => {
  ({ app, prisma, redis, gateway } = await setupTestApp());
  ingest = new InboxIngest(prisma, null);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await gateway.rawQueue.drain(true);
  await redis.set(HEARTBEAT_KEYS.gateway, '1', 'EX', 60);
  await createAdmin(prisma);
  s = await login(app);
  A = (
    await prisma.account.create({
      data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    })
  ).id;
  B = (
    await prisma.account.create({
      data: { name: 'Suporte', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    })
  ).id;
});

const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s, method !== 'GET'), payload });
const incoming = (
  accountId: string,
  id: string,
  text: string,
  phone = '5511987654321',
  over: object = {},
) =>
  ingest.ingest(
    accountId,
    [
      {
        id,
        chatJid: `${phone}@s.whatsapp.net`,
        phoneE164: `+${phone}`,
        fromMe: false,
        timestamp: new Date(),
        type: 'text',
        text,
        pushName: 'Joana Lima',
        ...over,
      },
    ],
    false,
  );

describe('central de mensagens', () => {
  it('lista conversas de todas as instâncias com filtros e identificação da instância', async () => {
    await incoming(A, 'a1', 'Oi, Vendas');
    await incoming(B, 'b1', 'Oi, Suporte', '5521998765432');
    await incoming(B, 'b2', 'Ajuda', '5531987651234');
    const all = (await req('GET', '/conversations')).json();
    expect(all.total).toBe(3);
    expect(all.items.map((c: { accountName: string }) => c.accountName).sort()).toEqual([
      'Suporte',
      'Suporte',
      'Vendas',
    ]);
    expect((await req('GET', `/conversations?accountId=${A}`)).json().total).toBe(1);
    expect((await req('GET', '/conversations?filter=unread')).json().total).toBe(3);
    expect((await req('GET', '/conversations?filter=pending')).json().total).toBe(3);
    expect((await req('GET', '/conversations?q=9876-5432')).json().total).toBeGreaterThanOrEqual(1);
    expect((await req('GET', '/conversations/unread')).json().conversations).toBe(3);
  });

  it('abre a conversa com histórico, dados do contato e permissão de resposta; marca como lida', async () => {
    await incoming(A, 'a1', 'Quanto custa?');
    const conv = (await req('GET', '/conversations')).json().items[0];
    const d = (await req('GET', `/conversations/${conv.id}`)).json();
    expect(d.contact).toMatchObject({
      name: 'Joana Lima',
      origin: 'INBOUND',
      consentStatus: 'PENDING',
    });
    expect(d.reply).toEqual({ allowed: true, reason: null });
    const msgs = (await req('GET', `/conversations/${conv.id}/messages`)).json();
    expect(msgs.items).toEqual([
      expect.objectContaining({ direction: 'INBOUND', body: 'Quanto custa?', status: 'RECEIVED' }),
    ]);
    await req('POST', `/conversations/${conv.id}/read`);
    expect((await req('GET', '/conversations?filter=unread')).json().total).toBe(0);
  });

  it('resposta cria mensagem pendente e enfileira o envio para o gateway', async () => {
    await incoming(A, 'a1', 'Oi');
    const conv = (await req('GET', '/conversations')).json().items[0];
    const r = await req('POST', `/conversations/${conv.id}/messages`, {
      text: 'Olá! Como posso ajudar?',
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().message).toMatchObject({ status: 'PENDING', direction: 'OUTBOUND' });
    const jobs = (await gateway.rawQueue.getJobs(['waiting'])).map((j) => j.data);
    expect(jobs).toEqual([{ type: 'send-reply', accountId: A, messageId: r.json().message.id }]);
  });

  it('bloqueia resposta com instância desconectada, pausa global e contato descadastrado', async () => {
    await incoming(A, 'a1', 'Oi');
    const conv = (await req('GET', '/conversations')).json().items[0];
    const send = () => req('POST', `/conversations/${conv.id}/messages`, { text: 'x' });

    await prisma.account.update({ where: { id: A }, data: { status: 'DISCONNECTED' } });
    expect((await send()).json().error.message).toContain('não está conectada');
    await prisma.account.update({ where: { id: A }, data: { status: 'CONNECTED' } });

    await prisma.systemSetting.create({ data: { key: 'operations_paused', value: true } });
    expect((await send()).json().error.code).toBe('REPLY_NOT_ALLOWED');
    await prisma.systemSetting.deleteMany();

    await incoming(A, 'a2', 'SAIR');
    expect((await req('GET', `/conversations/${conv.id}`)).json().reply.allowed).toBe(false);
    expect((await send()).statusCode).toBe(409);
    // se o contato escrever de novo depois do descadastro, a resposta volta a ser permitida
    await new Promise((r) => setTimeout(r, 20));
    await incoming(A, 'a3', 'Na verdade, tenho uma dúvida');
    expect((await send()).statusCode).toBe(202);
  });

  it('finaliza e reabre conversas; nova mensagem reabre uma finalizada', async () => {
    await incoming(A, 'a1', 'Oi');
    const conv = (await req('GET', '/conversations')).json().items[0];
    expect(
      (await req('POST', `/conversations/${conv.id}/status`, { status: 'CLOSED' })).json()
        .conversation.status,
    ).toBe('CLOSED');
    expect((await req('GET', '/conversations?filter=closed')).json().total).toBe(1);
    await incoming(A, 'a2', 'Mais uma pergunta');
    expect((await req('GET', `/conversations/${conv.id}`)).json().conversation.status).toBe(
      'PENDING',
    );
  });

  it('pagina o histórico do mais recente para o mais antigo', async () => {
    const base = Date.now() - 100_000;
    for (let i = 0; i < 5; i++)
      await incoming(A, `p${i}`, `msg ${i}`, '5511987654321', {
        timestamp: new Date(base + i * 1000),
      });
    const conv = (await req('GET', '/conversations')).json().items[0];
    const first = (await req('GET', `/conversations/${conv.id}/messages?limit=3`)).json();
    expect(first.items.map((m: { body: string }) => m.body)).toEqual(['msg 2', 'msg 3', 'msg 4']);
    expect(first.hasMore).toBe(true);
    const older = (
      await req(
        'GET',
        `/conversations/${conv.id}/messages?limit=3&before=${encodeURIComponent(first.items[0].sentAt)}`,
      )
    ).json();
    expect(older.items.map((m: { body: string }) => m.body)).toEqual(['msg 0', 'msg 1']);
    expect(older.hasMore).toBe(false);
  });
});
