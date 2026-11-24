import { CredentialsUnreadableError } from '../src/session/types';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayKeys, type PairingState } from '@multizap/shared';
import { LockManager } from '../src/session/lock';
import { SessionManager } from '../src/session/manager';
import type { AuthStoreLike } from '../src/session/types';
import { FakeFactory, resetDb, testPrisma, testRedis } from './helpers';

const prisma = testPrisma();
const redis = testRedis();

/** Store simulado: registra limpezas e permite verificar que nada é apagado indevidamente. */
class SpyStore implements AuthStoreLike {
  cleared: string[] = [];
  async clear(accountId: string) {
    this.cleared.push(accountId);
    await prisma.integration.updateMany({
      where: { accountId },
      data: { credentialsEnc: null, pairedAt: null },
    });
  }
}

let factory: FakeFactory;
let store: SpyStore;
let managers: SessionManager[] = [];
let ownerSeq = 0;

function makeManager(opts: { backoffMs?: number[]; owner?: string } = {}) {
  const locks = new LockManager(redis, opts.owner ?? `test-${++ownerSeq}`);
  const m = new SessionManager(prisma, redis, factory, store, locks, {
    backoffMs: opts.backoffMs ?? [20],
  });
  managers.push(m);
  return m;
}

async function account(
  data: {
    paired?: boolean;
    status?: 'CONNECTED' | 'NOT_CONFIGURED' | 'NEEDS_REPAIR' | 'AWAITING_CONNECTION' | 'ATTENTION';
    statusReason?: string;
  } = {},
) {
  const a = await prisma.account.create({
    data: {
      name: 'Instância',
      connectionType: 'WHATSAPP_WEB',
      status: data.status ?? 'NOT_CONFIGURED',
      statusReason: data.statusReason,
    },
  });
  if (data.paired) {
    await prisma.integration.create({
      data: {
        accountId: a.id,
        provider: 'whatsapp-web',
        pairedAt: new Date(),
        credentialsEnc: new Uint8Array([1, 2, 3]),
      },
    });
  }
  return a.id;
}

const status = async (id: string) =>
  (await prisma.account.findUniqueOrThrow({ where: { id } })).status;
const reason = async (id: string) =>
  (await prisma.account.findUniqueOrThrow({ where: { id } })).statusReason;
const pairing = async (id: string) => {
  const v = await redis.get(gatewayKeys.pairing(id));
  return v ? (JSON.parse(v) as PairingState) : null;
};
const eventTypes = async (id: string) =>
  (
    await prisma.connectionEvent.findMany({
      where: { accountId: id },
      orderBy: { createdAt: 'asc' },
    })
  ).map((e) => e.type);

beforeEach(async () => {
  await resetDb(prisma);
  factory = new FakeFactory();
  store = new SpyStore();
  managers = [];
});
afterEach(async () => {
  for (const m of managers) await m.shutdown();
});
afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

describe('pareamento por QR Code', () => {
  it('exibe o QR fornecido pelo WhatsApp e conecta após a leitura', async () => {
    const id = await account();
    const m = makeManager();
    await m.startPairing(id, 'qr');
    expect(await status(id)).toBe('AWAITING_CONNECTION');
    expect(store.cleared).toContain(id); // começa com credenciais limpas

    factory.last(id).emit({ type: 'qr', qr: 'QR-REAL-1' });
    await vi.waitFor(async () => expect((await pairing(id))?.kind).toBe('qr'));
    const qr = (await pairing(id)) as Extract<PairingState, { kind: 'qr' }>;
    expect(qr.qr).toBe('QR-REAL-1');
    expect(qr.expiresAt).toBeGreaterThan(Date.now());

    factory.last(id).emit({ type: 'open', jid: '5511987654321:3@s.whatsapp.net', name: 'Loja' });
    await vi.waitFor(async () => expect(await status(id)).toBe('CONNECTED'));
    const acc = await prisma.account.findUniqueOrThrow({
      where: { id },
      include: { integration: true },
    });
    expect(acc.phoneE164).toBe('+5511987654321');
    expect(acc.integration?.pairedAt).not.toBeNull();
    expect((await pairing(id))?.kind).toBe('connected');
    expect(await eventTypes(id)).toEqual(['pairing_started', 'paired']);
  });

  it('marca como expirado quando o QR não é lido a tempo', async () => {
    const id = await account();
    const m = makeManager();
    await m.startPairing(id, 'qr');
    factory.last(id).emit({ type: 'close', reason: 'qr_timeout' });
    await vi.waitFor(async () => expect((await pairing(id))?.kind).toBe('expired'));
    expect(await status(id)).toBe('NOT_CONFIGURED');
    expect(await reason(id)).toBe('pairing_expired');
    expect(m.hasSession(id)).toBe(false);
  });

  it('reabre a conexão após o "restart required" do WhatsApp e conclui o pareamento', async () => {
    const id = await account();
    const m = makeManager();
    await m.startPairing(id, 'qr');
    factory.last(id).emit({ type: 'qr', qr: 'Q' });
    factory.last(id).emit({ type: 'close', reason: 'restart_required' });
    await vi.waitFor(() => expect(factory.count(id)).toBe(2));
    factory.last(id).emit({ type: 'open', jid: '5511987654321@s.whatsapp.net' });
    await vi.waitFor(async () => expect(await status(id)).toBe('CONNECTED'));
  });

  it('cancelamento encerra o pareamento', async () => {
    const id = await account();
    const m = makeManager();
    await m.startPairing(id, 'qr');
    await m.cancelPairing(id);
    expect(factory.last(id).conn.ended).toBe(true);
    expect(await status(id)).toBe('NOT_CONFIGURED');
    expect(await pairing(id)).toBeNull();
  });
});

describe('pareamento com número de telefone', () => {
  it('solicita o código ao WhatsApp (somente dígitos) e o exibe', async () => {
    const id = await account();
    const m = makeManager();
    await m.startPairing(id, 'pairing-code', '+5511987654321');
    const c = factory.last(id);
    c.emit({ type: 'qr', qr: 'ignorado' });
    await vi.waitFor(async () => expect((await pairing(id))?.kind).toBe('pairing-code'));
    expect(c.conn.pairingCalls).toEqual(['5511987654321']);
    const st = (await pairing(id)) as Extract<PairingState, { kind: 'pairing-code' }>;
    expect(st.code).toBe('ABCD1234');

    // novos QRs não geram outro código
    c.emit({ type: 'qr', qr: 'outro' });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.conn.pairingCalls).toHaveLength(1);
    expect(await eventTypes(id)).toContain('pairing_code_issued');
  });

  it('informa falha quando o WhatsApp não emite o código', async () => {
    const id = await account();
    const m = makeManager();
    await m.startPairing(id, 'pairing-code', '+5511987654321');
    const c = factory.last(id);
    c.conn.pairingError = new Error('rejected');
    c.emit({ type: 'qr', qr: 'x' });
    await vi.waitFor(async () => expect((await pairing(id))?.kind).toBe('failed'));
    expect(await status(id)).toBe('NOT_CONFIGURED');
  });

  it('rejeita telefone inválido sem abrir conexão', async () => {
    const id = await account();
    const m = makeManager();
    await m.startPairing(id, 'pairing-code', '123');
    expect(factory.count(id)).toBe(0);
    expect((await pairing(id))?.kind).toBe('failed');
  });
});

describe('persistência das conexões', () => {
  it('restaura automaticamente as sessões pareadas após reinício do gateway', async () => {
    const id = await account({ paired: true, status: 'CONNECTED' });
    const first = makeManager();
    await first.reconcile();
    factory.last(id).emit({ type: 'open', jid: '5511987654321@s.whatsapp.net' });
    await vi.waitFor(async () => expect(await status(id)).toBe('CONNECTED'));

    // desligamento gracioso: fecha socket SEM logout, credenciais preservadas
    await first.shutdown();
    expect(factory.last(id).conn.ended).toBe(true);
    expect(factory.last(id).conn.loggedOut).toBe(false);
    expect(store.cleared).not.toContain(id);
    const integ = await prisma.integration.findUniqueOrThrow({ where: { accountId: id } });
    expect(integ.pairedAt).not.toBeNull();
    expect(integ.credentialsEnc).not.toBeNull();

    // nova instância do gateway restaura sem novo pareamento
    const second = makeManager();
    await second.reconcile();
    expect(factory.count(id)).toBe(2);
    factory.last(id).emit({ type: 'open', jid: '5511987654321@s.whatsapp.net' });
    await vi.waitFor(async () => expect(await eventTypes(id)).toContain('connected'));
    expect(await status(id)).toBe('CONNECTED');
  });

  it('credenciais ilegíveis (chave trocada): suspende a reconexão, notifica e não apaga nada', async () => {
    const id = await account({ paired: true, status: 'CONNECTED' });
    const open = factory.open.bind(factory);
    let attempts = 0;
    factory.open = async () => {
      attempts++;
      throw new CredentialsUnreadableError('Unsupported state or unable to authenticate data');
    };
    const m = makeManager({ backoffMs: [20] });
    await m.reconcile();
    await vi.waitFor(async () => expect(await status(id)).toBe('ATTENTION'));
    await new Promise((r) => setTimeout(r, 80));
    expect(attempts).toBe(1); // nenhuma nova tentativa automática
    expect(store.cleared).not.toContain(id);
    const acc = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(acc.statusReason).toBe('credentials_unreadable');
    expect(
      await prisma.systemNotification.count({
        where: { dedupeKey: `account:${id}:credentials_unreadable` },
      }),
    ).toBe(1);
    expect(
      (await prisma.integration.findUniqueOrThrow({ where: { accountId: id } })).credentialsEnc,
    ).not.toBeNull();
    factory.open = open;
  });

  it('falha temporária: reconecta com backoff sem apagar credenciais', async () => {
    const id = await account({ paired: true, status: 'CONNECTED' });
    const m = makeManager({ backoffMs: [30] });
    await m.reconcile();
    factory.last(id).emit({ type: 'open', jid: '5511987654321@s.whatsapp.net' });
    await vi.waitFor(async () => expect(await status(id)).toBe('CONNECTED'));

    factory.last(id).emit({ type: 'close', reason: 'connection_lost' });
    await vi.waitFor(async () => expect(await status(id)).toBe('DISCONNECTED'));
    await vi.waitFor(() => expect(factory.count(id)).toBe(2));
    factory.last(id).emit({ type: 'open', jid: '5511987654321@s.whatsapp.net' });
    await vi.waitFor(async () => expect(await status(id)).toBe('CONNECTED'));
    expect(store.cleared).not.toContain(id);
  });

  it('após falhas seguidas marca "Atenção", notifica uma vez e continua tentando', async () => {
    const id = await account({ paired: true, status: 'CONNECTED' });
    const m = makeManager({ backoffMs: [10] });
    await m.reconcile();
    for (let i = 1; i <= 4; i++) {
      await vi.waitFor(() => expect(factory.count(id)).toBe(i));
      factory.last(id).emit({ type: 'close', reason: 'connection_lost' });
    }
    await vi.waitFor(() => expect(factory.count(id)).toBe(5));
    expect(await status(id)).toBe('ATTENTION');
    expect(await reason(id)).toBe('reconnect_failing');
    expect(await prisma.systemNotification.count({ where: { accountId: id } })).toBe(1);
    expect(store.cleared).not.toContain(id);

    // ao reconectar, a notificação é resolvida
    factory.last(id).emit({ type: 'open', jid: '5511987654321@s.whatsapp.net' });
    await vi.waitFor(async () => expect(await status(id)).toBe('CONNECTED'));
    const n = await prisma.systemNotification.findFirstOrThrow({ where: { accountId: id } });
    expect(n.resolvedAt).not.toBeNull();
  });

  it('logout pelo WhatsApp: "Requer novo pareamento", notificação e sem reconexão automática', async () => {
    const id = await account({ paired: true, status: 'CONNECTED' });
    const m = makeManager();
    await m.reconcile();
    factory.last(id).emit({ type: 'close', reason: 'logged_out' });
    await vi.waitFor(async () => expect(await status(id)).toBe('NEEDS_REPAIR'));
    const n = await prisma.systemNotification.findFirstOrThrow({ where: { accountId: id } });
    expect(n.severity).toBe('ERROR');
    // credenciais não são apagadas automaticamente
    expect(store.cleared).not.toContain(id);
    await m.reconcile();
    expect(factory.count(id)).toBe(1);
  });

  it('sessão aberta em outro local: suspende a reconexão até ação manual', async () => {
    const id = await account({ paired: true, status: 'CONNECTED' });
    const m = makeManager();
    await m.reconcile();
    factory.last(id).emit({ type: 'close', reason: 'connection_replaced' });
    await vi.waitFor(async () => expect(await status(id)).toBe('ATTENTION'));
    await m.reconcile();
    expect(factory.count(id)).toBe(1);

    await m.reconnect(id);
    expect(factory.count(id)).toBe(2);
    factory.last(id).emit({ type: 'open', jid: '5511987654321@s.whatsapp.net' });
    await vi.waitFor(async () => expect(await status(id)).toBe('CONNECTED'));
  });

  it('pareamento interrompido por reinício volta para "Não configurada"', async () => {
    const id = await account({ status: 'AWAITING_CONNECTION' });
    const m = makeManager();
    await m.reconcile();
    expect(factory.count(id)).toBe(0);
    expect(await status(id)).toBe('NOT_CONFIGURED');
  });

  it('não restaura instâncias desativadas ou que exigem novo pareamento', async () => {
    const repair = await account({ paired: true, status: 'NEEDS_REPAIR' });
    const disabled = await account({ paired: true, status: 'CONNECTED' });
    await prisma.account.update({
      where: { id: disabled },
      data: { disabledAt: new Date(), status: 'DISABLED' },
    });
    const m = makeManager();
    await m.reconcile();
    expect(factory.count(repair)).toBe(0);
    expect(factory.count(disabled)).toBe(0);
  });
});

describe('remoção e desativação (ações manuais)', () => {
  it('remover desvincula no WhatsApp e apaga as credenciais', async () => {
    const id = await account({ paired: true, status: 'CONNECTED' });
    const m = makeManager();
    await m.reconcile();
    factory.last(id).emit({ type: 'open', jid: '5511987654321@s.whatsapp.net' });
    await vi.waitFor(async () => expect(await status(id)).toBe('CONNECTED'));
    await m.remove(id);
    expect(factory.last(id).conn.loggedOut).toBe(true);
    expect(store.cleared).toContain(id);
    expect(await status(id)).toBe('NOT_CONFIGURED');
    expect(await reason(id)).toBe('removed_by_admin');
  });

  it('desativar encerra a sessão preservando as credenciais', async () => {
    const id = await account({ paired: true, status: 'CONNECTED' });
    const m = makeManager();
    await m.reconcile();
    await m.stop(id);
    expect(factory.last(id).conn.ended).toBe(true);
    expect(factory.last(id).conn.loggedOut).toBe(false);
    expect(store.cleared).not.toContain(id);
  });

  it('tolera a exclusão da instância durante a remoção', async () => {
    const id = await account({ paired: true, status: 'CONNECTED' });
    const m = makeManager();
    await m.reconcile();
    await prisma.account.delete({ where: { id } });
    await expect(m.remove(id)).resolves.toBeUndefined();
  });
});

describe('dono único por instância', () => {
  it('uma segunda instância do gateway não assume uma sessão já controlada', async () => {
    const id = await account({ paired: true, status: 'CONNECTED' });
    const a = makeManager({ owner: 'gateway-a' });
    const b = makeManager({ owner: 'gateway-b' });
    await a.reconcile();
    await b.reconcile();
    expect(factory.count(id)).toBe(1);
    expect(a.hasSession(id)).toBe(true);
    expect(b.hasSession(id)).toBe(false);

    // após o desligamento de A, B assume
    await a.shutdown();
    await b.reconcile();
    expect(b.hasSession(id)).toBe(true);
  });
});
