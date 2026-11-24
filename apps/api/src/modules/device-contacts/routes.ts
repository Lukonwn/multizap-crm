import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@multizap/database';
import { requireAccount } from '../../lib/accounts';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
const importBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

/**
 * Agenda do aparelho conectado: nomes e telefones que o WhatsApp entregou à sessão
 * (wa_identities). É só consulta: nada vira contato do CRM sem o administrador
 * escolher e confirmar, e o consentimento fica sempre PENDENTE.
 */
export async function deviceContactRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  app.get('/accounts/:accountId/device-contacts', auth, async (req) => {
    const account = await requireAccount(app, req);
    const q = parse(listQuery, req.query);
    const digits = q.q?.replace(/\D/g, '') ?? '';
    const where: Prisma.WaIdentityWhereInput = {
      accountId: account.id,
      ...(q.q && {
        OR: [
          { savedName: { contains: q.q, mode: 'insensitive' } },
          { pushName: { contains: q.q, mode: 'insensitive' } },
          { verifiedName: { contains: q.q, mode: 'insensitive' } },
          ...(digits.length >= 3 ? [{ phoneE164: { contains: digits } }] : []),
        ],
      }),
    };
    const [rows, total, all, withPhone, withSavedName] = await Promise.all([
      prisma.waIdentity.findMany({
        where,
        orderBy: [
          { savedName: { sort: 'asc', nulls: 'last' } },
          { pushName: 'asc' },
          { id: 'asc' },
        ],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.waIdentity.count({ where }),
      prisma.waIdentity.count({ where: { accountId: account.id } }),
      prisma.waIdentity.count({ where: { accountId: account.id, phoneE164: { not: null } } }),
      prisma.waIdentity.count({ where: { accountId: account.id, savedName: { not: null } } }),
    ]);
    const phones = rows.map((r) => r.phoneE164).filter((p): p is string => !!p);
    const inCrm = new Set(
      (
        await prisma.contact.findMany({
          where: { accountId: account.id, phoneE164: { in: phones } },
          select: { phoneE164: true },
        })
      ).map((c) => c.phoneE164),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.savedName ?? r.verifiedName ?? r.pushName,
        savedName: r.savedName,
        pushName: r.pushName,
        phoneE164: r.phoneE164,
        inCrm: !!r.phoneE164 && inCrm.has(r.phoneE164),
      })),
      total,
      stats: { identities: all, withPhone, withSavedName },
    };
  });

  /** Importa para Contatos os itens escolhidos (consentimento pendente; descadastrados continuam descadastrados). */
  app.post('/accounts/:accountId/device-contacts/import', auth, async (req) => {
    const account = await requireAccount(app, req);
    const { ids } = parse(importBody, req.body);
    const rows = await prisma.waIdentity.findMany({
      where: { accountId: account.id, id: { in: ids } },
    });
    const withPhone = rows.filter((r) => r.phoneE164);
    const phones = withPhone.map((r) => r.phoneE164!);
    const [existing, optOuts] = await Promise.all([
      prisma.contact.findMany({
        where: { accountId: account.id, phoneE164: { in: phones } },
        select: { phoneE164: true },
      }),
      prisma.optOut.findMany({
        where: { accountId: account.id, phoneE164: { in: phones } },
        select: { phoneE164: true, createdAt: true },
      }),
    ]);
    const have = new Set(existing.map((c) => c.phoneE164));
    const out = new Map(optOuts.map((o) => [o.phoneE164, o.createdAt]));
    const fresh = withPhone.filter((r) => !have.has(r.phoneE164!));
    if (fresh.length) {
      await prisma.contact.createMany({
        skipDuplicates: true,
        data: fresh.map((r) => {
          const optedOutAt = out.get(r.phoneE164!) ?? null;
          return {
            accountId: account.id,
            phoneE164: r.phoneE164!,
            name: (r.savedName ?? r.verifiedName ?? r.pushName)?.slice(0, 120) ?? null,
            origin: 'OTHER' as const,
            originDetail: 'Agenda do aparelho conectado',
            consentStatus: optedOutAt ? ('REVOKED' as const) : ('PENDING' as const),
            optedOutAt,
          };
        }),
      });
    }
    await audit(prisma, req, {
      action: 'contact.imported_from_device',
      actorId: req.auth!.user.id,
      entityType: 'account',
      entityId: account.id,
      accountId: account.id,
      details: { selected: ids.length, created: fresh.length },
    });
    return {
      created: fresh.length,
      alreadyInCrm: withPhone.length - fresh.length,
      withoutPhone: rows.length - withPhone.length,
    };
  });
}
