import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CredentialCipher } from '@multizap/shared/crypto';
import { DbAuthStore } from '../src/whatsapp/auth-store';
import { blobKeyVersion, reencryptCredentials } from '../src/reencrypt';
import { resetDb, testPrisma } from './helpers';

const prisma = testPrisma();
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDb(prisma));

describe('rotação da chave das credenciais', () => {
  it('recriptografa com a chave nova e a sessão continua legível', async () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const v1 = new CredentialCipher(new Map([[1, k1]]), 1);
    const accountId = (
      await prisma.account.create({ data: { name: 'A', connectionType: 'WHATSAPP_WEB' } })
    ).id;
    const s1 = await new DbAuthStore(prisma, v1).load(accountId);
    await s1.saveCreds();
    await s1.state.keys.set({
      'pre-key': { '1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } },
    });
    const original = (await new DbAuthStore(prisma, v1).load(accountId)).state.creds.noiseKey;

    // chave nova (v2) com a antiga ainda disponível como V1
    const v2 = new CredentialCipher(
      new Map([
        [1, k1],
        [2, k2],
      ]),
      2,
    );
    const r = await reencryptCredentials(prisma, v2);
    expect(r).toEqual({ updated: 2, current: 0, unreadable: 0 });
    const integ = await prisma.integration.findUniqueOrThrow({ where: { accountId } });
    expect(blobKeyVersion(integ.credentialsEnc!)).toBe(2);
    expect(integ.keyVersion).toBe(2);

    // depois disso, só a chave nova basta
    const only2 = new CredentialCipher(new Map([[2, k2]]), 2);
    const reloaded = await new DbAuthStore(prisma, only2).load(accountId);
    expect(
      Buffer.from(reloaded.state.creds.noiseKey.private).equals(Buffer.from(original.private)),
    ).toBe(true);
    const keys = await reloaded.state.keys.get('pre-key', ['1']);
    expect([...keys['1']!.private]).toEqual([2]);

    // idempotente
    expect(await reencryptCredentials(prisma, v2)).toEqual({
      updated: 0,
      current: 2,
      unreadable: 0,
    });
  });

  it('registros com chave ausente são mantidos e contados como ilegíveis', async () => {
    const v1 = new CredentialCipher(new Map([[1, randomBytes(32)]]), 1);
    const accountId = (
      await prisma.account.create({ data: { name: 'A', connectionType: 'WHATSAPP_WEB' } })
    ).id;
    await (await new DbAuthStore(prisma, v1).load(accountId)).saveCreds();
    const before = (await prisma.integration.findUniqueOrThrow({ where: { accountId } }))
      .credentialsEnc;
    const r = await reencryptCredentials(
      prisma,
      new CredentialCipher(new Map([[2, randomBytes(32)]]), 2),
    );
    expect(r.unreadable).toBe(1);
    const after = (await prisma.integration.findUniqueOrThrow({ where: { accountId } }))
      .credentialsEnc;
    expect(Buffer.from(after!).equals(Buffer.from(before!))).toBe(true);
  });
});
