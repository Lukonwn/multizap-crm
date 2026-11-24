import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import type { StorageDriver } from '@multizap/storage';
import { HEARTBEAT_KEYS } from '@multizap/shared';
import type { GatewayClient } from '../src/lib/gateway';
import { InboxIngest } from '../../gateway/src/inbox/ingest';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let gateway: GatewayClient;
let storage: StorageDriver;
let ingest: InboxIngest;
let s: Session;
let A: string;
let B: string;

beforeAll(async () => {
  ({ app, prisma, redis, gateway, storage } = await setupTestApp());
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

  it('mostra nome e telefone de conversas por LID e serve a foto de perfil', async () => {
    await ingest.ingest(
      A,
      [
        {
          id: 'lid1',
          chatJid: '188123456789012@lid',
          phoneE164: null,
          fromMe: false,
          timestamp: new Date(),
          type: 'text',
          text: 'oi',
          pushName: null,
        },
      ],
      false,
    );
    let conv = (await req('GET', '/conversations')).json().items[0];
    expect(conv).toMatchObject({ phoneE164: null, title: null, photoUrl: null });
    expect((await req('GET', `/conversations/${conv.id}/photo`)).statusCode).toBe(404);

    await ingest.identities.apply(A, [
      {
        lid: '188123456789012@lid',
        phoneJid: '5511987654321@s.whatsapp.net',
        savedName: 'Joana Lima',
      },
    ]);
    const stored = (await prisma.conversation.findFirstOrThrow()).id;
    await storage.put(`avatars/${A}/foto.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await prisma.conversation.update({
      where: { id: stored },
      data: { photoKey: `avatars/${A}/foto.jpg` },
    });

    conv = (await req('GET', '/conversations')).json().items[0];
    expect(conv).toMatchObject({
      phoneE164: '+5511987654321',
      title: 'Joana Lima',
      photoUrl: `/api/conversations/${stored}/photo`,
    });
    const photo = await req('GET', `/conversations/${stored}/photo`);
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    expect(photo.headers['content-security-policy']).toContain('sandbox');
    expect([...photo.rawPayload]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect(
      (await app.inject({ method: 'GET', url: `/conversations/${stored}/photo` })).statusCode,
    ).toBe(401);
  });

  it('serve áudios e imagens com o tipo de conteúdo certo e isolados em sandbox', async () => {
    const conv = await prisma.conversation.create({
      data: { accountId: A, remoteJid: '5511987654321@s.whatsapp.net' },
    });
    const mk = async (id: string, key: string, type: string) => {
      await storage.put(key, Buffer.from([1, 2, 3]));
      return prisma.message.create({
        data: {
          accountId: A,
          conversationId: conv.id,
          providerMessageId: id,
          direction: 'INBOUND',
          type,
          mediaKey: key,
          status: 'RECEIVED',
          sentAt: new Date(),
        },
      });
    };
    const ogg = await mk('au1', `media/${A}/au1.ogg`, 'audio');
    const m4a = await mk('au2', `media/${A}/au2.m4a`, 'audio');
    const jpg = await mk('im1', `media/${A}/im1.jpg`, 'image');
    const types = async (id: string) =>
      (await req('GET', `/messages/${id}/media`)).headers['content-type'];
    expect(await types(ogg.id)).toBe('audio/ogg');
    expect(await types(m4a.id)).toBe('audio/mp4');
    expect(await types(jpg.id)).toBe('image/jpeg');
    const r = await req('GET', `/messages/${ogg.id}/media`);
    expect(r.headers['content-security-policy']).toContain('sandbox');
    expect([...r.rawPayload]).toEqual([1, 2, 3]);
    const list = (await req('GET', `/conversations/${conv.id}/messages`)).json().items;
    expect(list.find((x: { id: string }) => x.id === ogg.id)).toMatchObject({
      type: 'audio',
      hasMedia: true,
    });
    expect((await app.inject({ method: 'GET', url: `/messages/${ogg.id}/media` })).statusCode).toBe(
      401,
    );
  });

  describe('nova conversa', () => {
    const start = (accountId: string, phoneE164: string) =>
      req('POST', `/accounts/${accountId}/conversations/start`, { phoneE164 });

    it('abre a conversa com um número da agenda, sem criar contato nem enviar nada', async () => {
      await prisma.waIdentity.create({
        data: {
          accountId: A,
          jid: '5511955550000@s.whatsapp.net',
          phoneE164: '+5511955550000',
          savedName: 'Maria da Padaria',
        },
      });
      const r = await start(A, '+5511955550000');
      expect(r.statusCode).toBe(201);
      const conv = r.json().conversation;
      expect(conv).toMatchObject({
        title: 'Maria da Padaria',
        phoneE164: '+5511955550000',
        accountId: A,
      });
      expect(await prisma.contact.count()).toBe(0);
      expect(await prisma.message.count()).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: 'conversation.started' } })).toBe(1);
      // conversa vazia não aparece na lista; a abertura direta funciona e permite responder
      expect((await req('GET', '/conversations')).json().items).toHaveLength(0);
      const open = (await req('GET', `/conversations/${conv.id}`)).json();
      expect(open.reply).toEqual({ allowed: true, reason: null });
      const sent = await req('POST', `/conversations/${conv.id}/messages`, {
        text: 'Bom dia, Maria!',
      });
      expect(sent.statusCode).toBe(202);
      expect(
        await prisma.message.count({ where: { conversationId: conv.id, status: 'PENDING' } }),
      ).toBe(1);
    });

    it('é idempotente, reaproveita conversa por LID e vincula contato do CRM existente', async () => {
      const crm = await prisma.contact.create({
        data: { accountId: A, phoneE164: '+5511955550001', name: 'Carlos CRM' },
      });
      const first = (await start(A, '+5511955550001')).json();
      expect(first.created).toBe(true);
      expect(first.conversation.contactName).toBe('Carlos CRM');
      const again = await start(A, '+5511955550001');
      expect(again.statusCode).toBe(200);
      expect(again.json().conversation.id).toBe(first.conversation.id);
      expect(await prisma.conversation.count()).toBe(1);
      expect(await prisma.contact.count()).toBe(1);
      expect((await prisma.conversation.findFirstOrThrow()).contactId).toBe(crm.id);

      // conversa existente endereçada por LID
      await prisma.waIdentity.create({
        data: {
          accountId: A,
          jid: '5511955550002@s.whatsapp.net',
          lid: '999@lid',
          phoneE164: '+5511955550002',
        },
      });
      const lidConv = await prisma.conversation.create({
        data: { accountId: A, remoteJid: '999@lid', lastMessageAt: new Date() },
      });
      expect((await start(A, '+5511955550002')).json().conversation.id).toBe(lidConv.id);
    });

    it('isola por instância, valida o número e recusa aparelho apenas cadastrado', async () => {
      const first = (await start(A, '+5511955550003')).json().conversation;
      const other = (await start(B, '+5511955550003')).json().conversation;
      expect(other.id).not.toBe(first.id);
      expect(await prisma.conversation.count()).toBe(2);
      expect((await start(A, '11955550003')).statusCode).toBe(400);
      expect((await start(A, '+55abc')).statusCode).toBe(400);
      const ext = await prisma.account.create({
        data: { name: 'Celular', connectionType: 'EXTERNAL_DEVICE' },
      });
      expect((await start(ext.id, '+5511955550003')).json().error.code).toBe('NOT_WHATSAPP_WEB');
      expect(
        (await start('00000000-0000-0000-0000-000000000000', '+5511955550003')).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/accounts/${A}/conversations/start`,
            headers: authed(s, false),
            payload: { phoneE164: '+5511955550003' },
          })
        ).statusCode,
      ).toBe(403);
    });

    it('descadastrado continua bloqueado, mesmo sem contato no CRM', async () => {
      await prisma.optOut.create({
        data: { accountId: A, phoneE164: '+5511955550004', source: 'x' },
      });
      const conv = (await start(A, '+5511955550004')).json().conversation;
      const open = (await req('GET', `/conversations/${conv.id}`)).json();
      expect(open.reply.allowed).toBe(false);
      expect(open.reply.reason).toContain('descadastramento');
      expect(
        (await req('POST', `/conversations/${conv.id}/messages`, { text: 'oi' })).statusCode,
      ).toBe(409);
    });

    it('bloqueia o envio com a instância desconectada', async () => {
      const conv = (await start(A, '+5511955550005')).json().conversation;
      await prisma.account.update({ where: { id: A }, data: { status: 'DISCONNECTED' } });
      expect((await req('GET', `/conversations/${conv.id}`)).json().reply.allowed).toBe(false);
    });
  });
});
