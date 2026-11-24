import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { refreshCampaignProgress, type Prisma } from '@multizap/database';
import { PROVIDER_CAPABILITIES } from '@multizap/integrations';
import {
  SETTING_KEYS,
  audiencePreviewSchema,
  buildCampaignMessage,
  campaignInputSchema,
  scheduleSchema,
  type CampaignCounters,
  type CampaignDTO,
  type CampaignInput,
  type NextRecipientDTO,
  type RecipientDTO,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';

const idParams = z.object({ id: z.string().uuid('Campanha inválida.') });
const recipientParams = idParams.extend({ rid: z.string().uuid('Destinatário inválido.') });

const include = {
  asset: { select: { id: true, name: true, metadata: true } },
  accounts: {
    include: { account: { select: { id: true, name: true, status: true } } },
    orderBy: { account: { name: 'asc' } },
  },
} satisfies Prisma.CampaignInclude;
type CampaignRow = Prisma.CampaignGetPayload<{ include: typeof include }>;

const emptyCounters = (): CampaignCounters => ({
  total: 0,
  pending: 0,
  sending: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  skipped: 0,
});

/** Contagem por status de destinatário, para cada campanha-filho. */
async function countersFor(app: FastifyInstance, childIds: string[]) {
  const groups = childIds.length
    ? await app.prisma.campaignRecipient.groupBy({
        by: ['campaignAccountId', 'status'],
        where: { campaignAccountId: { in: childIds } },
        _count: { _all: true },
      })
    : [];
  const map = new Map<string, CampaignCounters>();
  for (const g of groups) {
    const c = map.get(g.campaignAccountId) ?? emptyCounters();
    const n = g._count._all;
    c.total += n;
    const key = g.status.toLowerCase() as keyof CampaignCounters;
    c[key] += n;
    map.set(g.campaignAccountId, c);
  }
  return map;
}

function sum(list: CampaignCounters[]): CampaignCounters {
  return list.reduce((acc, c) => {
    for (const k of Object.keys(acc) as (keyof CampaignCounters)[]) acc[k] += c[k];
    return acc;
  }, emptyCounters());
}

async function toDTO(app: FastifyInstance, c: CampaignRow): Promise<CampaignDTO> {
  const counters = await countersFor(
    app,
    c.accounts.map((a) => a.id),
  );
  const accounts = c.accounts.map((a) => ({
    id: a.id,
    accountId: a.accountId,
    accountName: a.account.name,
    accountStatus: a.account.status,
    tagIds: ((a.audience ?? {}) as { tagIds?: string[] }).tagIds ?? [],
    status: a.status,
    counters: counters.get(a.id) ?? emptyCounters(),
  }));
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    body: c.body ?? '',
    linkUrl: c.linkUrl,
    assetId: c.assetId,
    asset: c.asset
      ? {
          id: c.asset.id,
          name: c.asset.name,
          hasThumbnail: !!(c.asset.metadata as { thumbnailKey?: string })?.thumbnailKey,
        }
      : null,
    scheduledAt: c.scheduledAt?.toISOString() ?? null,
    startedAt: c.startedAt?.toISOString() ?? null,
    completedAt: c.completedAt?.toISOString() ?? null,
    cancelledAt: c.cancelledAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    accounts,
    counters: sum(accounts.map((a) => a.counters)),
  };
}

/** Público elegível: consentimento autorizado, não descadastrado, filtro de etiquetas. */
function eligibleWhere(accountId: string, tagIds: string[]): Prisma.ContactWhereInput {
  return {
    accountId,
    consentStatus: 'GRANTED',
    optedOutAt: null,
    ...(tagIds.length && { tags: { some: { tagId: { in: tagIds } } } }),
  };
}

export async function campaignRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  const load = async (id: string) => {
    const c = await prisma.campaign.findUnique({ where: { id }, include });
    if (!c) throw Errors.notFound('Campanha não encontrada.');
    return c;
  };

  const act = (
    req: FastifyRequest,
    action: string,
    entityId: string,
    details: Prisma.InputJsonValue = {},
  ) =>
    audit(prisma, req, {
      action: `campaign.${action}`,
      actorId: req.auth!.user.id,
      entityType: 'campaign',
      entityId,
      details,
    });

  /** Valida instâncias (dispositivo conectado com envio), etiquetas e criativos. */
  const validateInput = async (input: z.infer<typeof campaignInputSchema>) => {
    const accounts = await prisma.account.findMany({
      where: { id: { in: input.accounts.map((a) => a.accountId) } },
    });
    if (accounts.length !== input.accounts.length)
      throw new AppError(400, 'INVALID_ACCOUNT', 'Instância não encontrada.');
    for (const a of accounts) {
      const caps =
        PROVIDER_CAPABILITIES[a.connectionType === 'WHATSAPP_WEB' ? 'whatsapp-web' : 'manual'];
      if (!caps.sendMessage) {
        throw new AppError(
          400,
          'CHANNEL_CANNOT_SEND',
          `"${a.name}" é um aparelho apenas cadastrado e não envia mensagens.`,
        );
      }
    }
    for (const sel of input.accounts) {
      if (!sel.tagIds.length) continue;
      const n = await prisma.tag.count({
        where: { accountId: sel.accountId, id: { in: sel.tagIds } },
      });
      if (n !== new Set(sel.tagIds).size)
        throw new AppError(400, 'INVALID_TAGS', 'Etiqueta não pertence à instância selecionada.');
    }
    if (input.assetId) {
      const asset = await prisma.asset.findUnique({ where: { id: input.assetId } });
      if (!asset || !['IMAGE', 'BANNER'].includes(asset.kind))
        throw new AppError(400, 'INVALID_ASSET', 'Selecione uma imagem ou banner da biblioteca.');
    }
    if (input.templateId) {
      const t = await prisma.asset.findUnique({ where: { id: input.templateId } });
      if (!t || !['TEMPLATE', 'TEXT'].includes(t.kind))
        throw new AppError(400, 'INVALID_TEMPLATE', 'Modelo não encontrado.');
    }
  };

  const writeUsages = async (
    tx: Prisma.TransactionClient,
    campaignId: string,
    ids: (string | null | undefined)[],
  ) => {
    await tx.assetUsage.deleteMany({ where: { campaignId } });
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length)
      await tx.assetUsage.createMany({
        data: unique.map((assetId) => ({ assetId, campaignId })),
        skipDuplicates: true,
      });
  };

  // ─── Consulta ─────────────────────────────────────────────────────────────

  app.get('/campaigns', auth, async (req) => {
    const q = parse(
      z.object({
        status: z.string().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      }),
      req.query,
    );
    const statuses = q.status?.split(',').filter(Boolean);
    const rows = await prisma.campaign.findMany({
      where: {
        ...(statuses?.length && { status: { in: statuses as CampaignDTO['status'][] } }),
        ...((q.from || q.to) && { scheduledAt: { gte: q.from, lte: q.to } }),
      },
      include,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { items: await Promise.all(rows.map((r) => toDTO(app, r))) };
  });

  app.get('/campaigns/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const c = await load(id);
    const history = await prisma.auditLog.findMany({
      where: { entityType: 'campaign', entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      campaign: await toDTO(app, c),
      history: history.map((h) => ({
        id: h.id,
        action: h.action,
        details: h.details,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  });

  app.post('/campaigns/audience-preview', auth, async (req) => {
    const { accountId, tagIds } = parse(audiencePreviewSchema, req.body);
    const base = { accountId, ...(tagIds.length && { tags: { some: { tagId: { in: tagIds } } } }) };
    const [eligible, total, optedOut, noConsent] = await Promise.all([
      prisma.contact.count({ where: eligibleWhere(accountId, tagIds) }),
      prisma.contact.count({ where: base }),
      prisma.contact.count({ where: { ...base, optedOutAt: { not: null } } }),
      prisma.contact.count({
        where: { ...base, optedOutAt: null, consentStatus: { not: 'GRANTED' } },
      }),
    ]);
    const sample = await prisma.contact.findFirst({
      where: eligibleWhere(accountId, tagIds),
      orderBy: { createdAt: 'asc' },
      select: { name: true, phoneE164: true },
    });
    return { eligible, total, excludedOptedOut: optedOut, excludedNoConsent: noConsent, sample };
  });

  // ─── Criação e edição (somente rascunho) ─────────────────────────────────

  app.post('/campaigns', auth, async (req, reply) => {
    const input = parse(campaignInputSchema, req.body);
    await validateInput(input);
    const created = await prisma.$transaction(async (tx) => {
      const c = await tx.campaign.create({
        data: {
          name: input.name,
          body: input.body,
          linkUrl: input.linkUrl ?? null,
          assetId: input.assetId ?? null,
          status: 'DRAFT',
          accounts: {
            create: input.accounts.map((a) => ({
              accountId: a.accountId,
              audience: { tagIds: a.tagIds },
              status: 'DRAFT' as const,
            })),
          },
        },
      });
      await writeUsages(tx, c.id, [input.assetId, input.templateId]);
      return c;
    });
    await act(req, 'created', created.id, { name: created.name });
    reply.code(201);
    return { campaign: await toDTO(app, await load(created.id)) };
  });

  app.patch('/campaigns/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const c = await load(id);
    if (c.status !== 'DRAFT')
      throw new AppError(409, 'NOT_DRAFT', 'Somente rascunhos podem ser editados.');
    const input = parse(campaignInputSchema, req.body);
    await validateInput(input);
    await prisma.$transaction(async (tx) => {
      await tx.campaign.update({
        where: { id },
        data: {
          name: input.name,
          body: input.body,
          linkUrl: input.linkUrl ?? null,
          assetId: input.assetId ?? null,
        },
      });
      await tx.campaignAccount.deleteMany({ where: { campaignId: id } });
      await tx.campaignAccount.createMany({
        data: input.accounts.map((a) => ({
          campaignId: id,
          accountId: a.accountId,
          audience: { tagIds: a.tagIds },
          status: 'DRAFT' as const,
        })),
      });
      await writeUsages(tx, id, [input.assetId, input.templateId]);
    });
    await act(req, 'updated', id);
    return { campaign: await toDTO(app, await load(id)) };
  });

  app.delete('/campaigns/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const c = await load(id);
    if (!['DRAFT', 'CANCELLED'].includes(c.status)) {
      throw new AppError(
        409,
        'CANNOT_DELETE',
        'Apenas rascunhos e campanhas canceladas podem ser excluídos.',
      );
    }
    await prisma.campaign.delete({ where: { id } });
    await act(req, 'deleted', id, { name: c.name });
    return { ok: true };
  });

  app.post('/campaigns/:id/duplicate', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const c = await load(id);
    const copy = await prisma.campaign.create({
      data: {
        name: `${c.name} (cópia)`.slice(0, 120),
        body: c.body,
        linkUrl: c.linkUrl,
        assetId: c.assetId,
        status: 'DRAFT',
        accounts: {
          create: c.accounts.map((a) => ({
            accountId: a.accountId,
            audience: a.audience ?? {},
            status: 'DRAFT' as const,
          })),
        },
      },
    });
    if (c.assetId)
      await prisma.assetUsage.create({ data: { assetId: c.assetId, campaignId: copy.id } });
    await act(req, 'duplicated', copy.id, { from: id });
    reply.code(201);
    return { campaign: await toDTO(app, await load(copy.id)) };
  });

  // ─── Agendamento e controle ───────────────────────────────────────────────

  const transition = async (
    id: string,
    from: CampaignDTO['status'][],
    data: Prisma.CampaignUpdateManyMutationInput,
    message: string,
  ) => {
    const r = await prisma.campaign.updateMany({ where: { id, status: { in: from } }, data });
    if (!r.count) throw new AppError(409, 'INVALID_STATE', message);
  };

  app.post('/campaigns/:id/schedule', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    await load(id);
    const { scheduledAt } = parse(scheduleSchema, req.body);
    await transition(
      id,
      ['DRAFT', 'SCHEDULED'],
      { status: 'SCHEDULED', scheduledAt },
      'Somente rascunhos ou campanhas agendadas podem ser (re)agendadas.',
    );
    await prisma.campaignAccount.updateMany({
      where: { campaignId: id },
      data: { status: 'SCHEDULED' },
    });
    await act(req, 'scheduled', id, { scheduledAt: scheduledAt.toISOString() });
    return { campaign: await toDTO(app, await load(id)) };
  });

  /** Monta a fila agora (nenhuma mensagem é enviada). */
  app.post('/campaigns/:id/prepare', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await load(id);
    if (!app.campaignQueue)
      throw new AppError(503, 'QUEUE_UNAVAILABLE', 'Fila de processamento indisponível.');
    await transition(
      id,
      ['DRAFT', 'SCHEDULED'],
      { status: 'SCHEDULED', scheduledAt: new Date() },
      'A campanha já foi preparada.',
    );
    await prisma.campaignAccount.updateMany({
      where: { campaignId: id },
      data: { status: 'SCHEDULED' },
    });
    await app.campaignQueue.prepareNow(id);
    await act(req, 'prepare_requested', id);
    reply.code(202);
    return { ok: true };
  });

  app.post('/campaigns/:id/unschedule', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    await transition(
      id,
      ['SCHEDULED'],
      { status: 'DRAFT', scheduledAt: null },
      'A campanha não está agendada.',
    );
    await prisma.campaignAccount.updateMany({
      where: { campaignId: id },
      data: { status: 'DRAFT' },
    });
    await act(req, 'unscheduled', id);
    return { campaign: await toDTO(app, await load(id)) };
  });

  app.post('/campaigns/:id/pause', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    await transition(
      id,
      ['READY', 'RUNNING'],
      { status: 'PAUSED' },
      'Somente campanhas em andamento podem ser pausadas.',
    );
    await prisma.campaignAccount.updateMany({
      where: { campaignId: id, status: { in: ['READY', 'RUNNING'] } },
      data: { status: 'PAUSED' },
    });
    await act(req, 'paused', id);
    return { campaign: await toDTO(app, await load(id)) };
  });

  app.post('/campaigns/:id/resume', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const c = await load(id);
    const status = c.startedAt ? 'RUNNING' : 'READY';
    await transition(id, ['PAUSED'], { status }, 'A campanha não está pausada.');
    await prisma.campaignAccount.updateMany({
      where: { campaignId: id, status: 'PAUSED' },
      data: { status },
    });
    for (const child of c.accounts) await refreshCampaignProgress(prisma, child.id);
    await act(req, 'resumed', id);
    return { campaign: await toDTO(app, await load(id)) };
  });

  app.post('/campaigns/:id/cancel', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    await transition(
      id,
      ['DRAFT', 'SCHEDULED', 'READY', 'RUNNING', 'PAUSED'],
      { status: 'CANCELLED', cancelledAt: new Date() },
      'A campanha já foi encerrada.',
    );
    await prisma.campaignAccount.updateMany({
      where: { campaignId: id, status: { notIn: ['COMPLETED'] } },
      data: { status: 'CANCELLED' },
    });
    // Destinatários ainda não enviados deixam a fila.
    await prisma.campaignRecipient.updateMany({
      where: { campaignAccount: { campaignId: id }, status: 'PENDING' },
      data: { status: 'SKIPPED', error: 'Campanha cancelada.', confirmedAt: null },
    });
    await act(req, 'cancelled', id);
    return { campaign: await toDTO(app, await load(id)) };
  });

  // ─── Destinatários e envio assistido ──────────────────────────────────────

  app.get('/campaigns/:id/recipients', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const q = parse(
      z.object({
        accountId: z.string().uuid().optional(),
        status: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req.query,
    );
    const where: Prisma.CampaignRecipientWhereInput = {
      campaignAccount: { campaignId: id },
      ...(q.accountId && { accountId: q.accountId }),
      ...(q.status && { status: { in: q.status.split(',') as RecipientDTO['status'][] as never } }),
    };
    const [rows, total] = await Promise.all([
      prisma.campaignRecipient.findMany({
        where,
        include: { contact: { select: { name: true } } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.campaignRecipient.count({ where }),
    ]);
    const items: RecipientDTO[] = rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      contactId: r.contactId,
      name: r.contact.name,
      phoneE164: r.phoneE164,
      status: r.status === 'PENDING' && r.confirmedAt ? 'SENDING' : r.status,
      error: r.error,
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      sentAt: r.sentAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
    }));
    return { items, total };
  });

  /**
   * Próximo destinatário da fila de uma instância, com a mensagem já
   * personalizada. Quem deixou de ser elegível é pulado automaticamente.
   */
  app.get('/campaigns/:id/next', auth, async (req): Promise<NextRecipientDTO> => {
    const { id } = parse(idParams, req.params);
    const { accountId } = parse(z.object({ accountId: z.string().uuid() }), req.query);
    const c = await load(id);
    const child = c.accounts.find((a) => a.accountId === accountId);
    if (!child) throw Errors.notFound('Instância não faz parte desta campanha.');
    let autoSkipped = 0;
    for (;;) {
      const r = await prisma.campaignRecipient.findFirst({
        where: { campaignAccountId: child.id, status: 'PENDING', confirmedAt: null },
        include: { contact: true },
        // Ordem estável e previsível da fila: nome do contato, depois telefone.
        orderBy: [{ contact: { name: 'asc' } }, { phoneE164: 'asc' }],
      });
      const remaining = await prisma.campaignRecipient.count({
        where: { campaignAccountId: child.id, status: 'PENDING', confirmedAt: null },
      });
      if (!r) return { recipient: null, remaining: 0, autoSkipped };
      const optOut = await prisma.optOut.findUnique({
        where: { accountId_phoneE164: { accountId, phoneE164: r.contact.phoneE164 } },
      });
      if (r.contact.consentStatus !== 'GRANTED' || r.contact.optedOutAt || optOut) {
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: {
            status: 'SKIPPED',
            error:
              r.contact.consentStatus !== 'GRANTED'
                ? 'Consentimento não está autorizado.'
                : 'Contato descadastrado.',
          },
        });
        autoSkipped++;
        await refreshCampaignProgress(prisma, child.id);
        continue;
      }
      return {
        recipient: {
          id: r.id,
          contactId: r.contactId,
          name: r.contact.name,
          phoneE164: r.contact.phoneE164,
          message: buildCampaignMessage(
            { body: child.body ?? c.body ?? '', linkUrl: child.linkUrl ?? c.linkUrl },
            r.contact,
          ),
        },
        remaining,
        autoSkipped,
      };
    }
  });

  const loadRecipient = async (req: FastifyRequest) => {
    const { id, rid } = parse(recipientParams, req.params);
    const r = await prisma.campaignRecipient.findFirst({
      where: { id: rid, campaignAccount: { campaignId: id } },
      include: { campaignAccount: { include: { campaign: true, account: true } } },
    });
    if (!r) throw Errors.notFound('Destinatário não encontrado.');
    return r;
  };

  /** Confirmação explícita de UM envio pelo administrador. */
  app.post('/campaigns/:id/recipients/:rid/send', auth, async (req, reply) => {
    const r = await loadRecipient(req);
    const child = r.campaignAccount;
    if (
      !['READY', 'RUNNING'].includes(child.campaign.status) ||
      !['READY', 'RUNNING'].includes(child.status)
    ) {
      throw new AppError(
        409,
        'CAMPAIGN_NOT_ACTIVE',
        'A campanha não está ativa (pausada, agendada ou encerrada).',
      );
    }
    const paused = await prisma.systemSetting.findUnique({
      where: { key: SETTING_KEYS.operationsPaused },
    });
    if (paused?.value === true)
      throw new AppError(409, 'OPERATIONS_PAUSED', 'As operações estão pausadas globalmente.');
    if (child.account.status !== 'CONNECTED') {
      throw new AppError(
        409,
        'ACCOUNT_NOT_CONNECTED',
        `A instância "${child.account.name}" não está conectada.`,
      );
    }
    if (!app.gateway || !(await app.gateway.isAlive())) {
      throw new AppError(
        503,
        'GATEWAY_UNAVAILABLE',
        'O serviço de conexões está indisponível no momento.',
      );
    }
    // Transição atômica: um destinatário só pode ser confirmado uma vez.
    const claimed = await prisma.campaignRecipient.updateMany({
      where: { id: r.id, status: 'PENDING', confirmedAt: null },
      data: { confirmedAt: new Date(), error: null },
    });
    if (!claimed.count)
      throw new AppError(409, 'ALREADY_CONFIRMED', 'Este envio já foi confirmado ou processado.');
    await app.gateway.send({
      type: 'send-campaign-message',
      accountId: r.accountId,
      recipientId: r.id,
    });
    await audit(prisma, req, {
      action: 'campaign.message_confirmed',
      actorId: req.auth!.user.id,
      entityType: 'campaign_recipient',
      entityId: r.id,
      accountId: r.accountId,
      details: { campaignId: child.campaignId },
    });
    reply.code(202);
    return { ok: true };
  });

  app.post('/campaigns/:id/recipients/:rid/skip', auth, async (req) => {
    const r = await loadRecipient(req);
    const { reason } = parse(
      z.object({ reason: z.string().trim().max(200).optional() }),
      req.body ?? {},
    );
    const done = await prisma.campaignRecipient.updateMany({
      where: { id: r.id, status: 'PENDING', confirmedAt: null },
      data: { status: 'SKIPPED', error: reason || 'Pulado pelo administrador.' },
    });
    if (!done.count)
      throw new AppError(409, 'INVALID_STATE', 'Este destinatário não está aguardando envio.');
    await refreshCampaignProgress(prisma, r.campaignAccountId);
    return { ok: true };
  });

  app.post('/campaigns/:id/recipients/:rid/retry', auth, async (req) => {
    const r = await loadRecipient(req);
    if (!['READY', 'RUNNING', 'COMPLETED'].includes(r.campaignAccount.campaign.status)) {
      throw new AppError(
        409,
        'CAMPAIGN_NOT_ACTIVE',
        'A campanha não permite novas tentativas no estado atual.',
      );
    }
    const done = await prisma.campaignRecipient.updateMany({
      where: { id: r.id, status: 'FAILED' },
      data: { status: 'PENDING', confirmedAt: null, error: null },
    });
    if (!done.count)
      throw new AppError(
        409,
        'INVALID_STATE',
        'Somente envios com falha podem ser tentados novamente.',
      );
    // Reabre a campanha concluída para permitir o novo envio.
    if (r.campaignAccount.status === 'COMPLETED')
      await prisma.campaignAccount.update({
        where: { id: r.campaignAccountId },
        data: { status: 'RUNNING' },
      });
    if (r.campaignAccount.campaign.status === 'COMPLETED') {
      await prisma.campaign.update({
        where: { id: r.campaignAccount.campaignId },
        data: { status: 'RUNNING', completedAt: null },
      });
    }
    return { ok: true };
  });
}

export type { CampaignInput };
