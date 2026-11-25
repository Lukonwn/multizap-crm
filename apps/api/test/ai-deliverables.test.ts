import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { requestDelivery, type PrismaClient } from '@multizap/database';
import { HEARTBEAT_KEYS } from '@multizap/shared';
import type { GatewayClient } from '../src/lib/gateway';
import { authed, createAdmin, login, resetDb, setupTestApp, type Session } from './helpers';

let chatContent = 'Olá!';
const fakeFetch = (async (url: string) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/chat/completions'))
    return new Response(
      JSON.stringify({
        model: 'openai/gpt-4o-mini',
        choices: [{ message: { content: chatContent }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
      }),
      { status: 200 },
    );
  return new Response(
    JSON.stringify({ data: path.endsWith('/models') ? [] : { label: 'x', usage: 0 } }),
    {
      status: 200,
    },
  );
}) as unknown as typeof fetch;

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let gateway: GatewayClient;
let s: Session;

beforeAll(async () => {
  ({ app, prisma, redis, gateway } = await setupTestApp({}, { aiFetch: fakeFetch }));
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
  chatContent = 'Olá!';
  await createAdmin(prisma);
  s = await login(app);
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: authed(s, false) });
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s), ...(payload && { payload }) });
const jobs = async () =>
  (await gateway.rawQueue.getJobs(['waiting', 'delayed', 'active'])).map((j) => j.data);

async function world() {
  const account = await prisma.account.create({
    data: { name: 'Loja', connectionType: 'WHATSAPP_WEB', status: 'CONNECTED' },
  });
  const conv = await prisma.conversation.create({
    data: {
      accountId: account.id,
      remoteJid: '5511977776666@s.whatsapp.net',
      phoneE164: '+5511977776666',
      title: 'Cliente',
      lastMessageAt: new Date(),
    },
  });
  const inbound = await prisma.message.create({
    data: {
      accountId: account.id,
      conversationId: conv.id,
      providerMessageId: 'in-1',
      direction: 'INBOUND',
      type: 'text',
      body: 'quero',
      status: 'RECEIVED',
      sentAt: new Date(),
    },
  });
  const persona = (await send('POST', '/ai/personas', { name: 'Ana' })).json().persona;
  const agent = (
    await send('POST', '/ai/agents', {
      name: 'Ag',
      personaId: persona.id,
      model: 'openai/gpt-4o-mini',
    })
  ).json().agent;
  const asset = await prisma.asset.create({
    data: {
      kind: 'FILE',
      name: 'Guia',
      storageKey: 'assets/g/original.pdf',
      mimeType: 'application/pdf',
    },
  });
  return { account, conv, inbound, agent, asset };
}
type W = Awaited<ReturnType<typeof world>>;
const mkItem = async (w: W, over: Record<string, unknown> = {}) =>
  (
    await send('POST', '/ai/deliverables', {
      name: 'Guia de cafés',
      kind: 'FILE',
      assetId: w.asset.id,
      approval: 'MANUAL',
      ...over,
    })
  ).json().deliverable;

describe('catálogo de entregáveis', () => {
  it('exige login', async () => {
    expect((await app.inject({ method: 'GET', url: '/ai/deliverables' })).statusCode).toBe(401);
  });

  it('cria arquivo, texto e link; o código vem do nome e não repete', async () => {
    const w = await world();
    const a = await mkItem(w);
    expect(a).toMatchObject({
      code: 'guia-de-cafes',
      kind: 'FILE',
      assetName: 'Guia',
      assetMime: 'application/pdf',
      unavailable: false,
      approval: 'MANUAL',
      agents: [],
      deliveryCount: 0,
    });
    expect((await mkItem(w)).code).toBe('guia-de-cafes-2');
    const t = (
      await send('POST', '/ai/deliverables', {
        name: 'Código de acesso',
        kind: 'TEXT',
        text: 'Seu código: ABC',
      })
    ).json().deliverable;
    expect(t).toMatchObject({ kind: 'TEXT', assetId: null, text: 'Seu código: ABC' });
    const l = (
      await send('POST', '/ai/deliverables', {
        name: 'Área de membros',
        kind: 'LINK',
        text: 'https://area.loja.com',
      })
    ).json().deliverable;
    expect(l.kind).toBe('LINK');
    expect(
      (
        await send('POST', '/ai/deliverables', {
          name: 'Outro',
          kind: 'TEXT',
          text: 'x',
          code: 'guia-de-cafes',
        })
      ).json().error.code,
    ).toBe('CODE_IN_USE');
    expect((await get('/ai/deliverables')).json().items).toHaveLength(4);
    expect(
      (await prisma.auditLog.findMany()).filter((x) => x.action === 'ai.deliverable_created'),
    ).toHaveLength(4);
  });

  it('valida: arquivo, texto, link, preço e instruções de pagamento', async () => {
    const w = await world();
    const bad = async (body: object, field: string) => {
      const r = await send('POST', '/ai/deliverables', body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(r.json()), field).toContain(field);
    };
    await bad({ name: 'X1', kind: 'FILE' }, 'assetId');
    await bad(
      { name: 'X2', kind: 'FILE', assetId: '00000000-0000-4000-8000-000000000000' },
      'assetId',
    );
    const textAsset = await prisma.asset.create({
      data: { kind: 'TEXT', name: 'Texto', textContent: 'oi' },
    });
    await bad({ name: 'X3', kind: 'FILE', assetId: textAsset.id }, 'assetId');
    await bad({ name: 'X4', kind: 'TEXT' }, 'text');
    await bad({ name: 'X5', kind: 'LINK', text: 'não é link' }, 'text');
    await bad(
      { name: 'X6', kind: 'TEXT', text: 'oi', requiresPayment: true, paymentInstructions: 'Pix' },
      'priceCents',
    );
    await bad(
      {
        name: 'X7',
        kind: 'TEXT',
        text: 'oi',
        requiresPayment: true,
        priceCents: 50,
        paymentInstructions: 'Pix',
      },
      'priceCents',
    );
    await bad(
      { name: 'X8', kind: 'TEXT', text: 'oi', requiresPayment: true, priceCents: 1000 },
      'paymentInstructions',
    );
    await bad({ name: 'X9', kind: 'TEXT', text: 'oi', code: 'Ab' }, 'code');
    await bad({ name: 'Y', kind: 'TEXT', text: 'oi' }, 'name');
    expect(await prisma.aiDeliverable.count()).toBe(0);
    void w;
  });

  it('editar mescla e revalida; o código não muda; trocar para pago exige preço', async () => {
    const w = await world();
    const a = await mkItem(w);
    const r = await send('PATCH', `/ai/deliverables/${a.id}`, {
      name: 'Guia completo',
      code: 'outro-codigo',
      approval: 'AUTO',
      adultOnly: true,
    });
    expect(r.json().deliverable).toMatchObject({
      name: 'Guia completo',
      code: 'guia-de-cafes',
      approval: 'AUTO',
      adultOnly: true,
    });
    const bad = await send('PATCH', `/ai/deliverables/${a.id}`, { requiresPayment: true });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain('priceCents');
    const ok = await send('PATCH', `/ai/deliverables/${a.id}`, {
      requiresPayment: true,
      priceCents: 4990,
      paymentInstructions: 'Pix 11 99999-0000',
    });
    expect(ok.json().deliverable).toMatchObject({ requiresPayment: true, priceCents: 4990 });
    // voltar para gratuito limpa preço e instruções
    const free = await send('PATCH', `/ai/deliverables/${a.id}`, { requiresPayment: false });
    expect(free.json().deliverable).toMatchObject({
      requiresPayment: false,
      priceCents: null,
      paymentInstructions: null,
    });
    expect(
      (await send('PATCH', '/ai/deliverables/00000000-0000-4000-8000-000000000000', { name: 'Zé' }))
        .statusCode,
    ).toBe(404);
  });

  it('arquivo apagado da biblioteca aparece como indisponível', async () => {
    const w = await world();
    const a = await mkItem(w);
    await prisma.asset.delete({ where: { id: w.asset.id } });
    expect((await get(`/ai/deliverables/${a.id}`)).json().deliverable).toMatchObject({
      unavailable: true,
      assetId: null,
    });
  });

  it('exclui com confirmação do nome e só sem entregas em andamento; o histórico permanece', async () => {
    const w = await world();
    const a = await mkItem(w);
    expect(
      (await send('DELETE', `/ai/deliverables/${a.id}`, { confirmName: 'errado' })).json().error
        .code,
    ).toBe('NAME_MISMATCH');
    const r = await requestDelivery(prisma, {
      conversationId: w.conv.id,
      deliverableId: a.id,
      agentId: w.agent.id,
    });
    expect(r.delivery.status).toBe('AWAITING_APPROVAL');
    expect(
      (await send('DELETE', `/ai/deliverables/${a.id}`, { confirmName: 'Guia de cafés' })).json()
        .error.code,
    ).toBe('DELIVERIES_OPEN');
    await prisma.aiDelivery.update({ where: { id: r.delivery.id }, data: { status: 'SENT' } });
    expect(
      (await send('DELETE', `/ai/deliverables/${a.id}`, { confirmName: 'Guia de cafés' }))
        .statusCode,
    ).toBe(200);
    const kept = await prisma.aiDelivery.findUniqueOrThrow({ where: { id: r.delivery.id } });
    expect(kept).toMatchObject({
      itemName: 'Guia de cafés',
      itemCode: 'guia-de-cafes',
      deliverableId: null,
    });
  });

  it('liga e desliga itens de cada agente', async () => {
    const w = await world();
    const a = await mkItem(w);
    expect((await get(`/ai/agents/${w.agent.id}/deliverables`)).json().deliverableIds).toEqual([]);
    await send('PUT', `/ai/agents/${w.agent.id}/deliverables`, { deliverableIds: [a.id, a.id] });
    expect((await get(`/ai/agents/${w.agent.id}/deliverables`)).json().deliverableIds).toEqual([
      a.id,
    ]);
    expect((await get('/ai/deliverables')).json().items[0].agents).toEqual([
      { id: w.agent.id, name: 'Ag' },
    ]);
    expect(
      (
        await send('PUT', `/ai/agents/${w.agent.id}/deliverables`, {
          deliverableIds: ['00000000-0000-4000-8000-000000000000'],
        })
      ).statusCode,
    ).toBe(404);
    await send('PUT', `/ai/agents/${w.agent.id}/deliverables`, { deliverableIds: [] });
    expect((await get(`/ai/agents/${w.agent.id}/deliverables`)).json().deliverableIds).toEqual([]);
  });
});

describe('entregas e pagamento', () => {
  const paid = async (w: W, approval: 'AUTO' | 'MANUAL') => {
    const it = await mkItem(w, {
      approval,
      requiresPayment: true,
      priceCents: 4990,
      paymentInstructions: 'Pix 11 99999-0000',
      name: `Pago ${approval}`,
    });
    return requestDelivery(prisma, {
      conversationId: w.conv.id,
      deliverableId: it.id,
      agentId: w.agent.id,
    });
  };

  it('lista as entregas da conversa, com o pagamento', async () => {
    const w = await world();
    const r = await paid(w, 'AUTO');
    const list = (await get(`/ai/deliveries?conversationId=${w.conv.id}`)).json().items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      itemName: 'Pago AUTO',
      status: 'AWAITING_PAYMENT',
      payment: {
        reference: r.payment!.reference,
        amountCents: 4990,
        status: 'PENDING',
        confirmedBy: null,
      },
    });
  });

  it('aprovar: só quando aguarda aprovação; vai para a fila de envio; se o gateway cair volta a esperar', async () => {
    const w = await world();
    const it = await mkItem(w);
    const r = await requestDelivery(prisma, {
      conversationId: w.conv.id,
      deliverableId: it.id,
      agentId: w.agent.id,
    });
    await redis.del(HEARTBEAT_KEYS.gateway);
    expect((await send('POST', `/ai/deliveries/${r.delivery.id}/approve`)).statusCode).toBe(503);
    expect(
      (await prisma.aiDelivery.findUniqueOrThrow({ where: { id: r.delivery.id } })).status,
    ).toBe('AWAITING_APPROVAL');
    await redis.set(HEARTBEAT_KEYS.gateway, '1', 'EX', 60);
    expect((await send('POST', `/ai/deliveries/${r.delivery.id}/approve`)).statusCode).toBe(202);
    expect(
      (await prisma.aiDelivery.findUniqueOrThrow({ where: { id: r.delivery.id } })).status,
    ).toBe('QUEUED');
    expect(await jobs()).toEqual([
      { type: 'send-delivery', accountId: w.account.id, deliveryId: r.delivery.id },
    ]);
    expect((await send('POST', `/ai/deliveries/${r.delivery.id}/approve`)).json().error.code).toBe(
      'NOT_AWAITING_APPROVAL',
    );
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain(
      'ai.delivery_approved',
    );
  });

  it('o administrador confirma o pagamento: automático vai para a fila; manual espera aprovação; só uma vez', async () => {
    const w = await world();
    const a = await paid(w, 'AUTO');
    expect(
      (
        await send('POST', `/ai/deliveries/${a.delivery.id}/confirm-payment`, {
          note: 'Conferi no banco',
        })
      ).json().status,
    ).toBe('QUEUED');
    expect(await jobs()).toEqual([
      { type: 'send-delivery', accountId: w.account.id, deliveryId: a.delivery.id },
    ]);
    expect(
      await prisma.aiPayment.findFirstOrThrow({ where: { deliveryId: a.delivery.id } }),
    ).toMatchObject({ status: 'CONFIRMED', confirmedBy: 'admin', note: 'Conferi no banco' });
    expect(
      (await send('POST', `/ai/deliveries/${a.delivery.id}/confirm-payment`)).json().error.code,
    ).toBe('ALREADY_CONFIRMED');

    await gateway.rawQueue.drain(true);
    const m = await paid(w, 'MANUAL');
    expect(
      (await send('POST', `/ai/deliveries/${m.delivery.id}/confirm-payment`)).json().status,
    ).toBe('AWAITING_APPROVAL');
    expect(await jobs()).toEqual([]);
    expect(
      (await prisma.auditLog.findMany()).filter((x) => x.action === 'ai.payment_confirmed'),
    ).toHaveLength(2);
  });

  it('entrega sem pagamento não tem o que confirmar', async () => {
    const w = await world();
    const it = await mkItem(w);
    const r = await requestDelivery(prisma, {
      conversationId: w.conv.id,
      deliverableId: it.id,
      agentId: w.agent.id,
    });
    expect(
      (await send('POST', `/ai/deliveries/${r.delivery.id}/confirm-payment`)).json().error.code,
    ).toBe('NO_PAYMENT');
  });

  it('cancelar: aguardando ou na fila viram canceladas (e o pagamento pendente também); enviada não cancela', async () => {
    const w = await world();
    const a = await paid(w, 'AUTO');
    expect((await send('POST', `/ai/deliveries/${a.delivery.id}/cancel`)).statusCode).toBe(200);
    expect(
      (await prisma.aiDelivery.findUniqueOrThrow({ where: { id: a.delivery.id } })).status,
    ).toBe('CANCELED');
    expect(
      (await prisma.aiPayment.findFirstOrThrow({ where: { deliveryId: a.delivery.id } })).status,
    ).toBe('CANCELED');
    // pagamento cancelado não pode mais ser confirmado
    expect(
      (await send('POST', `/ai/deliveries/${a.delivery.id}/confirm-payment`)).json().error.code,
    ).toBe('PAYMENT_CLOSED');
    const it = await mkItem(w, { name: 'Outro' });
    const sentOne = await requestDelivery(prisma, {
      conversationId: w.conv.id,
      deliverableId: it.id,
      agentId: w.agent.id,
    });
    await prisma.aiDelivery.update({
      where: { id: sentOne.delivery.id },
      data: { status: 'SENT' },
    });
    expect(
      (await send('POST', `/ai/deliveries/${sentOne.delivery.id}/cancel`)).json().error.code,
    ).toBe('CANNOT_CANCEL');
  });

  it('reenviar: só entregas que falharam', async () => {
    const w = await world();
    const it = await mkItem(w);
    const r = await requestDelivery(prisma, {
      conversationId: w.conv.id,
      deliverableId: it.id,
      agentId: w.agent.id,
    });
    expect((await send('POST', `/ai/deliveries/${r.delivery.id}/retry`)).json().error.code).toBe(
      'NOT_FAILED',
    );
    await prisma.aiDelivery.update({
      where: { id: r.delivery.id },
      data: { status: 'FAILED', reason: 'x' },
    });
    expect((await send('POST', `/ai/deliveries/${r.delivery.id}/retry`)).statusCode).toBe(202);
    expect(
      (await prisma.aiDelivery.findUniqueOrThrow({ where: { id: r.delivery.id } })).status,
    ).toBe('QUEUED');
    expect(await jobs()).toHaveLength(1);
  });
});

describe('rascunho aprovado com item para entregar', () => {
  const draftWith = async (w: W, itemId: string) =>
    prisma.aiDraft.create({
      data: {
        conversationId: w.conv.id,
        agentId: w.agent.id,
        inboundMessageId: w.inbound.id,
        body: 'Segue o guia!',
        deliverableId: itemId,
      },
    });

  it('gratuito automático: a entrega nasce e vai para a fila junto com a resposta', async () => {
    const w = await world();
    const it = await mkItem(w, { approval: 'AUTO' });
    const d = await draftWith(w, it.id);
    const r = await send('POST', `/ai/drafts/${d.id}/approve`);
    expect(r.statusCode).toBe(202);
    expect(r.json().delivery.status).toBe('QUEUED');
    const types = (await jobs()).map((j) => (j as { type: string }).type).sort();
    expect(types).toEqual(['send-delivery', 'send-reply']);
  });

  it('pago: manda o código do pedido e nada é entregue antes do pagamento', async () => {
    const w = await world();
    const it = await mkItem(w, {
      requiresPayment: true,
      priceCents: 4990,
      paymentInstructions: 'Pix',
    });
    const d = await draftWith(w, it.id);
    const r = await send('POST', `/ai/drafts/${d.id}/approve`);
    expect(r.json().delivery.status).toBe('AWAITING_PAYMENT');
    const pay = await prisma.aiPayment.findFirstOrThrow();
    const out = await prisma.message.findMany({
      where: { direction: 'OUTBOUND' },
      orderBy: { createdAt: 'asc' },
    });
    expect(out.map((m) => m.body)).toEqual([
      'Segue o guia!',
      `Código do pedido: ${pay.reference} (R$ 49,90). Informe este código ao pagar. Assim que o pagamento for confirmado, envio o item.`,
    ]);
    expect((await jobs()).map((j) => (j as { type: string }).type)).toEqual([
      'send-reply',
      'send-reply',
    ]);
  });

  it('item apagado depois do rascunho: a resposta vai, a entrega não nasce', async () => {
    const w = await world();
    const it = await mkItem(w, { approval: 'AUTO' });
    const d = await draftWith(w, it.id);
    await prisma.aiDeliverable.delete({ where: { id: it.id } });
    const r = await send('POST', `/ai/drafts/${d.id}/approve`);
    expect(r.statusCode).toBe(202);
    expect(r.json().delivery).toBeNull();
    expect(await prisma.aiDelivery.count()).toBe(0);
  });

  it('a lista de rascunhos mostra qual item o agente quer entregar', async () => {
    const w = await world();
    const it = await mkItem(w);
    await draftWith(w, it.id);
    expect((await get('/ai/drafts')).json().items[0].deliverableName).toBe('Guia de cafés');
  });
});

describe('laboratório só simula', () => {
  it('mostra o que seria entregue, sem marcador no texto e sem criar nem enviar nada', async () => {
    const w = await world();
    await send('PUT', '/ai/settings', { apiKey: 'sk-or-chave-de-teste-1234' });
    const it = await mkItem(w, {
      code: 'guia',
      requiresPayment: true,
      priceCents: 4990,
      paymentInstructions: 'Pix',
      approval: 'AUTO',
    });
    await send('PUT', `/ai/agents/${w.agent.id}/deliverables`, { deliverableIds: [it.id] });
    const session = (
      await send('POST', `/ai/agents/${w.agent.id}/test-sessions`, { source: 'draft' })
    ).json().session;
    chatContent = 'O guia custa R$ 49,90. [[ENTREGAR:guia]]';
    const r = await send('POST', `/ai/test-sessions/${session.id}/messages`, {
      text: 'quero o guia',
    });
    const reply = r.json().messages[1];
    expect(reply.content).toBe('O guia custa R$ 49,90.');
    expect(reply.debug.delivery).toMatchObject({
      code: 'guia',
      name: 'Guia de cafés',
      adultOnly: false,
    });
    expect(reply.debug.delivery.condition).toMatch(/pago \(R\$ 49,90\)/);
    expect(reply.debug.systemPrompt).toContain('[guia] Guia de cafés');
    expect(await prisma.aiDelivery.count()).toBe(0);
    expect(await prisma.aiPayment.count()).toBe(0);
    expect(await jobs()).toEqual([]);
  });
});

describe('aviso de pagamento assinado', () => {
  const sign = (secret: string, body: string, ts = Math.floor(Date.now() / 1000)) => ({
    'content-type': 'application/json',
    'x-multizap-timestamp': String(ts),
    'x-multizap-signature': `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`,
  });
  const hook = (body: object | string, headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/ai-payments',
      headers,
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const secret = async () =>
    (await send('POST', '/ai/payments/webhook/rotate')).json().secret as string;

  it('o segredo é mostrado uma vez e guardado criptografado; o painel só vê os 4 últimos caracteres', async () => {
    expect((await get('/ai/payments/webhook')).json()).toMatchObject({
      configured: false,
      canStoreKey: true,
      path: '/api/webhooks/ai-payments',
    });
    const r = (await send('POST', '/ai/payments/webhook/rotate')).json();
    expect(r.secret).toMatch(/^mzpay_[0-9a-f]{48}$/);
    const status = await get('/ai/payments/webhook');
    expect(status.json()).toMatchObject({ configured: true, keyLast4: r.secret.slice(-4) });
    expect(status.body).not.toContain(r.secret);
    const row = await prisma.aiCredential.findUniqueOrThrow({
      where: { provider: 'payment-webhook' },
    });
    expect(Buffer.from(row.keyEnc).toString('latin1')).not.toContain(r.secret);
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(r.secret);
    const second = (await send('POST', '/ai/payments/webhook/rotate')).json();
    expect(second.secret).not.toBe(r.secret);
  });

  it('sem configuração, assinatura errada, adulterada ou expirada: recusa e não confirma nada', async () => {
    const w = await world();
    const it = await mkItem(w, {
      requiresPayment: true,
      priceCents: 4990,
      paymentInstructions: 'Pix',
      approval: 'AUTO',
    });
    const r = await requestDelivery(prisma, {
      conversationId: w.conv.id,
      deliverableId: it.id,
      agentId: w.agent.id,
    });
    const body = JSON.stringify({
      reference: r.payment!.reference,
      status: 'paid',
      amountCents: 4990,
      externalId: 'p-1',
    });
    expect((await hook(body, sign('qualquer', body))).statusCode).toBe(503);

    const sec = await secret();
    expect((await hook(body, { 'content-type': 'application/json' })).statusCode).toBe(401);
    expect((await hook(body, sign('mzpay_errado', body))).statusCode).toBe(401);
    expect((await hook(body.replace('4990', '9999'), sign(sec, body))).statusCode).toBe(401); // corpo adulterado
    expect(
      (await hook(body, sign(sec, body, Math.floor(Date.now() / 1000) - 3600))).statusCode,
    ).toBe(401); // expirado
    expect(
      (await hook(body, { ...sign(sec, body), 'x-multizap-signature': 'sha256=zz' })).statusCode,
    ).toBe(401);
    expect((await prisma.aiPayment.findFirstOrThrow()).status).toBe('PENDING');
    expect(await jobs()).toEqual([]);
  });

  it('pagamento válido confirma, libera a entrega e avisa; repetido não libera de novo', async () => {
    const w = await world();
    const it = await mkItem(w, {
      requiresPayment: true,
      priceCents: 4990,
      paymentInstructions: 'Pix',
      approval: 'AUTO',
    });
    const r = await requestDelivery(prisma, {
      conversationId: w.conv.id,
      deliverableId: it.id,
      agentId: w.agent.id,
    });
    const sec = await secret();
    const body = JSON.stringify({
      reference: r.payment!.reference,
      status: 'paid',
      amountCents: 4990,
      externalId: 'pix-abc',
    });
    const ok = await hook(body, sign(sec, body));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, status: 'QUEUED' });
    expect(await prisma.aiPayment.findFirstOrThrow()).toMatchObject({
      status: 'CONFIRMED',
      confirmedBy: 'webhook',
      externalId: 'pix-abc',
    });
    expect(await jobs()).toEqual([
      { type: 'send-delivery', accountId: w.account.id, deliveryId: r.delivery.id },
    ]);
    expect(
      (
        await prisma.systemNotification.findFirstOrThrow({
          where: { title: 'Pagamento confirmado' },
        })
      ).message,
    ).toContain(r.payment!.reference);
    const again = await hook(body, sign(sec, body));
    expect(again.json()).toMatchObject({ ok: true, duplicate: true });
    expect(await jobs()).toHaveLength(1);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ai.payment_confirmed' },
    });
    expect(audit.actorId).toBeNull();
  });

  it('valor menor que o do pedido não libera nada e avisa o administrador', async () => {
    const w = await world();
    const it = await mkItem(w, {
      requiresPayment: true,
      priceCents: 4990,
      paymentInstructions: 'Pix',
      approval: 'AUTO',
    });
    const r = await requestDelivery(prisma, {
      conversationId: w.conv.id,
      deliverableId: it.id,
      agentId: w.agent.id,
    });
    const sec = await secret();
    for (const amountCents of [1000, undefined]) {
      const body = JSON.stringify({
        reference: r.payment!.reference,
        status: 'paid',
        ...(amountCents && { amountCents }),
        externalId: `x-${amountCents}`,
      });
      const res = await hook(body, sign(sec, body));
      expect(res.statusCode).toBe(422);
    }
    expect((await prisma.aiPayment.findFirstOrThrow()).status).toBe('PENDING');
    expect(
      (await prisma.aiDelivery.findUniqueOrThrow({ where: { id: r.delivery.id } })).status,
    ).toBe('AWAITING_PAYMENT');
    expect((await prisma.systemNotification.findFirstOrThrow()).title).toMatch(/valor menor/);
    expect(await jobs()).toEqual([]);
    // valor maior ou igual é aceito
    const body = JSON.stringify({
      reference: r.payment!.reference,
      status: 'paid',
      amountCents: 5000,
      externalId: 'x-ok',
    });
    expect((await hook(body, sign(sec, body))).statusCode).toBe(200);
  });

  it('referência desconhecida, corpo inválido, mesmo identificador em outro pedido, e cancelamento', async () => {
    const w = await world();
    const mk = async (name: string) => {
      const it = await mkItem(w, {
        name,
        requiresPayment: true,
        priceCents: 4990,
        paymentInstructions: 'Pix',
        approval: 'AUTO',
      });
      return requestDelivery(prisma, {
        conversationId: w.conv.id,
        deliverableId: it.id,
        agentId: w.agent.id,
      });
    };
    const a = await mk('Item A');
    const b = await mk('Item B');
    const sec = await secret();
    const post = (o: object) => {
      const body = JSON.stringify(o);
      return hook(body, sign(sec, body));
    };
    expect(
      (await post({ reference: 'MZ-NAOEXI', status: 'paid', amountCents: 4990, externalId: 'e1' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await post({ reference: a.payment!.reference, status: 'quase', externalId: 'e1' }))
        .statusCode,
    ).toBe(400);
    expect((await hook('não é json', sign(sec, 'não é json'))).statusCode).toBe(400);
    expect(
      (
        await post({
          reference: a.payment!.reference,
          status: 'paid',
          amountCents: 4990,
          externalId: 'mesmo',
        })
      ).statusCode,
    ).toBe(200);
    const dup = await post({
      reference: b.payment!.reference,
      status: 'paid',
      amountCents: 4990,
      externalId: 'mesmo',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('DUPLICATE_EXTERNAL_ID');
    expect(
      (await prisma.aiPayment.findUniqueOrThrow({ where: { id: b.payment!.id } })).status,
    ).toBe('PENDING');
    const c = await post({
      reference: b.payment!.reference,
      status: 'canceled',
      externalId: 'cancel-1',
    });
    expect(c.statusCode).toBe(200);
    expect(
      (await prisma.aiDelivery.findUniqueOrThrow({ where: { id: b.delivery.id } })).status,
    ).toBe('CANCELED');
    expect(
      (await prisma.aiPayment.findUniqueOrThrow({ where: { id: b.payment!.id } })).status,
    ).toBe('CANCELED');
  });
});
