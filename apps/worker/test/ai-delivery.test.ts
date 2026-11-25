import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  confirmPayment,
  createPrisma,
  newPaymentReference,
  requestDelivery,
  type PrismaClient,
} from '@multizap/database';

const prisma: PrismaClient = createPrisma(process.env.TEST_DATABASE_URL!);
afterAll(() => prisma.$disconnect());

const truncateAll = async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
};

interface World {
  convId: string;
  agentId: string;
  asset: { id: string };
}
let w: World;

beforeEach(async () => {
  await truncateAll();
  const acc = await prisma.account.create({
    data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
  });
  const conv = await prisma.conversation.create({
    data: {
      accountId: acc.id,
      remoteJid: '5511977776666@s.whatsapp.net',
      lastMessageAt: new Date(),
    },
  });
  const persona = await prisma.aiPersona.create({ data: { name: 'Ana' } });
  const agent = await prisma.aiAgent.create({
    data: { name: 'A', personaId: persona.id, model: 'm/x-model' },
  });
  const asset = await prisma.asset.create({
    data: {
      kind: 'FILE',
      name: 'Guia',
      storageKey: 'assets/x/original.pdf',
      mimeType: 'application/pdf',
    },
  });
  w = { convId: conv.id, agentId: agent.id, asset };
});

const item = (over: Record<string, unknown> = {}) =>
  prisma.aiDeliverable.create({
    data: {
      code: `item-${randomBytes(3).toString('hex')}`,
      name: 'Guia de cafés',
      kind: 'FILE',
      assetId: w.asset.id,
      approval: 'MANUAL',
      ...over,
    } as never,
  });
const ask = (deliverableId: string, inboundMessageId?: string) =>
  requestDelivery(prisma, {
    conversationId: w.convId,
    deliverableId,
    agentId: w.agentId,
    inboundMessageId,
  });
const msg = async (n: string) =>
  (
    await prisma.message.create({
      data: {
        accountId: (await prisma.conversation.findUniqueOrThrow({ where: { id: w.convId } }))
          .accountId,
        conversationId: w.convId,
        providerMessageId: n,
        direction: 'INBOUND',
        type: 'text',
        body: 'quero',
        status: 'RECEIVED',
        sentAt: new Date(),
      },
    })
  ).id;

describe('entregas: regras do pedido', () => {
  it('item gratuito: aprovação manual espera o administrador; automática vai para a fila', async () => {
    const manual = await ask((await item()).id);
    expect(manual).toMatchObject({ created: true, dispatch: false, payment: null });
    expect(manual.delivery.status).toBe('AWAITING_APPROVAL');

    const auto = await ask((await item({ approval: 'AUTO' })).id);
    expect(auto.delivery.status).toBe('QUEUED');
    expect(auto.dispatch).toBe(true);
  });

  it('item pago: nasce aguardando pagamento, com código de pagamento, e NADA é liberado para envio', async () => {
    const r = await ask(
      (await item({ requiresPayment: true, priceCents: 4990, approval: 'AUTO' })).id,
    );
    expect(r.delivery.status).toBe('AWAITING_PAYMENT');
    expect(r.dispatch).toBe(false);
    expect(r.payment).toMatchObject({ status: 'PENDING', amountCents: 4990 });
    expect(r.payment!.reference).toMatch(/^MZ-[A-HJ-NP-Z2-9]{6}$/);
  });

  it('é idempotente: mesma mensagem, ou item já em andamento ou entregue, não cria outro pedido', async () => {
    const it = await item({ requiresPayment: true, priceCents: 1000 });
    const m = await msg('in-1');
    const a = await ask(it.id, m);
    const b = await ask(it.id, m);
    expect(b).toMatchObject({ created: false });
    expect(b.delivery.id).toBe(a.delivery.id);
    const c = await ask(it.id, await msg('in-2')); // outra mensagem, pedido ainda aberto
    expect(c).toMatchObject({ created: false });
    expect(c.payment!.reference).toBe(a.payment!.reference);
    expect(await prisma.aiDelivery.count()).toBe(1);
    expect(await prisma.aiPayment.count()).toBe(1);
  });

  it('bloqueios: item desligado, arquivo sumiu da biblioteca, item pago sem preço', async () => {
    expect((await ask((await item({ enabled: false })).id)).delivery).toMatchObject({
      status: 'BLOCKED',
      reason: 'Item desligado.',
    });
    const gone = await item({ assetId: null });
    expect((await ask(gone.id)).delivery.reason).toMatch(/biblioteca/);
    expect(
      (await ask((await item({ requiresPayment: true, priceCents: null })).id)).delivery.reason,
    ).toMatch(/sem preço/);
    expect(await prisma.aiPayment.count()).toBe(0);
  });

  it('conversa travada por sinal de menor nunca recebe entrega', async () => {
    await prisma.aiConversationState.create({
      data: { conversationId: w.convId, paused: true, pausedBy: 'minor', pausedReason: 'x' },
    });
    const r = await ask((await item({ approval: 'AUTO' })).id);
    expect(r.delivery).toMatchObject({ status: 'BLOCKED' });
    expect(r.delivery.reason).toMatch(/menor de idade/);
    expect(r.dispatch).toBe(false);
  });

  it('item adulto exige a pergunta de 18 anos ligada no agente E confirmada na conversa', async () => {
    const adult = await item({ adultOnly: true, approval: 'AUTO' });
    // sem portão ligado
    expect((await ask(adult.id)).delivery.status).toBe('BLOCKED');
    // portão ligado, mas contato ainda não confirmou
    await prisma.aiAgent.update({ where: { id: w.agentId }, data: { ageGate: true } });
    const b = await ask((await item({ adultOnly: true, approval: 'AUTO' })).id);
    expect(b.delivery.status).toBe('BLOCKED');
    expect(b.delivery.reason).toMatch(/18 anos/);
    // portão ligado e confirmado
    await prisma.aiConversationState.create({
      data: { conversationId: w.convId, ageConfirmedAt: new Date() },
    });
    const c = await ask((await item({ adultOnly: true, approval: 'AUTO' })).id);
    expect(c.delivery.status).toBe('QUEUED');
    // portão desligado depois: volta a bloquear
    await prisma.aiAgent.update({ where: { id: w.agentId }, data: { ageGate: false } });
    expect(
      (await ask((await item({ adultOnly: true, approval: 'AUTO' })).id)).delivery.status,
    ).toBe('BLOCKED');
  });

  it('códigos de pagamento não repetem e não usam caracteres ambíguos', () => {
    const set = new Set(Array.from({ length: 500 }, () => newPaymentReference()));
    expect(set.size).toBe(500);
    for (const r of set) expect(r).not.toMatch(/[01OI]/);
  });
});

describe('pagamento: confirmação', () => {
  const paid = async (approval: 'AUTO' | 'MANUAL') =>
    ask((await item({ requiresPayment: true, priceCents: 4990, approval })).id);

  it('confirmar libera a entrega: automática vai para a fila; manual espera o administrador', async () => {
    const a = await paid('AUTO');
    const ra = await confirmPayment(prisma, {
      reference: a.payment!.reference,
      by: 'webhook',
      externalId: 'ext-1',
    });
    expect(ra).toMatchObject({ ok: true, dispatch: true });
    if (ra.ok) {
      expect(ra.delivery.status).toBe('QUEUED');
      expect(ra.payment).toMatchObject({
        status: 'CONFIRMED',
        confirmedBy: 'webhook',
        externalId: 'ext-1',
      });
    }
    const m = await paid('MANUAL');
    const rm = await confirmPayment(prisma, {
      paymentId: m.payment!.id,
      by: 'admin',
      note: 'Conferi no banco',
    });
    expect(rm).toMatchObject({ ok: true, dispatch: false });
    if (rm.ok) expect(rm.delivery.status).toBe('AWAITING_APPROVAL');
  });

  it('confirmação repetida não libera duas vezes', async () => {
    const a = await paid('AUTO');
    expect(
      (await confirmPayment(prisma, { reference: a.payment!.reference, by: 'admin' })).ok,
    ).toBe(true);
    expect(await confirmPayment(prisma, { reference: a.payment!.reference, by: 'admin' })).toEqual({
      ok: false,
      reason: 'ALREADY_CONFIRMED',
    });
  });

  it('referência inexistente e pagamento cancelado não confirmam', async () => {
    expect(await confirmPayment(prisma, { reference: 'MZ-NAOEXI', by: 'webhook' })).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
    const a = await paid('AUTO');
    await prisma.aiPayment.update({ where: { id: a.payment!.id }, data: { status: 'CANCELED' } });
    expect(await confirmPayment(prisma, { paymentId: a.payment!.id, by: 'admin' })).toEqual({
      ok: false,
      reason: 'CANCELED',
    });
    expect(
      (await prisma.aiDelivery.findUniqueOrThrow({ where: { id: a.delivery.id } })).status,
    ).toBe('AWAITING_PAYMENT');
  });

  it('o mesmo identificador externo não confirma dois pagamentos', async () => {
    const a = await paid('AUTO');
    const b = await paid('AUTO');
    await confirmPayment(prisma, {
      reference: a.payment!.reference,
      by: 'webhook',
      externalId: 'pix-123',
    });
    await expect(
      confirmPayment(prisma, {
        reference: b.payment!.reference,
        by: 'webhook',
        externalId: 'pix-123',
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(
      (await prisma.aiPayment.findUniqueOrThrow({ where: { id: b.payment!.id } })).status,
    ).toBe('PENDING');
  });
});
