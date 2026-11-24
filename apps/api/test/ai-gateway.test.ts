import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, type PrismaClient } from '@multizap/database';
import { InboxIngest } from '../../gateway/src/inbox/ingest';
import { ReplySender } from '../../gateway/src/inbox/reply-sender';
import { handleCommand } from '../../gateway/src/commands';
import { resetDb } from './helpers';

let prisma: PrismaClient;
beforeAll(() => {
  prisma = createPrisma(process.env.TEST_DATABASE_URL!);
});
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDb(prisma));

const msg = (id: string, over: object = {}) => ({
  id,
  chatJid: '5511987654321@s.whatsapp.net',
  phoneE164: '+5511987654321',
  fromMe: false,
  timestamp: new Date(),
  type: 'text' as const,
  text: 'Oi',
  pushName: 'Joana',
  ...over,
});

describe('MultiZap AI no gateway', () => {
  it('avisa a IA só de mensagem nova do contato (ao vivo), nunca de histórico nem de mensagem própria', async () => {
    const acc = await prisma.account.create({
      data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    });
    const seen: string[] = [];
    const ingest = new InboxIngest(
      prisma,
      null,
      () => undefined,
      async (m) => {
        seen.push(m.messageId);
      },
    );
    await ingest.ingest(acc.id, [msg('h1')], true); // histórico
    await ingest.ingest(acc.id, [msg('own', { fromMe: true })], false); // minha mensagem
    await ingest.ingest(acc.id, [msg('live1')], false);
    await ingest.ingest(acc.id, [msg('live1')], false); // repetida: já gravada
    expect(seen).toHaveLength(1);
    const stored = await prisma.message.findFirstOrThrow({ where: { providerMessageId: 'live1' } });
    expect(seen[0]).toBe(stored.id);
  });

  it('uma falha no aviso à IA não impede a gravação da mensagem', async () => {
    const acc = await prisma.account.create({
      data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    });
    const ingest = new InboxIngest(
      prisma,
      null,
      () => undefined,
      async () => {
        throw new Error('redis fora do ar');
      },
    );
    await ingest.ingest(acc.id, [msg('live1')], false);
    expect(await prisma.message.count()).toBe(1);
    expect(await prisma.conversation.count()).toBe(1);
  });

  it('a marca "enviada pela IA" sobrevive quando o eco da própria sessão chega antes do envio terminar', async () => {
    const acc = await prisma.account.create({
      data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
    });
    const conv = await prisma.conversation.create({
      data: {
        accountId: acc.id,
        remoteJid: '5511987654321@s.whatsapp.net',
        lastMessageAt: new Date(),
      },
    });
    const agent = await prisma.aiAgent.create({
      data: {
        name: 'A',
        model: 'm/x-model',
        persona: { create: { name: 'P' } },
      },
    });
    const pending = await prisma.message.create({
      data: {
        accountId: acc.id,
        conversationId: conv.id,
        providerMessageId: 'pending:abc',
        direction: 'OUTBOUND',
        type: 'text',
        body: 'Resposta da IA',
        status: 'PENDING',
        sentAt: new Date(),
        aiLink: { create: { agentId: agent.id, source: 'auto' } },
      },
    });
    // O eco da própria mensagem já foi registrado pela sessão com o id real do WhatsApp.
    await prisma.message.create({
      data: {
        accountId: acc.id,
        conversationId: conv.id,
        providerMessageId: 'WA-REAL-1',
        direction: 'OUTBOUND',
        type: 'text',
        body: 'Resposta da IA',
        status: 'SENT',
        sentAt: new Date(),
      },
    });
    const manager = {
      send: async () => ({ id: 'WA-REAL-1', timestamp: Math.floor(Date.now() / 1000) }),
    } as never;
    await new ReplySender(prisma, manager).send(pending.id);
    const outs = await prisma.message.findMany({
      where: { direction: 'OUTBOUND' },
      include: { aiLink: true },
    });
    expect(outs).toHaveLength(1);
    expect(outs[0]!.providerMessageId).toBe('WA-REAL-1');
    expect(outs[0]!.aiLink).toMatchObject({ agentId: agent.id, source: 'auto' });
  });

  it('o comando de presença chega à sessão ("digitando") e é ignorado sem sessão', async () => {
    const calls: unknown[][] = [];
    const manager = {
      sendPresence: async (...a: unknown[]) => void calls.push(a),
    } as never;
    await handleCommand(manager, {} as never, {
      type: 'send-presence',
      accountId: 'a1',
      jid: '5511@s.whatsapp.net',
      state: 'composing',
    });
    expect(calls).toEqual([['a1', '5511@s.whatsapp.net', 'composing']]);
  });
});
