import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PROVIDER_CAPABILITIES } from '@multizap/integrations';
import {
  MAX_ACCOUNTS,
  STATUS_REASON,
  confirmByNameSchema,
  createAccountSchema,
  startPairingSchema,
  updateAccountSchema,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';
import { toAccountDTO, toEventDTO } from './dto';

const idParams = z.object({ id: z.string().uuid('Identificador inválido.') });

const capabilitiesOf = (type: 'WHATSAPP_WEB' | 'EXTERNAL_DEVICE') =>
  PROVIDER_CAPABILITIES[type === 'WHATSAPP_WEB' ? 'whatsapp-web' : 'manual'];

export async function accountRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  const load = async (req: FastifyRequest) => {
    const { id } = parse(idParams, req.params);
    const account = await prisma.account.findUnique({
      where: { id },
      include: { integration: true },
    });
    if (!account) throw Errors.notFound('Instância não encontrada.');
    return account;
  };

  const requireGateway = async () => {
    if (!app.gateway)
      throw new AppError(503, 'GATEWAY_UNAVAILABLE', 'Gateway de conexões não configurado.');
    if (!(await app.gateway.isAlive())) {
      throw new AppError(
        503,
        'GATEWAY_UNAVAILABLE',
        'O serviço de conexões está indisponível no momento. Tente novamente em instantes.',
      );
    }
    return app.gateway;
  };

  const confirmName = (req: FastifyRequest, name: string) => {
    const { confirmName } = parse(confirmByNameSchema, req.body ?? {});
    if (confirmName.trim() !== name) {
      throw new AppError(
        400,
        'CONFIRMATION_MISMATCH',
        'Digite exatamente o nome da instância para confirmar.',
      );
    }
  };

  // ─── Listagem e cadastro ───────────────────────────────────────────────────

  app.get('/accounts', auth, async () => {
    const accounts = await prisma.account.findMany({
      include: { integration: true },
      orderBy: { createdAt: 'asc' },
    });
    return { items: accounts.map(toAccountDTO), limit: MAX_ACCOUNTS };
  });

  app.post('/accounts', auth, async (req, reply) => {
    const input = parse(createAccountSchema, req.body);
    const account = await prisma.$transaction(async (tx) => {
      // Serializa cadastros concorrentes para garantir o limite de 10 instâncias.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('multizap:accounts:create'))`;
      const count = await tx.account.count();
      if (count >= MAX_ACCOUNTS) {
        throw new AppError(
          409,
          'ACCOUNT_LIMIT',
          `O limite de ${MAX_ACCOUNTS} instâncias foi atingido.`,
        );
      }
      return tx.account.create({
        data: {
          name: input.name,
          connectionType: input.connectionType,
          phoneE164: input.phone ?? null,
          status: 'NOT_CONFIGURED',
        },
        include: { integration: true },
      });
    });
    await prisma.connectionEvent.create({
      data: { accountId: account.id, type: 'created', message: 'Instância cadastrada.' },
    });
    await audit(prisma, req, {
      action: 'account.created',
      actorId: req.auth!.user.id,
      entityType: 'account',
      entityId: account.id,
      accountId: account.id,
      details: { name: account.name, connectionType: account.connectionType },
    });
    reply.code(201);
    return { account: toAccountDTO(account) };
  });

  app.get('/accounts/:id', auth, async (req) => {
    const account = await load(req);
    return { account: toAccountDTO(account), capabilities: capabilitiesOf(account.connectionType) };
  });

  app.patch('/accounts/:id', auth, async (req) => {
    const account = await load(req);
    const input = parse(updateAccountSchema, req.body);
    if (input.phone !== undefined && account.connectionType === 'WHATSAPP_WEB') {
      throw new AppError(
        400,
        'PHONE_FROM_PAIRING',
        'O número de um dispositivo conectado é definido pelo pareamento.',
      );
    }
    if (input.phone === null && account.connectionType === 'EXTERNAL_DEVICE') {
      throw new AppError(400, 'VALIDATION_ERROR', 'Dados inválidos.', {
        phone: ['Informe o número do aparelho externo.'],
      });
    }
    const updated = await prisma.account.update({
      where: { id: account.id },
      data: { name: input.name, phoneE164: input.phone ?? undefined },
      include: { integration: true },
    });
    await audit(prisma, req, {
      action: 'account.updated',
      actorId: req.auth!.user.id,
      entityType: 'account',
      entityId: account.id,
      accountId: account.id,
      details: { name: input.name, phoneChanged: input.phone !== undefined },
    });
    return { account: toAccountDTO(updated) };
  });

  app.get('/accounts/:id/events', auth, async (req) => {
    const account = await load(req);
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      req.query,
    );
    const events = await prisma.connectionEvent.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return { items: events.map(toEventDTO) };
  });

  // ─── Pareamento ────────────────────────────────────────────────────────────

  app.post('/accounts/:id/pairing', auth, async (req, reply) => {
    const account = await load(req);
    if (!capabilitiesOf(account.connectionType).qrPairing) {
      throw new AppError(
        409,
        'NOT_SUPPORTED',
        'Aparelhos externos cadastrados não suportam pareamento.',
      );
    }
    if (account.disabledAt)
      throw new AppError(409, 'ACCOUNT_DISABLED', 'Reative a instância antes de parear.');
    if (account.status === 'CONNECTED') {
      throw new AppError(
        409,
        'ALREADY_CONNECTED',
        'A instância já está conectada. Remova a conexão antes de parear novamente.',
      );
    }
    const input = parse(startPairingSchema, req.body);
    const gateway = await requireGateway();
    await gateway.setPairing(account.id, {
      kind: 'starting',
      method: input.method,
      at: Date.now(),
    });
    await gateway.send(
      input.method === 'qr'
        ? { type: 'start-pairing', accountId: account.id, method: 'qr' }
        : {
            type: 'start-pairing',
            accountId: account.id,
            method: 'pairing-code',
            phoneE164: input.phone,
          },
    );
    await audit(prisma, req, {
      action: 'account.pairing_requested',
      actorId: req.auth!.user.id,
      entityType: 'account',
      entityId: account.id,
      accountId: account.id,
      details: { method: input.method },
    });
    reply.code(202);
    return { ok: true };
  });

  app.get('/accounts/:id/pairing', auth, async (req) => {
    const account = await load(req);
    const state = app.gateway ? await app.gateway.getPairing(account.id) : null;
    return { state, status: account.status, statusReason: account.statusReason };
  });

  app.delete('/accounts/:id/pairing', auth, async (req) => {
    const account = await load(req);
    const gateway = await requireGateway();
    await gateway.send({ type: 'cancel-pairing', accountId: account.id });
    await gateway.clearPairing(account.id);
    return { ok: true };
  });

  // ─── Operação da conexão ───────────────────────────────────────────────────

  app.post('/accounts/:id/reconnect', auth, async (req, reply) => {
    const account = await load(req);
    if (account.connectionType !== 'WHATSAPP_WEB' || !account.integration?.pairedAt) {
      throw new AppError(
        409,
        'NOT_PAIRED',
        'Esta instância não possui uma sessão pareada para reconectar.',
      );
    }
    if (account.disabledAt)
      throw new AppError(409, 'ACCOUNT_DISABLED', 'Reative a instância antes de reconectar.');
    if (account.status === 'NEEDS_REPAIR') {
      throw new AppError(
        409,
        'NEEDS_REPAIR',
        'A sessão foi encerrada pelo WhatsApp. Faça um novo pareamento.',
      );
    }
    const gateway = await requireGateway();
    await gateway.send({ type: 'reconnect', accountId: account.id });
    await audit(prisma, req, {
      action: 'account.reconnect_requested',
      actorId: req.auth!.user.id,
      entityType: 'account',
      entityId: account.id,
      accountId: account.id,
    });
    reply.code(202);
    return { ok: true };
  });

  app.post('/accounts/:id/disable', auth, async (req) => {
    const account = await load(req);
    if (account.disabledAt) return { account: toAccountDTO(account) };
    const updated = await prisma.account.update({
      where: { id: account.id },
      data: { disabledAt: new Date(), status: 'DISABLED' },
      include: { integration: true },
    });
    if (account.connectionType === 'WHATSAPP_WEB' && app.gateway) {
      await app.gateway.send({ type: 'stop', accountId: account.id });
    }
    await prisma.connectionEvent.create({
      data: {
        accountId: account.id,
        type: 'disabled',
        message: 'Instância desativada. Credenciais preservadas.',
      },
    });
    await audit(prisma, req, {
      action: 'account.disabled',
      actorId: req.auth!.user.id,
      entityType: 'account',
      entityId: account.id,
      accountId: account.id,
    });
    return { account: toAccountDTO(updated) };
  });

  app.post('/accounts/:id/enable', auth, async (req) => {
    const account = await load(req);
    if (!account.disabledAt) return { account: toAccountDTO(account) };
    const paired = !!account.integration?.pairedAt;
    const updated = await prisma.account.update({
      where: { id: account.id },
      data: {
        disabledAt: null,
        status: paired ? 'DISCONNECTED' : 'NOT_CONFIGURED',
        statusReason: null,
      },
      include: { integration: true },
    });
    if (paired && app.gateway && (await app.gateway.isAlive())) {
      await app.gateway.send({ type: 'reconnect', accountId: account.id });
    }
    await prisma.connectionEvent.create({
      data: { accountId: account.id, type: 'enabled', message: 'Instância reativada.' },
    });
    await audit(prisma, req, {
      action: 'account.enabled',
      actorId: req.auth!.user.id,
      entityType: 'account',
      entityId: account.id,
      accountId: account.id,
    });
    return { account: toAccountDTO(updated) };
  });

  /** Remove a conexão (logout + exclusão das credenciais). Exige confirmação pelo nome. */
  app.post('/accounts/:id/remove-connection', auth, async (req, reply) => {
    const account = await load(req);
    confirmName(req, account.name);
    if (account.connectionType !== 'WHATSAPP_WEB') {
      throw new AppError(
        409,
        'NOT_SUPPORTED',
        'Aparelhos externos cadastrados não possuem conexão para remover.',
      );
    }
    const gatewayAlive = !!app.gateway && (await app.gateway.isAlive());
    if (gatewayAlive) {
      await app.gateway!.send({ type: 'remove', accountId: account.id });
    } else {
      // Sem gateway ativo não há socket aberto: apaga as credenciais diretamente.
      await prisma.$transaction([
        prisma.integrationKey.deleteMany({ where: { accountId: account.id } }),
        prisma.integration.updateMany({
          where: { accountId: account.id },
          data: { credentialsEnc: null, pairedAt: null, waJid: null, deviceName: null },
        }),
        prisma.account.update({
          where: { id: account.id },
          data: {
            status: account.disabledAt ? 'DISABLED' : 'NOT_CONFIGURED',
            statusReason: STATUS_REASON.removedByAdmin,
          },
        }),
        prisma.connectionEvent.create({
          data: {
            accountId: account.id,
            type: 'connection_removed',
            message:
              'Credenciais removidas. Remova também o dispositivo em "Aparelhos conectados" no celular.',
          },
        }),
      ]);
    }
    await audit(prisma, req, {
      action: 'account.connection_removed',
      actorId: req.auth!.user.id,
      entityType: 'account',
      entityId: account.id,
      accountId: account.id,
      details: { viaGateway: gatewayAlive },
    });
    reply.code(202);
    return { ok: true };
  });

  /** Exclui a instância e todos os seus dados. Exige confirmação pelo nome. */
  app.delete('/accounts/:id', auth, async (req) => {
    const account = await load(req);
    confirmName(req, account.name);
    if (
      account.connectionType === 'WHATSAPP_WEB' &&
      account.integration?.credentialsEnc &&
      app.gateway &&
      (await app.gateway.isAlive())
    ) {
      // Desvincula no WhatsApp (o gateway usa as credenciais em memória).
      await app.gateway.send({ type: 'remove', accountId: account.id });
    }
    await prisma.account.delete({ where: { id: account.id } });
    await app.gateway?.clearPairing(account.id).catch(() => undefined);
    await audit(prisma, req, {
      action: 'account.deleted',
      actorId: req.auth!.user.id,
      entityType: 'account',
      entityId: account.id,
      details: { name: account.name, connectionType: account.connectionType },
    });
    return { ok: true };
  });
}
