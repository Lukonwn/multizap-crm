import { randomBytes } from 'node:crypto';
import type { AiDelivery, AiPayment, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Sem 0/O/1/I para não confundir quando o contato digita o código. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newPaymentReference(): string {
  const b = randomBytes(6);
  let out = 'MZ-';
  for (let i = 0; i < 6; i++) out += ALPHABET[b[i]! % ALPHABET.length];
  return out;
}

const isUnique = (e: unknown) => (e as { code?: string })?.code === 'P2002';

export interface RequestDeliveryInput {
  conversationId: string;
  deliverableId: string;
  agentId: string | null;
  inboundMessageId?: string | null;
}

export interface RequestDeliveryResult {
  delivery: AiDelivery;
  payment: AiPayment | null;
  /** Nasceu agora (false: já existia um pedido igual). */
  created: boolean;
  /** Está liberada para envio: quem chamou deve mandar o comando ao gateway. */
  dispatch: boolean;
}

const OPEN = ['AWAITING_PAYMENT', 'AWAITING_APPROVAL', 'QUEUED', 'SENDING', 'SENT'] as const;

/**
 * Registra o pedido de entrega de um item numa conversa e decide o destino, na ordem:
 *  1. já existe pedido igual (mesma mensagem, ou item já em andamento/entregue): devolve o existente;
 *  2. bloqueios: item desligado, arquivo sumiu, conversa travada por sinal de menor de idade,
 *     item adulto sem a pergunta de 18 anos ligada E confirmada;
 *  3. item pago: nasce "aguardando pagamento" com um código de pagamento. NADA é enviado até o
 *     pagamento ser confirmado por fonte real (ver `confirmPayment`);
 *  4. item gratuito: aprovação automática vai direto para a fila de envio; manual espera o administrador.
 */
export async function requestDelivery(
  db: PrismaClient,
  input: RequestDeliveryInput,
): Promise<RequestDeliveryResult> {
  const [conv, item] = await Promise.all([
    db.conversation.findUnique({ where: { id: input.conversationId }, include: { aiState: true } }),
    db.aiDeliverable.findUnique({ where: { id: input.deliverableId }, include: { asset: true } }),
  ]);
  if (!conv) throw new Error('Conversa não encontrada.');
  if (!item) throw new Error('Item não encontrado.');

  if (input.inboundMessageId) {
    const same = await db.aiDelivery.findFirst({
      where: { inboundMessageId: input.inboundMessageId, deliverableId: item.id },
      include: { payment: true },
    });
    if (same) return { delivery: same, payment: same.payment, created: false, dispatch: false };
  }
  const open = await db.aiDelivery.findFirst({
    where: { conversationId: conv.id, deliverableId: item.id, status: { in: [...OPEN] } },
    include: { payment: true },
  });
  if (open) return { delivery: open, payment: open.payment, created: false, dispatch: false };

  const base = {
    conversationId: conv.id,
    deliverableId: item.id,
    itemName: item.name,
    itemCode: item.code,
    agentId: input.agentId,
    inboundMessageId: input.inboundMessageId ?? null,
  };
  const blocked = async (reason: string): Promise<RequestDeliveryResult> => ({
    delivery: await db.aiDelivery.create({ data: { ...base, status: 'BLOCKED', reason } }),
    payment: null,
    created: true,
    dispatch: false,
  });

  if (!item.enabled) return blocked('Item desligado.');
  if (item.kind === 'FILE' && !item.asset?.storageKey)
    return blocked('O arquivo não está mais na biblioteca de criativos.');
  if (conv.aiState?.paused && conv.aiState.pausedBy === 'minor')
    return blocked('Conversa travada por sinal de menor de idade.');
  if (item.adultOnly) {
    const agent = input.agentId
      ? await db.aiAgent.findUnique({ where: { id: input.agentId }, select: { ageGate: true } })
      : null;
    if (!agent?.ageGate || !conv.aiState?.ageConfirmedAt)
      return blocked(
        'Item adulto: exige a pergunta de 18 anos ligada no agente e confirmada nesta conversa.',
      );
  }

  if (item.requiresPayment) {
    if (!item.priceCents) return blocked('Item pago sem preço definido.');
    const delivery = await db.aiDelivery.create({ data: { ...base, status: 'AWAITING_PAYMENT' } });
    for (let attempt = 0; ; attempt++) {
      try {
        const payment = await db.aiPayment.create({
          data: {
            deliveryId: delivery.id,
            reference: newPaymentReference(),
            amountCents: item.priceCents,
          },
        });
        return { delivery, payment, created: true, dispatch: false };
      } catch (e) {
        if (!isUnique(e) || attempt >= 5) throw e;
      }
    }
  }

  const delivery = await db.aiDelivery.create({
    data: { ...base, status: item.approval === 'AUTO' ? 'QUEUED' : 'AWAITING_APPROVAL' },
  });
  return { delivery, payment: null, created: true, dispatch: delivery.status === 'QUEUED' };
}

export interface ConfirmPaymentInput {
  /** Um dos dois. */
  paymentId?: string;
  reference?: string;
  by: 'admin' | 'webhook';
  externalId?: string | null;
  note?: string | null;
}

export type ConfirmPaymentResult =
  | { ok: true; payment: AiPayment; delivery: AiDelivery; dispatch: boolean }
  | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_CONFIRMED' | 'CANCELED' };

/**
 * Confirma um pagamento (só por fonte real: administrador ou aviso assinado de um sistema externo;
 * quem chama é responsável por autenticar a fonte). Libera a entrega: aprovação automática vai
 * para a fila de envio; manual espera o administrador. Seguro contra chamadas repetidas.
 */
export async function confirmPayment(
  db: PrismaClient,
  input: ConfirmPaymentInput,
): Promise<ConfirmPaymentResult> {
  const payment = await db.aiPayment.findFirst({
    where: input.paymentId ? { id: input.paymentId } : { reference: input.reference ?? '-' },
  });
  if (!payment) return { ok: false, reason: 'NOT_FOUND' };
  if (payment.status === 'CANCELED') return { ok: false, reason: 'CANCELED' };

  const claimed = await db.aiPayment.updateMany({
    where: { id: payment.id, status: 'PENDING' },
    data: {
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      confirmedBy: input.by,
      externalId: input.externalId ?? null,
      note: input.note ?? null,
    },
  });
  if (claimed.count !== 1) return { ok: false, reason: 'ALREADY_CONFIRMED' };

  const delivery = await db.aiDelivery.findUniqueOrThrow({
    where: { id: payment.deliveryId },
    include: { deliverable: { select: { approval: true } } },
  });
  const next = delivery.deliverable?.approval === 'AUTO' ? 'QUEUED' : 'AWAITING_APPROVAL';
  const moved = await db.aiDelivery.updateMany({
    where: { id: delivery.id, status: 'AWAITING_PAYMENT' },
    data: { status: next },
  });
  const fresh = await db.aiDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
  return {
    ok: true,
    payment: await db.aiPayment.findUniqueOrThrow({ where: { id: payment.id } }),
    delivery: fresh,
    dispatch: moved.count === 1 && next === 'QUEUED',
  };
}
