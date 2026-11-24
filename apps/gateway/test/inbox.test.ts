import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WAMessage } from 'baileys';
import { isOptOutMessage } from '@multizap/shared';
import { normalizeMessage } from '../src/whatsapp/normalize';
import { InboxIngest } from '../src/inbox/ingest';
import { ReplySender } from '../src/inbox/reply-sender';
import { LockManager } from '../src/session/lock';
import { SessionManager } from '../src/session/manager';
import type { IncomingMessage } from '../src/session/types';
import { FakeFactory, resetDb, testPrisma, testRedis } from './helpers';

const prisma = testPrisma();
const redis = testRedis();
const ingest = new InboxIngest(prisma, null);
let accountId: string;

const wa = (over: Partial<WAMessage> & { key: WAMessage['key'] }): WAMessage =>
  ({ messageTimestamp: 1_790_000_000, ...over }) as WAMessage;
const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: `M${Math.random().toString(36).slice(2)}`,
  chatJid: '5511987654321@s.whatsapp.net',
  phoneE164: '+5511987654321',
  fromMe: false,
  timestamp: new Date(),
  type: 'text',
  text: 'Olá!',
  pushName: 'Joana Lima',
  ...over,
});

beforeEach(async () => {
  await resetDb(prisma);
  accountId = (
    await prisma.account.create({
      data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    })
  ).id;
});
afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

describe('normalização de mensagens do WhatsApp', () => {
  it('texto simples e texto estendido', () => {
    expect(
      normalizeMessage(
        wa({
          key: { id: 'A', remoteJid: '5511987654321@s.whatsapp.net' },
          message: { conversation: 'oi' },
          pushName: 'Joana',
        }),
      ),
    ).toMatchObject({
      id: 'A',
      type: 'text',
      text: 'oi',
      phoneE164: '+5511987654321',
      fromMe: false,
      pushName: 'Joana',
      chatJid: '5511987654321@s.whatsapp.net',
    });
    expect(
      normalizeMessage(
        wa({
          key: { id: 'B', remoteJid: '5511987654321@s.whatsapp.net', fromMe: true },
          message: { extendedTextMessage: { text: 'link https://x.com' } },
        }),
      ),
    ).toMatchObject({ type: 'text', fromMe: true });
  });

  it('endereçamento por LID usa o telefone alternativo', () => {
    const n = normalizeMessage(
      wa({
        key: {
          id: 'C',
          remoteJid: '123456789@lid',
          remoteJidAlt: '5511987654321@s.whatsapp.net',
        } as WAMessage['key'],
        message: { conversation: 'oi' },
      }),
    );
    expect(n).toMatchObject({
      chatJid: '5511987654321@s.whatsapp.net',
      phoneE164: '+5511987654321',
    });
    const noAlt = normalizeMessage(
      wa({ key: { id: 'D', remoteJid: '123456789@lid' }, message: { conversation: 'oi' } }),
    );
    expect(noAlt).toMatchObject({ chatJid: '123456789@lid', phoneE164: null });
  });

  it('imagem com legenda e mensagens efêmeras (desembrulhadas)', () => {
    expect(
      normalizeMessage(
        wa({
          key: { id: 'E', remoteJid: '5511987654321@s.whatsapp.net' },
          message: { imageMessage: { caption: 'foto', mimetype: 'image/jpeg' } },
        }),
      ),
    ).toMatchObject({ type: 'image', text: 'foto' });
    expect(
      normalizeMessage(
        wa({
          key: { id: 'F', remoteJid: '5511987654321@s.whatsapp.net' },
          message: { ephemeralMessage: { message: { conversation: 'some' } } },
        }),
      ),
    ).toMatchObject({ type: 'text', text: 'some' });
  });

  it('ignora grupos, status, reações e mensagens de protocolo', () => {
    expect(
      normalizeMessage(
        wa({ key: { id: 'G', remoteJid: '120363@g.us' }, message: { conversation: 'grupo' } }),
      ),
    ).toBeNull();
    expect(
      normalizeMessage(
        wa({
          key: { id: 'H', remoteJid: 'status@broadcast' },
          message: { conversation: 'status' },
        }),
      ),
    ).toBeNull();
    expect(
      normalizeMessage(
        wa({
          key: { id: 'I', remoteJid: '5511987654321@s.whatsapp.net' },
          message: { reactionMessage: { text: '👍' } },
        }),
      ),
    ).toBeNull();
    expect(
      normalizeMessage(
        wa({
          key: { id: 'J', remoteJid: '5511987654321@s.whatsapp.net' },
          message: { protocolMessage: { type: 0 } },
        }),
      ),
    ).toBeNull();
  });
});

describe('registro de mensagens recebidas', () => {
  it('nova mensagem: cria contato (origem mensagem recebida), conversa pendente e não lida', async () => {
    await ingest.ingest(accountId, [msg({ id: 'X1', text: 'Quero saber o preço' })], false);
    const conv = await prisma.conversation.findFirstOrThrow({
      include: { contact: true, messages: true },
    });
    expect(conv).toMatchObject({
      status: 'PENDING',
      unreadCount: 1,
      title: 'Joana Lima',
      lastMessagePreview: 'Quero saber o preço',
    });
    expect(conv.contact).toMatchObject({
      origin: 'INBOUND',
      consentStatus: 'PENDING',
      name: 'Joana Lima',
    });
    expect(conv.messages[0]).toMatchObject({
      direction: 'INBOUND',
      status: 'RECEIVED',
      body: 'Quero saber o preço',
    });
  });

  it('não duplica mensagens e vincula a contato existente', async () => {
    await prisma.contact.create({
      data: { accountId, phoneE164: '+5511987654321', name: 'Cliente Antiga' },
    });
    const m = msg({ id: 'X2' });
    await ingest.ingest(accountId, [m, m], false);
    await ingest.ingest(accountId, [m], false);
    expect(await prisma.message.count()).toBe(1);
    expect(await prisma.contact.count()).toBe(1);
    expect((await prisma.conversation.findFirstOrThrow()).unreadCount).toBe(1);
  });

  it('mensagem enviada pelo celular marca a conversa como respondida', async () => {
    await ingest.ingest(accountId, [msg({ id: 'X3' })], false);
    await ingest.ingest(
      accountId,
      [msg({ id: 'X4', fromMe: true, text: 'Respondi pelo celular' })],
      false,
    );
    const conv = await prisma.conversation.findFirstOrThrow();
    expect(conv.status).toBe('ANSWERED');
  });

  it('histórico: não conta como não lido, não cria contatos e respeita a janela de 30 dias', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await ingest.ingest(
      accountId,
      [
        msg({ id: 'H1', timestamp: new Date(Date.now() - 3600_000) }),
        msg({ id: 'H2', timestamp: old }),
      ],
      true,
    );
    const conv = await prisma.conversation.findFirstOrThrow();
    expect(conv).toMatchObject({ unreadCount: 0, status: 'OPEN' });
    expect(await prisma.message.count()).toBe(1);
    expect(await prisma.contact.count()).toBe(0);
  });

  it('palavra "SAIR" descadastra o contato e notifica', async () => {
    expect(isOptOutMessage(' Sair! ')).toBe(true);
    expect(isOptOutMessage('quero sair do grupo')).toBe(false);
    await prisma.contact.create({
      data: { accountId, phoneE164: '+5511987654321', name: 'Joana', consentStatus: 'GRANTED' },
    });
    await ingest.ingest(accountId, [msg({ id: 'S1', text: 'SAIR' })], false);
    const c = await prisma.contact.findFirstOrThrow();
    expect(c.consentStatus).toBe('REVOKED');
    expect(c.optedOutAt).not.toBeNull();
    expect(await prisma.optOut.count({ where: { accountId, source: 'whatsapp_keyword' } })).toBe(1);
    expect(
      await prisma.systemNotification.count({ where: { title: 'Contato pediu descadastramento' } }),
    ).toBe(1);
    // histórico com "SAIR" não descadastra ninguém
    await prisma.contact.create({
      data: { accountId, phoneE164: '+5511900000001', consentStatus: 'GRANTED' },
    });
    await ingest.ingest(
      accountId,
      [
        msg({
          id: 'S2',
          text: 'sair',
          chatJid: '5511900000001@s.whatsapp.net',
          phoneE164: '+5511900000001',
        }),
      ],
      true,
    );
    expect(
      (await prisma.contact.findFirstOrThrow({ where: { phoneE164: '+5511900000001' } }))
        .optedOutAt,
    ).toBeNull();
  });
});

describe('respostas pela Central de Mensagens', () => {
  let factory: FakeFactory;
  let manager: SessionManager;
  let replies: ReplySender;

  beforeEach(async () => {
    factory = new FakeFactory();
    manager = new SessionManager(
      prisma,
      redis,
      factory,
      { clear: async () => undefined },
      new LockManager(redis, `r-${Math.random()}`),
      {
        onMessages: (a, m, h) => ingest.ingest(a, m, h),
      },
    );
    replies = new ReplySender(prisma, manager);
    await prisma.integration.create({
      data: {
        accountId,
        provider: 'whatsapp-web',
        pairedAt: new Date(),
        credentialsEnc: new Uint8Array([1]),
      },
    });
    await manager.reconcile();
    factory.last(accountId).emit({ type: 'open', jid: '5511900000000@s.whatsapp.net' });
    await vi.waitFor(() => expect(manager.isOpen(accountId)).toBe(true));
  });
  afterEach(() => manager.shutdown());

  async function pendingReply(text: string) {
    await ingest.ingest(accountId, [msg({ id: `IN${Math.random()}` })], false);
    const conv = await prisma.conversation.findFirstOrThrow();
    return prisma.message.create({
      data: {
        accountId,
        conversationId: conv.id,
        providerMessageId: `pending:${crypto.randomUUID()}`,
        direction: 'OUTBOUND',
        status: 'PENDING',
        body: text,
        sentAt: new Date(),
      },
    });
  }

  it('envia, registra o id do WhatsApp e marca a conversa como respondida', async () => {
    const p = await pendingReply('Olá Joana, o preço é R$ 99.');
    await replies.send(p.id);
    const after = await prisma.message.findUniqueOrThrow({
      where: { id: p.id },
      include: { conversation: true },
    });
    expect(after).toMatchObject({ status: 'SENT', providerMessageId: 'WAMSG1' });
    expect(after.conversation.status).toBe('ANSWERED');
    expect(factory.last(accountId).conn.sent[0]).toMatchObject({
      jid: '5511987654321@s.whatsapp.net',
      text: 'Olá Joana, o preço é R$ 99.',
    });
  });

  it('eco da própria sessão antes do registro não duplica a mensagem', async () => {
    const p = await pendingReply('Resposta');
    // simula o eco (messages.upsert fromMe) já registrado com o id real
    await ingest.ingest(accountId, [msg({ id: 'WAMSG1', fromMe: true, text: 'Resposta' })], false);
    await replies.send(p.id);
    const outbound = await prisma.message.findMany({ where: { direction: 'OUTBOUND' } });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ providerMessageId: 'WAMSG1', status: 'SENT' });
  });

  it('falha de envio fica registrada e não é reenviada', async () => {
    const p = await pendingReply('x');
    factory.last(accountId).conn.sendError = new Error('timeout');
    await replies.send(p.id);
    await replies.send(p.id);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('FAILED');
    expect(factory.last(accountId).conn.sent).toHaveLength(0);
  });

  it('eventos "messages" da sessão chegam à Central', async () => {
    factory.last(accountId).emit({
      type: 'messages',
      messages: [msg({ id: 'LIVE1', text: 'ao vivo' })],
      historical: false,
    });
    await vi.waitFor(async () =>
      expect(await prisma.message.count({ where: { providerMessageId: 'LIVE1' } })).toBe(1),
    );
  });
});
