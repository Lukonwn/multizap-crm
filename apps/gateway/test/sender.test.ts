import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockManager } from '../src/session/lock';
import { SessionManager } from '../src/session/manager';
import { CampaignSender } from '../src/campaigns/sender';
import { FakeFactory, resetDb, testPrisma, testRedis } from './helpers';

const prisma = testPrisma();
const redis = testRedis();
let factory: FakeFactory;
let manager: SessionManager;
let sender: CampaignSender;
let accountId: string;

beforeEach(async () => {
  await resetDb(prisma);
  factory = new FakeFactory();
  manager = new SessionManager(
    prisma,
    redis,
    factory,
    { clear: async () => undefined },
    new LockManager(redis, `t-${Math.random()}`),
    { backoffMs: [20] },
  );
  sender = new CampaignSender(prisma, null, manager);
  const a = await prisma.account.create({
    data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
  });
  accountId = a.id;
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
afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

async function recipient(
  opts: {
    consent?: 'GRANTED' | 'PENDING';
    optedOut?: boolean;
    campaignStatus?: 'READY' | 'PAUSED';
    confirmed?: boolean;
  } = {},
) {
  const contact = await prisma.contact.create({
    data: {
      accountId,
      name: 'Ana Souza',
      phoneE164: `+55119${Math.floor(10000000 + Math.random() * 89999999)}`,
      consentStatus: opts.consent ?? 'GRANTED',
      optedOutAt: opts.optedOut ? new Date() : null,
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Promo',
      status: opts.campaignStatus ?? 'READY',
      body: 'Olá, {{primeiro_nome}}! Oferta especial.',
      linkUrl: 'https://loja.example.com',
    },
  });
  const child = await prisma.campaignAccount.create({
    data: { campaignId: campaign.id, accountId, status: opts.campaignStatus ?? 'READY' },
  });
  return prisma.campaignRecipient.create({
    data: {
      campaignAccountId: child.id,
      accountId,
      contactId: contact.id,
      phoneE164: contact.phoneE164,
      confirmedAt: opts.confirmed === false ? null : new Date(),
    },
  });
}

describe('envio assistido (gateway)', () => {
  it('envia a mensagem personalizada, registra conversa, mensagem e evento, e conclui a campanha', async () => {
    const r = await recipient();
    await sender.send(r.id);
    const sent = factory.last(accountId).conn.sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.jid).toBe(`${r.phoneE164.slice(1)}@s.whatsapp.net`);
    expect(sent[0]!.text).toBe('Olá, Ana! Oferta especial.\n\nhttps://loja.example.com');

    const after = await prisma.campaignRecipient.findUniqueOrThrow({
      where: { id: r.id },
      include: { message: true, campaignAccount: { include: { campaign: true } } },
    });
    expect(after.status).toBe('SENT');
    expect(after.message).toMatchObject({
      direction: 'OUTBOUND',
      status: 'SENT',
      providerMessageId: 'WAMSG1',
    });
    expect(await prisma.conversation.count({ where: { accountId } })).toBe(1);
    expect(await prisma.messageEvent.count()).toBe(1);
    expect(after.campaignAccount.status).toBe('COMPLETED');
    expect(after.campaignAccount.campaign.status).toBe('COMPLETED');
  });

  it('atualiza com as confirmações reais do WhatsApp (entregue → lida), sem retroceder', async () => {
    const r = await recipient();
    await sender.send(r.id);
    const conn = factory.last(accountId);
    conn.emit({ type: 'message-status', id: 'WAMSG1', status: 'DELIVERED' });
    await vi.waitFor(async () =>
      expect(
        (await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).status,
      ).toBe('DELIVERED'),
    );
    conn.emit({ type: 'message-status', id: 'WAMSG1', status: 'READ' });
    await vi.waitFor(async () =>
      expect(
        (await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).status,
      ).toBe('READ'),
    );
    conn.emit({ type: 'message-status', id: 'WAMSG1', status: 'DELIVERED' });
    await new Promise((res) => setTimeout(res, 80));
    expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      'READ',
    );
    expect(await prisma.messageEvent.count()).toBe(3);
  });

  it('nunca envia sem confirmação do administrador', async () => {
    const r = await recipient({ confirmed: false });
    await sender.send(r.id);
    expect(factory.last(accountId).conn.sent).toHaveLength(0);
  });

  it('não envia para descadastrado ou sem consentimento (revalidação no envio)', async () => {
    const out = await recipient({ optedOut: true });
    const pend = await recipient({ consent: 'PENDING' });
    await sender.send(out.id);
    await sender.send(pend.id);
    expect(factory.last(accountId).conn.sent).toHaveLength(0);
    expect(
      (await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: out.id } })).status,
    ).toBe('SKIPPED');
    expect(
      (await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: pend.id } })).status,
    ).toBe('SKIPPED');
  });

  it('respeita campanha pausada e pausa global (devolve à fila sem enviar)', async () => {
    const r = await recipient({ campaignStatus: 'PAUSED' });
    await sender.send(r.id);
    const after = await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } });
    expect(after).toMatchObject({ status: 'PENDING', confirmedAt: null });

    const r2 = await recipient();
    await prisma.systemSetting.create({ data: { key: 'operations_paused', value: true } });
    await sender.send(r2.id);
    expect(
      (await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: r2.id } })).confirmedAt,
    ).toBeNull();
    expect(factory.last(accountId).conn.sent).toHaveLength(0);
  });

  it('registra falha quando a instância está desconectada ou o envio falha', async () => {
    const r = await recipient();
    factory.last(accountId).conn.sendError = new Error('timeout');
    await sender.send(r.id);
    expect(await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject(
      { status: 'FAILED', error: 'Falha no envio: timeout' },
    );

    await manager.stop(accountId);
    const r2 = await recipient();
    await sender.send(r2.id);
    expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: r2.id } })).error).toBe(
      'Instância desconectada no momento do envio.',
    );
  });

  it('marca para conferência envios interrompidos por reinício', async () => {
    const r = await recipient();
    await prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'SENDING' } });
    expect(await sender.recoverInterrupted(0)).toBe(1);
    expect((await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      'FAILED',
    );
  });

  it('não envia duas vezes o mesmo destinatário', async () => {
    const r = await recipient();
    await Promise.all([sender.send(r.id), sender.send(r.id)]);
    await sender.send(r.id);
    expect(factory.last(accountId).conn.sent).toHaveLength(1);
  });
});
