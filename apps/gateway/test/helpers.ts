import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { createPrisma, type PrismaClient } from '@multizap/database';
import { CredentialCipher } from '@multizap/shared/crypto';
import type { ConnEvent, ConnectionFactory, WaConnection } from '../src/session/types';

export function testPrisma(): PrismaClient {
  return createPrisma(process.env.TEST_DATABASE_URL!);
}

export function testRedis(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
}

export function testCipher(): CredentialCipher {
  return new CredentialCipher(new Map([[1, randomBytes(32)]]), 1);
}

export async function resetDb(prisma: PrismaClient) {
  if (!/test/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname))
    throw new Error('Somente banco de testes.');
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
}

export class FakeConn implements WaConnection {
  ended = false;
  loggedOut = false;
  pairingCalls: string[] = [];
  pairingError: Error | null = null;
  async requestPairingCode(phoneDigits: string) {
    this.pairingCalls.push(phoneDigits);
    if (this.pairingError) throw this.pairingError;
    return 'ABCD1234';
  }
  end() {
    this.ended = true;
  }
  async logout() {
    this.loggedOut = true;
  }
  sent: { jid: string; text: string; hasImage: boolean }[] = [];
  sendError: Error | null = null;
  async sendMessage(jid: string, m: { text: string; image?: Buffer }) {
    if (this.sendError) throw this.sendError;
    this.sent.push({ jid, text: m.text, hasImage: !!m.image });
    return { id: `WAMSG${this.sent.length}`, timestamp: Math.floor(Date.now() / 1000) };
  }
}

/** Fábrica controlada pelo teste: cada conexão expõe `emit` para simular o WhatsApp. */
export class FakeFactory implements ConnectionFactory {
  opened: { accountId: string; conn: FakeConn; emit: (e: ConnEvent) => void }[] = [];
  async open(accountId: string, onEvent: (e: ConnEvent) => void) {
    const conn = new FakeConn();
    this.opened.push({ accountId, conn, emit: onEvent });
    return conn;
  }
  last(accountId: string) {
    const all = this.opened.filter((o) => o.accountId === accountId);
    const l = all[all.length - 1];
    if (!l) throw new Error(`nenhuma conexão aberta para ${accountId}`);
    return l;
  }
  count(accountId: string) {
    return this.opened.filter((o) => o.accountId === accountId).length;
  }
}
