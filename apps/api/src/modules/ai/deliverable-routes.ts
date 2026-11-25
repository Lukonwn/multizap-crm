import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@multizap/database';
import { confirmPayment, notify, resolveNotifications } from '@multizap/database';
import {
  MAX_MESSAGE_LENGTH,
  PAYMENT_WEBHOOK_PATH,
  deliverableInputSchema,
  deliverableUpdateSchema,
  type AiDeliverableDTO,
  type AiDeliveryDTO,
  type AiPaymentWebhookDTO,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';

const idParams = z.object({ id: z.string().uuid('Identificador inválido.') });
const actor = (req: FastifyRequest) => req.auth!.user;
const WEBHOOK_PROVIDER = 'payment-webhook';
const WEBHOOK_AAD = 'ai:payment:webhook';
const TOLERANCE_S = 300;

const include = {
  asset: { select: { name: true, mimeType: true, storageKey: true } },
  agents: { include: { agent: { select: { id: true, name: true } } } },
  _count: { select: { deliveries: true } },
} satisfies Prisma.AiDeliverableInclude;
type Row = Prisma.AiDeliverableGetPayload<{ include: typeof include }>;

const toDTO = (d: Row): AiDeliverableDTO => ({
  id: d.id,
  code: d.code,
  name: d.name,
  description: d.description,
  kind: d.kind,
  assetId: d.assetId,
  assetName: d.asset?.name ?? null,
  assetMime: d.asset?.mimeType ?? null,
  text: d.text,
  adultOnly: d.adultOnly,
  approval: d.approval,
  requiresPayment: d.requiresPayment,
  priceCents: d.priceCents,
  paymentInstructions: d.paymentInstructions,
  enabled: d.enabled,
  unavailable: d.kind === 'FILE' && !d.asset?.storageKey,
  agents: d.agents.map((a) => a.agent),
  deliveryCount: d._count.deliveries,
  createdAt: d.createdAt.toISOString(),
});

const deliveryInclude = { payment: true } satisfies Prisma.AiDeliveryInclude;
const toDeliveryDTO = (
  d: Prisma.AiDeliveryGetPayload<{ include: typeof deliveryInclude }>,
): AiDeliveryDTO => ({
  id: d.id,
  conversationId: d.conversationId,
  itemName: d.itemName,
  itemCode: d.itemCode,
  status: d.status,
  reason: d.reason,
  payment: d.payment
    ? {
        reference: d.payment.reference,
        amountCents: d.payment.amountCents,
        status: d.payment.status,
        claimedAt: d.payment.claimedAt?.toISOString() ?? null,
        confirmedAt: d.payment.confirmedAt?.toISOString() ?? null,
        confirmedBy: d.payment.confirmedBy,
      }
    : null,
  sentAt: d.sentAt?.toISOString() ?? null,
  createdAt: d.createdAt.toISOString(),
});

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34);

/** Entregáveis: catálogo, entregas, pagamento e o aviso assinado de sistemas de pagamento. */
export async function aiDeliverableRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  const load = async (id: string) => {
    const d = await prisma.aiDeliverable.findUnique({ where: { id }, include });
    if (!d) throw Errors.notFound('Item não encontrado.');
    return d;
  };

  const assertAsset = async (kind: string, assetId?: string | null) => {
    if (kind !== 'FILE') return;
    const a = assetId
      ? await prisma.asset.findUnique({ where: { id: assetId }, select: { storageKey: true } })
      : null;
    if (!a?.storageKey)
      throw new AppError(400, 'VALIDATION_ERROR', 'Arquivo não encontrado na biblioteca.', {
        assetId: ['Escolha um arquivo (imagem, vídeo, áudio ou PDF) da biblioteca.'],
      });
  };

  const uniqueCode = async (wanted: string | undefined, name: string) => {
    const base = wanted ?? (slugify(name) || 'item');
    const padded = base.length < 3 ? `${base}-item` : base;
    for (let i = 0; i < 20; i++) {
      const code = i === 0 ? padded : `${padded.slice(0, 34)}-${i + 1}`;
      if (!(await prisma.aiDeliverable.findUnique({ where: { code }, select: { id: true } })))
        return code;
      if (wanted)
        throw new AppError(409, 'CODE_IN_USE', 'Já existe um item com esse código.', {
          code: ['Já existe um item com esse código.'],
        });
    }
    return `${padded.slice(0, 28)}-${randomBytes(2).toString('hex')}`;
  };

  const dispatch = async (accountId: string, deliveryId: string) => {
    if (!app.gateway || !(await app.gateway.isAlive()))
      throw new AppError(
        503,
        'GATEWAY_UNAVAILABLE',
        'O serviço de conexões está indisponível no momento.',
      );
    await app.gateway.send({ type: 'send-delivery', accountId, deliveryId });
  };

  // ─── Catálogo ───

  app.get('/ai/deliverables', auth, async () => {
    const rows = await prisma.aiDeliverable.findMany({ orderBy: { createdAt: 'desc' }, include });
    return { items: rows.map(toDTO) };
  });

  app.get('/ai/deliverables/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    return { deliverable: toDTO(await load(id)) };
  });

  app.post('/ai/deliverables', auth, async (req, reply) => {
    const input = parse(deliverableInputSchema, req.body);
    await assertAsset(input.kind, input.assetId);
    if (input.kind !== 'FILE' && (input.text?.length ?? 0) > MAX_MESSAGE_LENGTH)
      throw new AppError(400, 'VALIDATION_ERROR', 'Texto grande demais.', {
        text: [`Máximo de ${MAX_MESSAGE_LENGTH} caracteres.`],
      });
    const code = await uniqueCode(input.code, input.name);
    const d = await prisma.aiDeliverable.create({
      data: {
        code,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        assetId: input.kind === 'FILE' ? input.assetId : null,
        text: input.text ?? null,
        adultOnly: input.adultOnly,
        approval: input.approval,
        requiresPayment: input.requiresPayment,
        priceCents: input.requiresPayment ? (input.priceCents ?? null) : null,
        paymentInstructions: input.requiresPayment ? (input.paymentInstructions ?? null) : null,
        enabled: input.enabled,
      },
      include,
    });
    await audit(prisma, req, {
      action: 'ai.deliverable_created',
      actorId: actor(req).id,
      entityType: 'ai_deliverable',
      entityId: d.id,
      details: { code, kind: d.kind, requiresPayment: d.requiresPayment },
    });
    reply.code(201);
    return { deliverable: toDTO(d) };
  });

  app.patch('/ai/deliverables/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(deliverableUpdateSchema, req.body);
    const cur = await load(id);
    // O código não muda (o agente e as entregas já feitas dependem dele).
    const { code: _ignored, ...rest } = patch;
    const merged = deliverableInputSchema.safeParse({
      name: cur.name,
      description: cur.description,
      kind: cur.kind,
      assetId: cur.assetId,
      text: cur.text,
      adultOnly: cur.adultOnly,
      approval: cur.approval,
      requiresPayment: cur.requiresPayment,
      priceCents: cur.priceCents,
      paymentInstructions: cur.paymentInstructions,
      enabled: cur.enabled,
      ...rest,
    });
    if (!merged.success) {
      const fields: Record<string, string[]> = {};
      for (const i of merged.error.issues)
        (fields[String(i.path[0] ?? 'form')] ??= []).push(i.message);
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        merged.error.issues[0]?.message ?? 'Dados inválidos.',
        fields,
      );
    }
    const v = merged.data;
    await assertAsset(v.kind, v.assetId);
    const d = await prisma.aiDeliverable.update({
      where: { id },
      data: {
        name: v.name,
        description: v.description ?? null,
        kind: v.kind,
        assetId: v.kind === 'FILE' ? v.assetId : null,
        text: v.text ?? null,
        adultOnly: v.adultOnly,
        approval: v.approval,
        requiresPayment: v.requiresPayment,
        priceCents: v.requiresPayment ? (v.priceCents ?? null) : null,
        paymentInstructions: v.requiresPayment ? (v.paymentInstructions ?? null) : null,
        enabled: v.enabled,
      },
      include,
    });
    await audit(prisma, req, {
      action: 'ai.deliverable_updated',
      actorId: actor(req).id,
      entityType: 'ai_deliverable',
      entityId: id,
      details: { fields: Object.keys(rest) },
    });
    return { deliverable: toDTO(d) };
  });

  app.delete('/ai/deliverables/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { confirmName } = parse(
      z.object({ confirmName: z.string().trim().min(1, 'Digite o nome para confirmar.') }),
      req.body ?? {},
    );
    const d = await load(id);
    if (confirmName !== d.name)
      throw new AppError(400, 'NAME_MISMATCH', 'O nome digitado não confere.');
    const open = await prisma.aiDelivery.count({
      where: {
        deliverableId: id,
        status: { in: ['AWAITING_PAYMENT', 'AWAITING_APPROVAL', 'QUEUED', 'SENDING'] },
      },
    });
    if (open)
      throw new AppError(
        409,
        'DELIVERIES_OPEN',
        `Há ${open} entrega(s) em andamento deste item. Conclua ou cancele antes de excluir (ou desligue o item).`,
      );
    await prisma.aiDeliverable.delete({ where: { id } });
    await audit(prisma, req, {
      action: 'ai.deliverable_deleted',
      actorId: actor(req).id,
      entityType: 'ai_deliverable',
      entityId: id,
      details: { code: d.code },
    });
    return { ok: true };
  });

  // ─── Itens de cada agente ───

  app.get('/ai/agents/:id/deliverables', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    if (!(await prisma.aiAgent.findUnique({ where: { id }, select: { id: true } })))
      throw Errors.notFound('Agente não encontrado.');
    const rows = await prisma.aiAgentDeliverable.findMany({
      where: { agentId: id },
      select: { deliverableId: true },
    });
    return { deliverableIds: rows.map((r) => r.deliverableId) };
  });

  app.put('/ai/agents/:id/deliverables', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { deliverableIds } = parse(
      z.object({ deliverableIds: z.array(z.string().uuid()).max(100) }),
      req.body,
    );
    if (!(await prisma.aiAgent.findUnique({ where: { id }, select: { id: true } })))
      throw Errors.notFound('Agente não encontrado.');
    const unique = [...new Set(deliverableIds)];
    if ((await prisma.aiDeliverable.count({ where: { id: { in: unique } } })) !== unique.length)
      throw Errors.notFound('Item não encontrado.');
    await prisma.$transaction([
      prisma.aiAgentDeliverable.deleteMany({
        where: { agentId: id, deliverableId: { notIn: unique } },
      }),
      prisma.aiAgentDeliverable.createMany({
        data: unique.map((deliverableId) => ({ agentId: id, deliverableId })),
        skipDuplicates: true,
      }),
    ]);
    await audit(prisma, req, {
      action: 'ai.agent_deliverables_updated',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: id,
      details: { count: unique.length },
    });
    return { deliverableIds: unique };
  });

  // ─── Entregas ───

  app.get('/ai/deliveries', auth, async (req) => {
    const q = parse(
      z.object({
        conversationId: z.string().uuid().optional(),
        status: z
          .enum([
            'AWAITING_PAYMENT',
            'AWAITING_APPROVAL',
            'QUEUED',
            'SENDING',
            'SENT',
            'FAILED',
            'BLOCKED',
            'CANCELED',
          ])
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const rows = await prisma.aiDelivery.findMany({
      where: {
        ...(q.conversationId && { conversationId: q.conversationId }),
        ...(q.status && { status: q.status }),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      include: deliveryInclude,
    });
    return { items: rows.map(toDeliveryDTO) };
  });

  const loadDelivery = async (id: string) => {
    const d = await prisma.aiDelivery.findUnique({
      where: { id },
      include: { payment: true, conversation: { select: { accountId: true } } },
    });
    if (!d) throw Errors.notFound('Entrega não encontrada.');
    return d;
  };

  app.post('/ai/deliveries/:id/approve', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const d = await loadDelivery(id);
    const moved = await prisma.aiDelivery.updateMany({
      where: { id, status: 'AWAITING_APPROVAL' },
      data: { status: 'QUEUED', decidedBy: actor(req).email ?? null },
    });
    if (moved.count !== 1)
      throw new AppError(
        409,
        'NOT_AWAITING_APPROVAL',
        'Esta entrega não está aguardando aprovação.',
      );
    try {
      await dispatch(d.conversation.accountId, id);
    } catch (err) {
      // Sem gateway: volta a esperar, para o administrador tentar de novo.
      await prisma.aiDelivery.update({
        where: { id },
        data: { status: 'AWAITING_APPROVAL', decidedBy: null },
      });
      throw err;
    }
    await resolveNotifications(prisma, `ai-delivery-approval:${id}`);
    await audit(prisma, req, {
      action: 'ai.delivery_approved',
      actorId: actor(req).id,
      entityType: 'ai_delivery',
      entityId: id,
      accountId: d.conversation.accountId,
      details: { item: d.itemCode },
    });
    reply.code(202);
    return { ok: true };
  });

  app.post('/ai/deliveries/:id/retry', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const d = await loadDelivery(id);
    const moved = await prisma.aiDelivery.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'QUEUED', reason: null },
    });
    if (moved.count !== 1)
      throw new AppError(409, 'NOT_FAILED', 'Só entregas que falharam podem ser reenviadas.');
    try {
      await dispatch(d.conversation.accountId, id);
    } catch (err) {
      await prisma.aiDelivery.update({
        where: { id },
        data: { status: 'FAILED', reason: d.reason },
      });
      throw err;
    }
    await resolveNotifications(prisma, `ai-delivery:${id}`);
    reply.code(202);
    return { ok: true };
  });

  app.post('/ai/deliveries/:id/cancel', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const d = await loadDelivery(id);
    const moved = await prisma.aiDelivery.updateMany({
      where: { id, status: { in: ['AWAITING_PAYMENT', 'AWAITING_APPROVAL', 'QUEUED', 'FAILED'] } },
      data: {
        status: 'CANCELED',
        decidedBy: actor(req).email ?? null,
        reason: 'Cancelada pelo administrador.',
      },
    });
    if (moved.count !== 1)
      throw new AppError(
        409,
        'CANNOT_CANCEL',
        'Esta entrega já foi enviada, está sendo enviada ou foi cancelada.',
      );
    await prisma.aiPayment.updateMany({
      where: { deliveryId: id, status: 'PENDING' },
      data: { status: 'CANCELED' },
    });
    for (const key of [`ai-delivery-approval:${id}`, `ai-delivery:${id}`])
      await resolveNotifications(prisma, key);
    await audit(prisma, req, {
      action: 'ai.delivery_canceled',
      actorId: actor(req).id,
      entityType: 'ai_delivery',
      entityId: id,
      accountId: d.conversation.accountId,
    });
    return { ok: true };
  });

  /** O administrador conferiu o pagamento na fonte dele (banco, maquininha, plataforma). */
  app.post('/ai/deliveries/:id/confirm-payment', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { note } = parse(
      z.object({ note: z.string().trim().max(300).optional() }),
      req.body ?? {},
    );
    const d = await loadDelivery(id);
    if (!d.payment) throw new AppError(409, 'NO_PAYMENT', 'Esta entrega não tem pagamento.');
    const r = await confirmPayment(prisma, {
      paymentId: d.payment.id,
      by: 'admin',
      note: note ?? null,
    });
    if (!r.ok)
      throw new AppError(
        409,
        r.reason === 'ALREADY_CONFIRMED' ? 'ALREADY_CONFIRMED' : 'PAYMENT_CLOSED',
        r.reason === 'ALREADY_CONFIRMED'
          ? 'Este pagamento já foi confirmado.'
          : 'Este pagamento foi cancelado.',
      );
    await resolveNotifications(prisma, `ai-pay-claim:${d.payment.id}`);
    if (r.dispatch) await dispatch(d.conversation.accountId, id).catch(() => undefined);
    await audit(prisma, req, {
      action: 'ai.payment_confirmed',
      actorId: actor(req).id,
      entityType: 'ai_delivery',
      entityId: id,
      accountId: d.conversation.accountId,
      details: { by: 'admin', reference: d.payment.reference },
    });
    reply.code(200);
    return { status: r.delivery.status };
  });

  // ─── Aviso de pagamento assinado (sistemas externos) ───

  const secretStatus = async (): Promise<AiPaymentWebhookDTO> => {
    const c = await prisma.aiCredential.findUnique({ where: { provider: WEBHOOK_PROVIDER } });
    return {
      configured: !!c,
      keyLast4: c?.keyLast4 ?? null,
      path: PAYMENT_WEBHOOK_PATH,
      canStoreKey: !!app.cipher,
    };
  };
  app.get('/ai/payments/webhook', auth, secretStatus);

  /** Gera (ou troca) o segredo do aviso. Ele só é mostrado agora, uma vez. */
  app.post('/ai/payments/webhook/rotate', auth, async (req) => {
    if (!app.cipher)
      throw new AppError(
        503,
        'AI_CIPHER_UNAVAILABLE',
        'O servidor não está configurado para guardar segredos (CREDENTIALS_MASTER_KEY).',
      );
    const secret = `mzpay_${randomBytes(24).toString('hex')}`;
    const keyEnc = new Uint8Array(app.cipher.encrypt(secret, WEBHOOK_AAD));
    await prisma.aiCredential.upsert({
      where: { provider: WEBHOOK_PROVIDER },
      create: { provider: WEBHOOK_PROVIDER, keyEnc, keyVersion: 1, keyLast4: secret.slice(-4) },
      update: {
        keyEnc,
        keyLast4: secret.slice(-4),
        lastTestAt: null,
        lastTestOk: null,
        lastError: null,
      },
    });
    await audit(prisma, req, {
      action: 'ai.payment_webhook_rotated',
      actorId: actor(req).id,
      entityType: 'ai_credential',
    });
    return { secret, keyLast4: secret.slice(-4), path: PAYMENT_WEBHOOK_PATH };
  });

  // O corpo bruto é necessário para conferir a assinatura: o analisador de JSON desta rota o preserva.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 16 * 1024 },
      (_req, body, done) => done(null, body),
    );

    scope.post('/webhooks/ai-payments', { config: { rawBody: true } }, async (req, reply) => {
      const cred = await prisma.aiCredential.findUnique({ where: { provider: WEBHOOK_PROVIDER } });
      if (!cred || !app.cipher)
        throw new AppError(
          503,
          'WEBHOOK_NOT_CONFIGURED',
          'O aviso de pagamento não está configurado.',
        );
      let secret: string;
      try {
        secret = app.cipher.decrypt(Buffer.from(cred.keyEnc), WEBHOOK_AAD).toString('utf8');
      } catch {
        throw new AppError(
          503,
          'WEBHOOK_NOT_CONFIGURED',
          'O segredo salvo não pôde ser lido. Gere outro.',
        );
      }
      const raw = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(JSON.stringify(req.body ?? {}));
      const ts = String(req.headers['x-multizap-timestamp'] ?? '');
      const sig = String(req.headers['x-multizap-signature'] ?? '').replace(/^sha256=/i, '');
      const age = Math.abs(Date.now() / 1000 - Number(ts));
      const expected = createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
      const ok =
        /^\d+$/.test(ts) &&
        age <= TOLERANCE_S &&
        sig.length === expected.length &&
        timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) throw new AppError(401, 'BAD_SIGNATURE', 'Assinatura inválida ou expirada.');

      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new AppError(400, 'BAD_BODY', 'Corpo inválido.');
      }
      const body = parse(
        z.object({
          reference: z.string().trim().min(4).max(40),
          status: z.enum(['paid', 'canceled']),
          amountCents: z.number().int().positive().max(100_000_000).optional(),
          externalId: z.string().trim().min(1).max(120),
        }),
        json,
      );
      const payment = await prisma.aiPayment.findUnique({
        where: { reference: body.reference },
        include: {
          delivery: {
            include: {
              conversation: { select: { accountId: true, title: true, phoneE164: true } },
            },
          },
        },
      });
      if (!payment) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Pagamento não encontrado.');
      const accountId = payment.delivery.conversation.accountId;

      if (body.status === 'canceled') {
        await prisma.aiPayment
          .updateMany({
            where: { id: payment.id, status: 'PENDING' },
            data: { status: 'CANCELED', externalId: body.externalId },
          })
          .catch(() => undefined);
        await prisma.aiDelivery.updateMany({
          where: {
            id: payment.deliveryId,
            status: { in: ['AWAITING_PAYMENT', 'AWAITING_APPROVAL', 'QUEUED'] },
          },
          data: { status: 'CANCELED', reason: 'Pagamento cancelado pelo sistema de pagamento.' },
        });
        return { ok: true };
      }

      if (body.amountCents === undefined || body.amountCents < payment.amountCents) {
        await notify(prisma, {
          severity: 'WARNING',
          category: 'PROCESSING',
          title: 'Pagamento com valor menor que o esperado',
          message: `Pedido ${payment.reference}: esperado ${payment.amountCents} centavos, recebido ${body.amountCents ?? 'sem valor'}. Nada foi liberado.`,
          accountId,
          dedupeKey: `ai-pay-low:${payment.id}`,
        });
        throw new AppError(422, 'AMOUNT_TOO_LOW', 'O valor informado é menor que o do pedido.');
      }

      let result;
      try {
        result = await confirmPayment(prisma, {
          reference: payment.reference,
          by: 'webhook',
          externalId: body.externalId,
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002')
          throw new AppError(
            409,
            'DUPLICATE_EXTERNAL_ID',
            'Este identificador de pagamento já foi usado.',
          );
        throw e;
      }
      if (!result.ok) {
        if (result.reason === 'ALREADY_CONFIRMED') return { ok: true, duplicate: true };
        throw new AppError(409, 'PAYMENT_CLOSED', 'Este pagamento foi cancelado.');
      }
      await resolveNotifications(prisma, `ai-pay-claim:${payment.id}`);
      if (result.dispatch && app.gateway)
        await app.gateway
          .send({ type: 'send-delivery', accountId, deliveryId: payment.deliveryId })
          .catch(() => undefined);
      await notify(prisma, {
        severity: 'INFO',
        category: 'PROCESSING',
        title: 'Pagamento confirmado',
        message: `${payment.delivery.itemName}: pedido ${payment.reference} pago${result.delivery.status === 'AWAITING_APPROVAL' ? '. Aprove a entrega em Atendimentos.' : '.'}`,
        accountId,
        dedupeKey: `ai-pay-ok:${payment.id}`,
      });
      await audit(prisma, null, {
        action: 'ai.payment_confirmed',
        entityType: 'ai_delivery',
        entityId: payment.deliveryId,
        accountId,
        details: { by: 'webhook', reference: payment.reference },
      });
      reply.code(200);
      return { ok: true, status: result.delivery.status };
    });
  });
}
