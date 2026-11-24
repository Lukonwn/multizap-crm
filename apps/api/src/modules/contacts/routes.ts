import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@multizap/database';
import { writerToStream } from '@multizap/files';
import {
  CONSENT_LABEL,
  ORIGIN_LABEL,
  consentActionSchema,
  contactListQuerySchema,
  createContactSchema,
  optOutSchema,
  resubscribeSchema,
  tagSchema,
  updateContactSchema,
  type ContactHistoryItem,
} from '@multizap/shared';
import { requireAccount } from '../../lib/accounts';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';
import { contactInclude, toContactDTO, toTagDTO } from './dto';

const contactParams = z.object({
  accountId: z.string().uuid(),
  id: z.string().uuid('Contato inválido.'),
});
const tagParams = z.object({
  accountId: z.string().uuid(),
  tagId: z.string().uuid('Etiqueta inválida.'),
});

const AUDIT_TITLES: Record<string, string> = {
  'contact.created': 'Contato cadastrado',
  'contact.updated': 'Dados alterados',
  'contact.opted_out': 'Descadastrado',
  'contact.resubscribed': 'Descadastramento revertido',
};

function buildWhere(
  accountId: string,
  q: z.infer<typeof contactListQuerySchema>,
): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = { accountId };
  if (q.q) {
    const digits = q.q.replace(/\D/g, '');
    where.OR = [
      { name: { contains: q.q, mode: 'insensitive' } },
      ...(digits.length >= 3 ? [{ phoneE164: { contains: digits } }] : []),
    ];
  }
  if (q.tagId) where.tags = { some: { tagId: q.tagId } };
  if (q.consent) where.consentStatus = q.consent;
  if (q.optedOut === 'true') where.optedOutAt = { not: null };
  if (q.optedOut === 'false') where.optedOutAt = null;
  if (q.origin) where.origin = q.origin;
  return where;
}

export async function contactRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  /** Garante que as etiquetas informadas pertencem à instância. */
  const assertTags = async (accountId: string, tagIds: string[]) => {
    if (!tagIds.length) return;
    const count = await prisma.tag.count({ where: { accountId, id: { in: tagIds } } });
    if (count !== new Set(tagIds).size)
      throw new AppError(400, 'INVALID_TAGS', 'Etiqueta não encontrada nesta instância.');
  };

  const loadContact = async (req: FastifyRequest) => {
    const account = await requireAccount(app, req);
    const { id } = parse(contactParams, req.params);
    const contact = await prisma.contact.findFirst({
      where: { id, accountId: account.id },
      include: contactInclude,
    });
    if (!contact) throw Errors.notFound('Contato não encontrado.');
    return { account, contact };
  };

  // ─── Etiquetas ────────────────────────────────────────────────────────────

  app.get('/accounts/:accountId/tags', auth, async (req) => {
    const account = await requireAccount(app, req);
    const tags = await prisma.tag.findMany({
      where: { accountId: account.id },
      include: { _count: { select: { contacts: true } } },
      orderBy: { name: 'asc' },
    });
    return { items: tags.map(toTagDTO) };
  });

  app.post('/accounts/:accountId/tags', auth, async (req, reply) => {
    const account = await requireAccount(app, req);
    const input = parse(tagSchema, req.body);
    const exists = await prisma.tag.findUnique({
      where: { accountId_name: { accountId: account.id, name: input.name } },
    });
    if (exists) throw new AppError(409, 'TAG_EXISTS', 'Já existe uma etiqueta com esse nome.');
    const tag = await prisma.tag.create({ data: { accountId: account.id, ...input } });
    reply.code(201);
    return { tag: toTagDTO(tag) };
  });

  app.patch('/accounts/:accountId/tags/:tagId', auth, async (req) => {
    const account = await requireAccount(app, req);
    const { tagId } = parse(tagParams, req.params);
    const input = parse(tagSchema.partial(), req.body);
    const tag = await prisma.tag.findFirst({ where: { id: tagId, accountId: account.id } });
    if (!tag) throw Errors.notFound('Etiqueta não encontrada.');
    if (input.name && input.name !== tag.name) {
      const dup = await prisma.tag.findUnique({
        where: { accountId_name: { accountId: account.id, name: input.name } },
      });
      if (dup) throw new AppError(409, 'TAG_EXISTS', 'Já existe uma etiqueta com esse nome.');
    }
    return { tag: toTagDTO(await prisma.tag.update({ where: { id: tag.id }, data: input })) };
  });

  app.delete('/accounts/:accountId/tags/:tagId', auth, async (req) => {
    const account = await requireAccount(app, req);
    const { tagId } = parse(tagParams, req.params);
    const r = await prisma.tag.deleteMany({ where: { id: tagId, accountId: account.id } });
    if (!r.count) throw Errors.notFound('Etiqueta não encontrada.');
    return { ok: true };
  });

  // ─── Contatos ─────────────────────────────────────────────────────────────

  app.get('/accounts/:accountId/contacts', auth, async (req) => {
    const account = await requireAccount(app, req);
    const q = parse(contactListQuerySchema, req.query);
    const where = buildWhere(account.id, q);
    const [items, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        include: contactInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.contact.count({ where }),
    ]);
    return { items: items.map(toContactDTO), total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/accounts/:accountId/contacts', auth, async (req, reply) => {
    const account = await requireAccount(app, req);
    const input = parse(createContactSchema, req.body);
    await assertTags(account.id, input.tagIds);
    const dup = await prisma.contact.findUnique({
      where: { accountId_phoneE164: { accountId: account.id, phoneE164: input.phone } },
    });
    if (dup) {
      throw new AppError(
        409,
        'CONTACT_EXISTS',
        'Este telefone já está cadastrado nesta instância.',
        { phone: ['Telefone já cadastrado nesta instância.'] },
      );
    }
    const optedOut = await prisma.optOut.findUnique({
      where: { accountId_phoneE164: { accountId: account.id, phoneE164: input.phone } },
    });
    const contact = await prisma.$transaction(async (tx) => {
      const c = await tx.contact.create({
        data: {
          accountId: account.id,
          phoneE164: input.phone,
          name: input.name,
          notes: input.notes,
          origin: 'MANUAL',
          // Um descadastramento anterior prevalece sobre qualquer consentimento informado.
          optedOutAt: optedOut ? optedOut.createdAt : null,
          consentStatus: optedOut ? 'REVOKED' : input.consent ? 'GRANTED' : 'PENDING',
          consentAt: !optedOut && input.consent ? new Date() : null,
          tags: { create: input.tagIds.map((tagId) => ({ tagId })) },
        },
        include: contactInclude,
      });
      if (input.consent && !optedOut) {
        await tx.consentEvent.create({
          data: {
            accountId: account.id,
            contactId: c.id,
            action: 'GRANTED',
            source: input.consent.source,
            evidence: input.consent.evidence,
          },
        });
      }
      return c;
    });
    await audit(prisma, req, {
      action: 'contact.created',
      actorId: req.auth!.user.id,
      entityType: 'contact',
      entityId: contact.id,
      accountId: account.id,
    });
    reply.code(201);
    return {
      contact: toContactDTO(contact),
      warning: optedOut
        ? 'Este telefone está descadastrado nesta instância e permanecerá excluído de campanhas.'
        : null,
    };
  });

  app.get('/accounts/:accountId/contacts/export', auth, async (req, reply) => {
    const account = await requireAccount(app, req);
    const { format, ...filters } = parse(
      contactListQuerySchema
        .omit({ page: true, pageSize: true })
        .extend({ format: z.enum(['csv', 'xlsx']).default('csv') }),
      req.query,
    );
    const where = buildWhere(account.id, { ...filters, page: 1, pageSize: 1 });
    const { writer, stream } = writerToStream(format);
    const date = new Date().toISOString().slice(0, 10);
    const safeName = account.name
      .normalize('NFD')
      .replace(/[^\w-]+/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase();
    reply
      .header(
        'content-type',
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8',
      )
      .header(
        'content-disposition',
        `attachment; filename="contatos-${safeName}-${date}.${format}"`,
      )
      .header('cache-control', 'no-store');

    void (async () => {
      try {
        await writer.write([
          'nome',
          'telefone',
          'origem',
          'consentimento',
          'data_autorizacao',
          'descadastrado_em',
          'etiquetas',
          'observacoes',
          'criado_em',
        ]);
        let cursor: string | undefined;
        for (;;) {
          const batch = await prisma.contact.findMany({
            where,
            include: contactInclude,
            orderBy: { id: 'asc' },
            take: 1000,
            ...(cursor && { cursor: { id: cursor }, skip: 1 }),
          });
          if (!batch.length) break;
          for (const c of batch) {
            await writer.write([
              c.name,
              c.phoneE164,
              ORIGIN_LABEL[c.origin],
              CONSENT_LABEL[c.consentStatus],
              c.consentAt?.toISOString() ?? '',
              c.optedOutAt?.toISOString() ?? '',
              c.tags.map((t) => t.tag.name).join(', '),
              c.notes,
              c.createdAt.toISOString(),
            ]);
          }
          cursor = batch[batch.length - 1]!.id;
        }
        await writer.end();
      } catch (err) {
        req.log.error({ err }, 'Falha na exportação');
        stream.destroy(err as Error);
      }
    })();
    await audit(prisma, req, {
      action: 'contact.exported',
      actorId: req.auth!.user.id,
      accountId: account.id,
      details: { format },
    });
    return reply.send(stream);
  });

  app.get('/accounts/:accountId/contacts/:id', auth, async (req) => {
    const { contact } = await loadContact(req);
    return { contact: toContactDTO(contact) };
  });

  app.patch('/accounts/:accountId/contacts/:id', auth, async (req) => {
    const { account, contact } = await loadContact(req);
    const input = parse(updateContactSchema, req.body);
    const has = (k: string) =>
      typeof req.body === 'object' && req.body !== null && Object.hasOwn(req.body, k);
    if (input.tagIds) await assertTags(account.id, input.tagIds);
    const updated = await prisma.$transaction(async (tx) => {
      if (input.tagIds) {
        await tx.contactTag.deleteMany({ where: { contactId: contact.id } });
        await tx.contactTag.createMany({
          data: input.tagIds.map((tagId) => ({ contactId: contact.id, tagId })),
          skipDuplicates: true,
        });
      }
      return tx.contact.update({
        where: { id: contact.id },
        data: {
          // Só altera os campos enviados (ausente ≠ apagar).
          ...(has('name') ? { name: input.name } : {}),
          ...(has('notes') ? { notes: input.notes } : {}),
        },
        include: contactInclude,
      });
    });
    await audit(prisma, req, {
      action: 'contact.updated',
      actorId: req.auth!.user.id,
      entityType: 'contact',
      entityId: contact.id,
      accountId: account.id,
    });
    return { contact: toContactDTO(updated) };
  });

  app.delete('/accounts/:accountId/contacts/:id', auth, async (req) => {
    const { account, contact } = await loadContact(req);
    await prisma.contact.delete({ where: { id: contact.id } });
    // O registro de descadastramento (por telefone) permanece e impede reinclusão.
    await audit(prisma, req, {
      action: 'contact.deleted',
      actorId: req.auth!.user.id,
      entityType: 'contact',
      entityId: contact.id,
      accountId: account.id,
      details: { phone: contact.phoneE164 },
    });
    return { ok: true };
  });

  app.post('/accounts/:accountId/contacts/:id/consent', auth, async (req) => {
    const { account, contact } = await loadContact(req);
    const input = parse(consentActionSchema, req.body);
    if (input.action === 'GRANTED' && contact.optedOutAt) {
      throw new AppError(
        409,
        'OPTED_OUT',
        'Contato descadastrado. Use "Reverter descadastramento" com um novo consentimento documentado.',
      );
    }
    const updated = await prisma.$transaction(async (tx) => {
      await tx.consentEvent.create({
        data: {
          accountId: account.id,
          contactId: contact.id,
          action: input.action,
          source: input.source,
          evidence: input.evidence,
        },
      });
      return tx.contact.update({
        where: { id: contact.id },
        data:
          input.action === 'GRANTED'
            ? { consentStatus: 'GRANTED', consentAt: new Date() }
            : { consentStatus: 'REVOKED' },
        include: contactInclude,
      });
    });
    return { contact: toContactDTO(updated) };
  });

  app.post('/accounts/:accountId/contacts/:id/opt-out', auth, async (req) => {
    const { account, contact } = await loadContact(req);
    const input = parse(optOutSchema, req.body ?? {});
    if (contact.optedOutAt) return { contact: toContactDTO(contact) };
    const updated = await prisma.$transaction(async (tx) => {
      await tx.optOut.upsert({
        where: { accountId_phoneE164: { accountId: account.id, phoneE164: contact.phoneE164 } },
        create: {
          accountId: account.id,
          phoneE164: contact.phoneE164,
          reason: input.reason,
          source: 'admin',
        },
        update: {},
      });
      await tx.consentEvent.create({
        data: {
          accountId: account.id,
          contactId: contact.id,
          action: 'REVOKED',
          source: 'Descadastramento',
          evidence: input.reason,
        },
      });
      return tx.contact.update({
        where: { id: contact.id },
        data: { optedOutAt: new Date(), consentStatus: 'REVOKED' },
        include: contactInclude,
      });
    });
    await audit(prisma, req, {
      action: 'contact.opted_out',
      actorId: req.auth!.user.id,
      entityType: 'contact',
      entityId: contact.id,
      accountId: account.id,
      details: { reason: input.reason },
    });
    return { contact: toContactDTO(updated) };
  });

  app.post('/accounts/:accountId/contacts/:id/resubscribe', auth, async (req) => {
    const { account, contact } = await loadContact(req);
    const input = parse(resubscribeSchema, req.body);
    if (!contact.optedOutAt)
      throw new AppError(409, 'NOT_OPTED_OUT', 'O contato não está descadastrado.');
    const updated = await prisma.$transaction(async (tx) => {
      await tx.optOut.deleteMany({
        where: { accountId: account.id, phoneE164: contact.phoneE164 },
      });
      await tx.consentEvent.create({
        data: {
          accountId: account.id,
          contactId: contact.id,
          action: 'GRANTED',
          source: input.source,
          evidence: input.evidence,
        },
      });
      return tx.contact.update({
        where: { id: contact.id },
        data: { optedOutAt: null, consentStatus: 'GRANTED', consentAt: new Date() },
        include: contactInclude,
      });
    });
    await audit(prisma, req, {
      action: 'contact.resubscribed',
      actorId: req.auth!.user.id,
      entityType: 'contact',
      entityId: contact.id,
      accountId: account.id,
      details: { source: input.source },
    });
    return { contact: toContactDTO(updated) };
  });

  app.get('/accounts/:accountId/contacts/:id/history', auth, async (req) => {
    const { contact } = await loadContact(req);
    const [consents, audits] = await Promise.all([
      prisma.consentEvent.findMany({
        where: { contactId: contact.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.auditLog.findMany({
        where: { entityType: 'contact', entityId: contact.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    const items: ContactHistoryItem[] = [
      ...consents.map((c) => ({
        id: c.id,
        kind: 'consent' as const,
        title: c.action === 'GRANTED' ? 'Consentimento registrado' : 'Consentimento revogado',
        detail: [c.source, c.evidence].filter(Boolean).join(' — ') || null,
        createdAt: c.createdAt.toISOString(),
      })),
      ...audits
        .filter((a) => AUDIT_TITLES[a.action])
        .map((a) => ({
          id: a.id,
          kind: 'audit' as const,
          title: AUDIT_TITLES[a.action]!,
          detail: null,
          createdAt: a.createdAt.toISOString(),
        })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (contact.origin === 'IMPORT' || contact.origin === 'MANUAL') {
      items.push({
        id: `origin-${contact.id}`,
        kind: 'audit',
        title: contact.origin === 'IMPORT' ? 'Importado' : 'Origem: cadastro manual',
        detail: contact.originDetail,
        createdAt: contact.createdAt.toISOString(),
      });
    }
    return { items };
  });
}
