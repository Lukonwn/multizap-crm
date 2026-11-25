import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, setOperationsPause, type PrismaClient } from '@multizap/database';
import { LocalStorage } from '@multizap/storage';
import { DeliverySender } from '../../gateway/src/inbox/delivery-sender';
import { NotConnectedError, type SessionManager } from '../../gateway/src/session/manager';
import type { OutgoingMessage } from '../../gateway/src/session/types';
import { resetDb } from './helpers';

let prisma: PrismaClient;
let storage: LocalStorage;
beforeAll(() => {
  prisma = createPrisma(process.env.TEST_DATABASE_URL!);
  storage = new LocalStorage(mkdtempSync(join(tmpdir(), 'mz-del-')));
});
afterAll(() => prisma.$disconnect());

let sent: { accountId: string; jid: string; msg: OutgoingMessage }[];
let sendError: Error | null;
let echoId: string | null;
const manager = {
  send: async (accountId: string, jid: string, msg: OutgoingMessage) => {
    if (sendError) throw sendError;
    sent.push({ accountId, jid, msg });
    return { id: echoId ?? `WA-${sent.length}`, timestamp: Math.floor(Date.now() / 1000) };
  },
} as unknown as SessionManager;
const sender = () => new DeliverySender(prisma, storage, manager);

interface W {
  accountId: string;
  convId: string;
  agentId: string;
}
let w: W;

beforeEach(async () => {
  await resetDb(prisma);
  sent = [];
  sendError = null;
  echoId = null;
  const acc = await prisma.account.create({
    data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
  });
  const conv = await prisma.conversation.create({
    data: {
      accountId: acc.id,
      remoteJid: '5511977776666@s.whatsapp.net',
      phoneE164: '+5511977776666',
      title: 'Cliente',
      lastMessageAt: new Date(),
    },
  });
  const persona = await prisma.aiPersona.create({ data: { name: 'Ana' } });
  const agent = await prisma.aiAgent.create({
    data: { name: 'A', personaId: persona.id, model: 'm/x-model' },
  });
  w = { accountId: acc.id, convId: conv.id, agentId: agent.id };
});

async function queued(
  item: {
    kind?: 'FILE' | 'TEXT' | 'LINK';
    mime?: string;
    file?: string;
    text?: string;
    adultOnly?: boolean;
    name?: string;
  },
  status: 'QUEUED' | 'AWAITING_APPROVAL' = 'QUEUED',
) {
  let assetId: string | null = null;
  const kind = item.kind ?? 'FILE';
  if (kind === 'FILE') {
    const key = `assets/${Math.random().toString(16).slice(2)}/original.bin`;
    await storage.put(key, Buffer.from(item.file ?? 'conteudo'));
    const a = await prisma.asset.create({
      data: {
        kind: 'FILE',
        name: item.name ?? 'Arquivo',
        storageKey: key,
        mimeType: item.mime ?? 'application/pdf',
      },
    });
    assetId = a.id;
  }
  const d = await prisma.aiDeliverable.create({
    data: {
      code: `i-${Math.random().toString(16).slice(2, 8)}`,
      name: item.name ?? 'Guia',
      kind,
      assetId,
      text: item.text ?? null,
      adultOnly: item.adultOnly ?? false,
    },
  });
  return prisma.aiDelivery.create({
    data: {
      conversationId: w.convId,
      deliverableId: d.id,
      itemName: d.name,
      itemCode: d.code,
      agentId: w.agentId,
      status,
    },
  });
}
const load = (id: string) => prisma.aiDelivery.findUniqueOrThrow({ where: { id } });

describe('envio de entregas pelo gateway', () => {
  it.each([
    ['image/png', 'image', true],
    ['video/mp4', 'video', false],
    ['audio/mpeg', 'audio', true],
    ['application/pdf', 'document', false],
  ] as const)('arquivo %s vai como %s', async (mime, kind, hasMediaKey) => {
    const d = await queued({ mime, file: 'XYZ', name: 'Meu arquivo', text: 'Segue!' });
    await sender().send(d.id);
    expect(sent).toHaveLength(1);
    const m = sent[0]!.msg;
    expect(sent[0]).toMatchObject({ accountId: w.accountId, jid: '5511977776666@s.whatsapp.net' });
    expect(m.media).toMatchObject({ kind, mimetype: mime, fileName: 'Meu arquivo' });
    expect(m.media!.data.toString()).toBe('XYZ');
    expect(m.text).toBe('Segue!');
    const after = await load(d.id);
    expect(after).toMatchObject({ status: 'SENT', reason: null });
    const msg = await prisma.message.findFirstOrThrow({
      where: { direction: 'OUTBOUND' },
      include: { aiLink: true },
    });
    expect(msg).toMatchObject({ type: kind, body: 'Segue!', status: 'SENT', id: after.messageId });
    expect(!!msg.mediaKey).toBe(hasMediaKey);
    expect(msg.aiLink).toMatchObject({ agentId: w.agentId, source: 'delivery' });
    expect(
      (await prisma.conversation.findUniqueOrThrow({ where: { id: w.convId } })).lastMessagePreview,
    ).toBe('📎 Meu arquivo');
  });

  it('texto e link vão como mensagem de texto', async () => {
    const t = await queued({ kind: 'TEXT', text: 'Seu código de acesso: ABC' });
    const l = await queued({ kind: 'LINK', text: 'https://area.loja.com/acesso' });
    await sender().send(t.id);
    await sender().send(l.id);
    expect(sent.map((s) => s.msg)).toEqual([
      { text: 'Seu código de acesso: ABC' },
      { text: 'https://area.loja.com/acesso' },
    ]);
    expect(
      (await prisma.message.findMany({ where: { direction: 'OUTBOUND' } })).map((m) => m.type),
    ).toEqual(['text', 'text']);
  });

  it('só envia entrega liberada (na fila), e só uma vez', async () => {
    const waiting = await queued({}, 'AWAITING_APPROVAL');
    await sender().send(waiting.id);
    expect(sent).toHaveLength(0);
    expect((await load(waiting.id)).status).toBe('AWAITING_APPROVAL');

    const d = await queued({});
    await Promise.all([sender().send(d.id), sender().send(d.id)]);
    await sender().send(d.id);
    expect(sent).toHaveLength(1);
    expect(await prisma.message.count({ where: { direction: 'OUTBOUND' } })).toBe(1);
  });

  it('conversa travada por sinal de menor: bloqueia na hora do envio e avisa', async () => {
    const d = await queued({});
    await prisma.aiConversationState.create({
      data: { conversationId: w.convId, paused: true, pausedBy: 'minor', pausedReason: 'x' },
    });
    await sender().send(d.id);
    expect(sent).toHaveLength(0);
    expect(await load(d.id)).toMatchObject({ status: 'BLOCKED' });
    expect((await load(d.id)).reason).toMatch(/menor de idade/);
    expect((await prisma.systemNotification.findFirstOrThrow()).title).toBe('Entrega bloqueada');
  });

  it('item adulto: reconfere o portão de 18 anos na hora do envio', async () => {
    const d = await queued({ adultOnly: true });
    await sender().send(d.id);
    expect((await load(d.id)).status).toBe('BLOCKED');

    await prisma.aiAgent.update({ where: { id: w.agentId }, data: { ageGate: true } });
    await prisma.aiConversationState.create({
      data: { conversationId: w.convId, ageConfirmedAt: new Date() },
    });
    const ok = await queued({ adultOnly: true });
    await sender().send(ok.id);
    expect((await load(ok.id)).status).toBe('SENT');
    expect(sent).toHaveLength(1);
  });

  it('descadastrado não recebe (até escrever de novo)', async () => {
    const d = await queued({});
    await prisma.optOut.create({
      data: {
        accountId: w.accountId,
        phoneE164: '+5511977776666',
        source: 'keyword',
        createdAt: new Date(),
      },
    });
    await sender().send(d.id);
    expect((await load(d.id)).status).toBe('BLOCKED');
    expect(sent).toHaveLength(0);
  });

  it('operações pausadas: não envia e volta para a fila, sem avisar como falha', async () => {
    const d = await queued({});
    await setOperationsPause(prisma, true, { reason: 'teste' });
    await sender().send(d.id);
    expect(await load(d.id)).toMatchObject({ status: 'QUEUED' });
    expect(sent).toHaveLength(0);
    expect(await prisma.systemNotification.count()).toBe(0);
    await setOperationsPause(prisma, false);
    await sender().send(d.id);
    expect((await load(d.id)).status).toBe('SENT');
  });

  it('instância desconectada ou falha no envio: falha com motivo claro e aviso; nada é gravado como enviado', async () => {
    const a = await queued({});
    await prisma.account.update({ where: { id: w.accountId }, data: { status: 'DISCONNECTED' } });
    await sender().send(a.id);
    expect(await load(a.id)).toMatchObject({
      status: 'FAILED',
      reason: 'A instância não está conectada.',
    });

    await prisma.account.update({ where: { id: w.accountId }, data: { status: 'CONNECTED' } });
    const b = await queued({});
    sendError = new NotConnectedError();
    await sender().send(b.id);
    expect((await load(b.id)).reason).toBe('A instância não está conectada.');
    sendError = new Error('socket fechou');
    const c = await queued({});
    await sender().send(c.id);
    expect((await load(c.id)).reason).toMatch(/Falha no envio/);
    expect(await prisma.message.count({ where: { direction: 'OUTBOUND' } })).toBe(0);
    expect(await prisma.systemNotification.count()).toBe(3);
  });

  it('arquivo que sumiu do bucket: falha clara', async () => {
    const d = await queued({});
    const item = await prisma.aiDeliverable.findFirstOrThrow({ include: { asset: true } });
    await storage.delete(item.asset!.storageKey!);
    await sender().send(d.id);
    expect((await load(d.id)).status).toBe('FAILED');
  });

  it('se a própria sessão já registrou o eco, atualiza a mensagem (sem duplicar) e mantém a marca da IA', async () => {
    echoId = 'WA-ECHO';
    await prisma.message.create({
      data: {
        accountId: w.accountId,
        conversationId: w.convId,
        providerMessageId: 'WA-ECHO',
        direction: 'OUTBOUND',
        type: 'other',
        body: '(mídia)',
        status: 'SENT',
        sentAt: new Date(),
      },
    });
    const d = await queued({ mime: 'video/mp4', name: 'Vídeo' });
    await sender().send(d.id);
    const all = await prisma.message.findMany({
      where: { direction: 'OUTBOUND' },
      include: { aiLink: true },
    });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ type: 'video', body: 'Vídeo' });
    expect(all[0]!.aiLink).toMatchObject({ source: 'delivery' });
  });
});
