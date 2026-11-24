import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __multizapPrisma?: PrismaClient };

/** Instância única do Prisma por processo. */
export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__multizapPrisma) {
    globalForPrisma.__multizapPrisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return globalForPrisma.__multizapPrisma;
}

export function createPrisma(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}
