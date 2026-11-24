import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Errors } from './errors';
import { parse } from './validate';

const accountParams = z.object({ accountId: z.string().uuid('Instância inválida.') }).passthrough();

/**
 * Verificação de propriedade: todo recurso de contatos/importações é acessado
 * por /accounts/:accountId/... e consultado SEMPRE com esse accountId.
 */
export async function requireAccount(app: FastifyInstance, req: FastifyRequest) {
  const { accountId } = parse(accountParams, req.params);
  const account = await app.prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, name: true },
  });
  if (!account) throw Errors.notFound('Instância não encontrada.');
  return account;
}
