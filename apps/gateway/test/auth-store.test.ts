import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { proto } from 'baileys';
import { DbAuthStore } from '../src/whatsapp/auth-store';
import { CredentialsUnreadableError } from '../src/session/types';
import { resetDb, testCipher, testPrisma } from './helpers';

const prisma = testPrisma();
const cipher = testCipher();
let accountId: string;

beforeEach(async () => {
  await resetDb(prisma);
  accountId = (await prisma.account.create({ data: { name: 'A', connectionType: 'WHATSAPP_WEB' } }))
    .id;
});
afterAll(() => prisma.$disconnect());

describe('DbAuthStore', () => {
  it('persiste as credenciais criptografadas e as restaura idênticas (sobrevive a reinício)', async () => {
    const store = new DbAuthStore(prisma, cipher);
    const first = await store.load(accountId);
    first.state.creds.me = { id: '5511987654321:1@s.whatsapp.net', name: 'Teste' };
    await first.saveCreds();

    const row = await prisma.integration.findUniqueOrThrow({ where: { accountId } });
    const raw = Buffer.from(row.credentialsEnc!).toString('latin1');
    expect(raw).not.toContain('5511987654321');
    expect(raw).not.toContain('noiseKey');

    // "reinício": nova instância do store lendo do banco
    const again = await new DbAuthStore(prisma, cipher).load(accountId);
    expect(again.state.creds.me?.id).toBe('5511987654321:1@s.whatsapp.net');
    expect(
      Buffer.from(again.state.creds.noiseKey.private).equals(
        Buffer.from(first.state.creds.noiseKey.private),
      ),
    ).toBe(true);
    expect(again.state.creds.registrationId).toBe(first.state.creds.registrationId);
  });

  it('grava, lê e remove chaves de sinalização (incluindo app-state-sync-key)', async () => {
    const { state } = await new DbAuthStore(prisma, cipher).load(accountId);
    await state.keys.set({
      'pre-key': { '1': { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } },
      session: { 'abc.0': Buffer.from('sessao') },
      'app-state-sync-key': {
        k1: { keyData: Buffer.from([9, 9]), timestamp: 1 } as proto.Message.IAppStateSyncKeyData,
      },
    });

    const reloaded = (await new DbAuthStore(prisma, cipher).load(accountId)).state;
    const preKeys = await reloaded.keys.get('pre-key', ['1', '2']);
    expect(Buffer.from(preKeys['1']!.private).equals(Buffer.from([4, 5, 6]))).toBe(true);
    expect(preKeys['2']).toBeUndefined();
    const sessions = await reloaded.keys.get('session', ['abc.0']);
    expect(Buffer.from(sessions['abc.0']!).toString()).toBe('sessao');
    const sync = await reloaded.keys.get('app-state-sync-key', ['k1']);
    expect(sync['k1']).toBeInstanceOf(proto.Message.AppStateSyncKeyData);

    await reloaded.keys.set({ 'pre-key': { '1': null } });
    expect(await reloaded.keys.get('pre-key', ['1'])).toEqual({});

    const stored = await prisma.integrationKey.findMany({ where: { accountId } });
    for (const k of stored)
      expect(Buffer.from(k.valueEnc).toString('latin1')).not.toContain('sessao');
  });

  it('não permite ler credenciais de uma instância com os dados de outra (AAD)', async () => {
    const store = new DbAuthStore(prisma, cipher);
    const a = await store.load(accountId);
    await a.saveCreds();
    const other = await prisma.account.create({
      data: { name: 'B', connectionType: 'WHATSAPP_WEB' },
    });
    const row = await prisma.integration.findUniqueOrThrow({ where: { accountId } });
    await prisma.integration.create({
      data: { accountId: other.id, provider: 'whatsapp-web', credentialsEnc: row.credentialsEnc },
    });
    await expect(store.load(other.id)).rejects.toThrow();
  });

  it('chave diferente: erro específico de credenciais ilegíveis (sem apagar nada)', async () => {
    await (await new DbAuthStore(prisma, cipher).load(accountId)).saveCreds();
    const err = await new DbAuthStore(prisma, testCipher())
      .load(accountId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialsUnreadableError);
    expect(
      (await prisma.integration.findUniqueOrThrow({ where: { accountId } })).credentialsEnc,
    ).not.toBeNull();
  });

  it('clear apaga credenciais e chaves', async () => {
    const store = new DbAuthStore(prisma, cipher);
    const { state, saveCreds } = await store.load(accountId);
    await saveCreds();
    await state.keys.set({ session: { x: Buffer.from('1') } });
    await prisma.integration.update({ where: { accountId }, data: { pairedAt: new Date() } });
    await store.clear(accountId);
    const row = await prisma.integration.findUniqueOrThrow({ where: { accountId } });
    expect(row.credentialsEnc).toBeNull();
    expect(row.pairedAt).toBeNull();
    expect(await prisma.integrationKey.count({ where: { accountId } })).toBe(0);
  });
});
