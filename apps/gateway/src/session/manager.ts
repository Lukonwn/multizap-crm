import type { Redis } from 'ioredis';
import type { PrismaClient } from '@multizap/database';
import {
  PAIRING_STATE_TTL_SECONDS,
  STATUS_REASON,
  e164Digits,
  gatewayKeys,
  normalizePhone,
  type PairingState,
} from '@multizap/shared';
import type {
  AuthStoreLike,
  CloseReason,
  ConnEvent,
  ConnectionFactory,
  OutgoingMessage,
  WaConnection,
} from './types';
import type { LockManager } from './lock';
import { SessionRepository } from './repository';
import { CredentialsUnreadableError } from './types';

type Mode = 'pairing' | 'restore';

export class NotConnectedError extends Error {
  constructor() {
    super('A instância não está conectada.');
  }
}

interface Session {
  accountId: string;
  mode: Mode;
  generation: number;
  conn: WaConnection | null;
  open: boolean;
  pairing?: {
    method: 'qr' | 'pairing-code';
    phoneE164?: string;
    codeRequested: boolean;
    qrCount: number;
  };
  attempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  lastTouch: number;
}

export interface ManagerOptions {
  /** Atrasos de reconexão (ms); o último se repete. */
  backoffMs?: number[];
  /** Falhas seguidas até marcar a instância como "Atenção". */
  attentionAfter?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Recebe mensagens da sessão (Central de Mensagens). */
  onMessages?: (
    accountId: string,
    messages: import('./types').IncomingMessage[],
    historical: boolean,
  ) => Promise<void>;
  /** Recebe nomes e correspondências LID ↔ telefone entregues pelo WhatsApp. */
  onIdentities?: (accountId: string, items: import('./types').IdentityUpdate[]) => Promise<void>;
}

const DEFAULT_BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const FIRST_QR_TTL_MS = 60_000;
const NEXT_QR_TTL_MS = 20_000;
const PAIRING_CODE_TTL_MS = 150_000;
const TOUCH_THROTTLE_MS = 60_000;

/**
 * Gerencia o ciclo de vida das sessões WhatsApp.
 *
 * Regras de persistência (regra fundamental do projeto):
 *  - Reinícios do gateway, da API ou da interface NÃO desconectam: o socket é
 *    encerrado sem logout e as credenciais permanecem no banco; ao subir, o
 *    gateway restaura todas as sessões pareadas (reconcile).
 *  - Falhas temporárias → reconexão com backoff; credenciais nunca apagadas.
 *  - Logout/revogação pelo WhatsApp → "Requer novo pareamento" + notificação.
 *  - Credenciais só são apagadas por ação manual (novo pareamento ou remoção).
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly repo: SessionRepository;
  private readonly backoff: number[];
  private readonly attentionAfter: number;
  private readonly log: NonNullable<ManagerOptions['log']>;
  private readonly onMessages: ManagerOptions['onMessages'];
  private readonly onIdentities: ManagerOptions['onIdentities'];
  private generationSeq = 0;
  private shuttingDown = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly factory: ConnectionFactory,
    private readonly store: AuthStoreLike,
    private readonly locks: LockManager,
    opts: ManagerOptions = {},
  ) {
    this.repo = new SessionRepository(prisma);
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.attentionAfter = opts.attentionAfter ?? 3;
    this.log = opts.log ?? (() => undefined);
    this.onMessages = opts.onMessages;
    this.onIdentities = opts.onIdentities;
  }

  get activeCount(): number {
    return [...this.sessions.values()].filter((s) => s.open).length;
  }

  hasSession(accountId: string): boolean {
    return this.sessions.has(accountId);
  }

  isOpen(accountId: string): boolean {
    return !!this.sessions.get(accountId)?.open;
  }

  /** Envio individual pela sessão conectada da instância (serializado por instância). */
  send(
    accountId: string,
    jid: string,
    message: OutgoingMessage,
  ): Promise<{ id: string; timestamp: number }> {
    return this.serial(accountId, async () => {
      const s = this.sessions.get(accountId);
      if (!s?.open || !s.conn) throw new NotConnectedError();
      const result = await s.conn.sendMessage(jid, message);
      s.lastTouch = Date.now();
      await this.repo.touch(accountId);
      return result;
    });
  }

  /** Foto de perfil (miniatura) de uma conversa existente. Null se não houver ou for privada. */
  profilePicture(accountId: string, jid: string): Promise<string | null> {
    return this.serial(accountId, async () => {
      const s = this.sessions.get(accountId);
      if (!s?.open || !s.conn) throw new NotConnectedError();
      return (await s.conn.profilePictureUrl?.(jid)) ?? null;
    });
  }

  /** Instâncias com conexão aberta agora. */
  connectedAccounts(): string[] {
    return [...this.sessions.entries()].filter(([, s]) => s.open).map(([id]) => id);
  }

  /** Serializa operações por instância (evita corridas entre comandos e eventos). */
  private serial<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(accountId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.queues.set(accountId, next);
    void next
      .finally(() => {
        if (this.queues.get(accountId) === next) this.queues.delete(accountId);
      })
      .catch(() => undefined);
    return next;
  }

  private async setPairing(accountId: string, state: PairingState) {
    await this.redis
      .set(gatewayKeys.pairing(accountId), JSON.stringify(state), 'EX', PAIRING_STATE_TTL_SECONDS)
      .catch(() => undefined);
  }

  // ─── Comandos ─────────────────────────────────────────────────────────────

  startPairing(accountId: string, method: 'qr' | 'pairing-code', phoneE164?: string) {
    return this.serial(accountId, async () => {
      const account = await this.prisma.account.findUnique({ where: { id: accountId } });
      if (!account || account.connectionType !== 'WHATSAPP_WEB' || account.disabledAt) {
        await this.setPairing(accountId, {
          kind: 'failed',
          message: 'Instância indisponível para pareamento.',
          at: Date.now(),
        });
        return;
      }
      if (method === 'pairing-code' && (!phoneE164 || !normalizePhone(phoneE164).ok)) {
        await this.setPairing(accountId, {
          kind: 'failed',
          message: 'Telefone inválido.',
          at: Date.now(),
        });
        return;
      }
      await this.closeSession(accountId, { logout: false });
      if (!(await this.locks.acquire(accountId))) {
        await this.setPairing(accountId, {
          kind: 'failed',
          message:
            'Outra instância do gateway controla esta conexão. Tente novamente em alguns segundos.',
          at: Date.now(),
        });
        return;
      }
      // Novo pareamento é uma ação manual explícita: começa com credenciais limpas.
      await this.store.clear(accountId);
      await this.setPairing(accountId, { kind: 'starting', method, at: Date.now() });
      await this.repo.setStatus(accountId, 'AWAITING_CONNECTION', null);
      await this.repo.event(
        accountId,
        'pairing_started',
        method === 'qr'
          ? 'Pareamento por QR Code iniciado.'
          : 'Pareamento com número de telefone iniciado.',
        { method },
      );
      await this.openSession(accountId, 'pairing', {
        method,
        phoneE164,
        codeRequested: false,
        qrCount: 0,
      });
    });
  }

  cancelPairing(accountId: string) {
    return this.serial(accountId, async () => {
      const s = this.sessions.get(accountId);
      if (!s || s.mode !== 'pairing' || s.open) return;
      await this.closeSession(accountId, { logout: false });
      await this.store.clear(accountId);
      await this.locks.release(accountId);
      await this.repo.setStatus(accountId, 'NOT_CONFIGURED', STATUS_REASON.pairingCancelled);
      await this.repo.event(
        accountId,
        'pairing_cancelled',
        'Pareamento cancelado pelo administrador.',
      );
      await this.redis.del(gatewayKeys.pairing(accountId)).catch(() => undefined);
    });
  }

  /** Reconexão manual (também limpa o bloqueio de "sessão aberta em outro local"). */
  reconnect(accountId: string) {
    return this.serial(accountId, async () => {
      const account = await this.prisma.account.findUnique({
        where: { id: accountId },
        include: { integration: true },
      });
      if (!account?.integration?.pairedAt || account.disabledAt) return;
      await this.closeSession(accountId, { logout: false });
      if (!(await this.locks.acquire(accountId))) return;
      await this.repo.setStatus(accountId, 'DISCONNECTED', null);
      await this.repo.event(
        accountId,
        'reconnect_requested',
        'Reconexão solicitada pelo administrador.',
      );
      await this.openSession(accountId, 'restore');
    });
  }

  /** Encerra a sessão local mantendo as credenciais (desativação da instância). */
  stop(accountId: string) {
    return this.serial(accountId, async () => {
      await this.closeSession(accountId, { logout: false });
      await this.locks.release(accountId);
      await this.repo.event(
        accountId,
        'session_stopped',
        'Sessão encerrada (instância desativada). Credenciais preservadas.',
      );
    });
  }

  /** Remove a conexão: desvincula no WhatsApp quando possível e apaga as credenciais. */
  remove(accountId: string) {
    return this.serial(accountId, async () => {
      const s = this.sessions.get(accountId);
      let unlinked = false;
      if (s?.conn && s.open) {
        try {
          await s.conn.logout();
          unlinked = true;
        } catch (err) {
          this.log('Falha ao desvincular no WhatsApp', { accountId, err: String(err) });
        }
      }
      await this.closeSession(accountId, { logout: false });
      await this.store.clear(accountId);
      await this.locks.release(accountId);
      await this.redis.del(gatewayKeys.pairing(accountId)).catch(() => undefined);
      await this.repo.setStatus(accountId, 'NOT_CONFIGURED', STATUS_REASON.removedByAdmin);
      await this.repo.event(
        accountId,
        'connection_removed',
        unlinked
          ? 'Conexão removida e dispositivo desvinculado do WhatsApp.'
          : 'Conexão removida. Se o dispositivo ainda aparecer no celular, remova-o em "Aparelhos conectados".',
        { unlinked },
      );
    });
  }

  /**
   * Restaura as sessões que devem estar ativas. Executado ao iniciar e
   * periodicamente — é o que garante a sobrevivência a reinícios e deploys.
   */
  async reconcile(): Promise<void> {
    if (this.shuttingDown) return;
    const accounts = await this.prisma.account.findMany({
      where: { connectionType: 'WHATSAPP_WEB' },
      include: { integration: { select: { pairedAt: true } } },
    });
    const ids = new Set(accounts.map((a) => a.id));

    // Sessões locais de instâncias excluídas ou desativadas.
    for (const [accountId] of this.sessions) {
      const a = accounts.find((x) => x.id === accountId);
      if (!ids.has(accountId) || a?.disabledAt) await this.stopSilently(accountId);
    }

    for (const a of accounts) {
      if (this.sessions.has(a.id) || a.disabledAt) continue;
      const paired = !!a.integration?.pairedAt;

      // Pareamento interrompido por reinício: volta para "Não configurada".
      if (!paired && a.status === 'AWAITING_CONNECTION') {
        if (await this.locks.acquire(a.id)) {
          await this.repo.setStatus(a.id, 'NOT_CONFIGURED', STATUS_REASON.pairingExpired);
          await this.repo.event(
            a.id,
            'pairing_interrupted',
            'Pareamento interrompido por reinício do serviço. Inicie novamente.',
          );
          await this.setPairing(a.id, { kind: 'expired', at: Date.now() });
          await this.locks.release(a.id);
        }
        continue;
      }

      const blocked =
        a.status === 'NEEDS_REPAIR' ||
        a.status === 'DISABLED' ||
        a.statusReason === STATUS_REASON.connectionReplaced ||
        a.statusReason === 'forbidden';
      if (!paired || blocked) continue;

      await this.serial(a.id, async () => {
        if (this.sessions.has(a.id) || this.shuttingDown) return;
        if (!(await this.locks.acquire(a.id))) return;
        await this.repo.event(a.id, 'session_restoring', 'Restaurando sessão salva.');
        await this.openSession(a.id, 'restore');
      });
    }
  }

  /** Desligamento gracioso: fecha sockets SEM logout e libera as travas. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const accountId of [...this.sessions.keys()]) {
      await this.closeSession(accountId, { logout: false });
    }
    await this.locks.releaseAll();
  }

  /** Trava perdida para outra instância: encerra localmente sem alterar o status. */
  onLockLost(accountId: string) {
    void this.serial(accountId, async () => {
      this.log('Trava perdida; encerrando sessão local', { accountId });
      await this.closeSession(accountId, { logout: false });
    });
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private async stopSilently(accountId: string) {
    await this.serial(accountId, async () => {
      await this.closeSession(accountId, { logout: false });
      await this.locks.release(accountId);
    });
  }

  private async closeSession(accountId: string, _opts: { logout: false }) {
    const s = this.sessions.get(accountId);
    if (!s) return;
    this.sessions.delete(accountId);
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    try {
      s.conn?.end();
    } catch {
      /* socket já encerrado */
    }
  }

  private async openSession(
    accountId: string,
    mode: Mode,
    pairing?: Session['pairing'],
    attempts = 0,
  ) {
    const generation = ++this.generationSeq;
    const session: Session = {
      accountId,
      mode,
      generation,
      conn: null,
      open: false,
      pairing,
      attempts,
      reconnectTimer: null,
      lastTouch: 0,
    };
    this.sessions.set(accountId, session);
    try {
      session.conn = await this.factory.open(accountId, (e) => {
        void this.serial(accountId, () => this.handleEvent(accountId, generation, e)).catch(
          (err: unknown) => this.log('Erro ao processar evento', { accountId, err: String(err) }),
        );
      });
    } catch (err) {
      this.log('Falha ao abrir conexão', { accountId, err: String(err) });
      if (err instanceof CredentialsUnreadableError)
        return this.onCredentialsUnreadable(accountId, err);
      await this.handleEvent(accountId, generation, {
        type: 'close',
        reason: 'unknown',
        message: String(err),
      });
    }
  }

  /**
   * Credenciais salvas que não podem ser lidas (ex.: CREDENTIALS_MASTER_KEY trocada).
   * Não é uma falha temporária: não tenta reconectar em loop e NÃO apaga nada.
   * O administrador restaura a chave e reconecta, ou remove a conexão manualmente.
   */
  private async onCredentialsUnreadable(accountId: string, err: Error) {
    this.sessions.delete(accountId);
    await this.locks.release(accountId);
    await this.repo.setLastError(accountId, err.message);
    await this.repo.setStatus(accountId, 'ATTENTION', STATUS_REASON.credentialsUnreadable);
    await this.repo.event(
      accountId,
      'credentials_unreadable',
      'As credenciais salvas não puderam ser lidas. Reconexão automática suspensa; nada foi apagado.',
    );
    await this.repo.notify({
      accountId,
      severity: 'CRITICAL',
      category: 'SECURITY',
      title: 'Credenciais da instância ilegíveis',
      message:
        'A sessão salva não pôde ser descriptografada. Verifique se a CREDENTIALS_MASTER_KEY é a mesma usada no pareamento.',
      dedupeKey: `account:${accountId}:credentials_unreadable`,
    });
  }

  private current(accountId: string, generation: number): Session | null {
    const s = this.sessions.get(accountId);
    return s && s.generation === generation ? s : null;
  }

  private async handleEvent(accountId: string, generation: number, e: ConnEvent) {
    const s = this.current(accountId, generation);
    if (!s) return; // evento de uma conexão antiga

    switch (e.type) {
      case 'qr':
        return this.onQr(s, e.qr);
      case 'open':
        return this.onOpen(s, e.jid, e.name);
      case 'activity':
        if (Date.now() - s.lastTouch > TOUCH_THROTTLE_MS) {
          s.lastTouch = Date.now();
          await this.repo.touch(accountId);
        }
        return;
      case 'close':
        return this.onClose(s, e.reason, e.message);
      case 'message-status':
        await this.repo.updateMessageStatus(accountId, e.id, e.status);
        return;
      case 'messages':
        if (this.onMessages) await this.onMessages(accountId, e.messages, e.historical);
        return;
      case 'identities':
        if (this.onIdentities) await this.onIdentities(accountId, e.items);
        return;
    }
  }

  private async onQr(s: Session, qr: string) {
    if (s.mode !== 'pairing' || !s.pairing) return; // sessão restaurada não deve pedir QR
    const p = s.pairing;
    const ttl = p.qrCount === 0 ? FIRST_QR_TTL_MS : NEXT_QR_TTL_MS;
    p.qrCount++;
    if (p.method === 'qr') {
      await this.setPairing(s.accountId, {
        kind: 'qr',
        qr,
        expiresAt: Date.now() + ttl,
        at: Date.now(),
      });
      return;
    }
    if (p.codeRequested || !p.phoneE164 || !s.conn) return;
    p.codeRequested = true;
    try {
      const code = await s.conn.requestPairingCode(e164Digits(p.phoneE164));
      await this.setPairing(s.accountId, {
        kind: 'pairing-code',
        code,
        phoneE164: p.phoneE164,
        expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
        at: Date.now(),
      });
      await this.repo.event(
        s.accountId,
        'pairing_code_issued',
        'Código de pareamento gerado pelo WhatsApp.',
        {
          phone: p.phoneE164,
        },
      );
    } catch (err) {
      await this.setPairing(s.accountId, {
        kind: 'failed',
        message:
          'O WhatsApp não emitiu o código de pareamento. Verifique o número e tente novamente.',
        at: Date.now(),
      });
      await this.repo.event(
        s.accountId,
        'pairing_code_failed',
        'Falha ao solicitar o código de pareamento.',
        {
          error: String(err).slice(0, 300),
        },
      );
      await this.closeSession(s.accountId, { logout: false });
      await this.store.clear(s.accountId);
      await this.locks.release(s.accountId);
      await this.repo.setStatus(s.accountId, 'NOT_CONFIGURED', STATUS_REASON.pairingExpired);
    }
  }

  private async onOpen(s: Session, jid: string, name?: string) {
    const wasPairing = s.mode === 'pairing';
    s.open = true;
    s.attempts = 0;
    s.mode = 'restore';
    s.pairing = undefined;
    const user = jid.split('@')[0]?.split(':')[0] ?? '';
    const phone = user ? normalizePhone(`+${user}`) : null;

    if (wasPairing) {
      await this.repo.markPaired(s.accountId, { jid, deviceName: name });
      await this.setPairing(s.accountId, { kind: 'connected', at: Date.now() });
    } else {
      await this.repo.markConnected(s.accountId, jid);
    }
    await this.repo.setStatus(s.accountId, 'CONNECTED', null, {
      lastActivityAt: new Date(),
      ...(phone?.ok ? { phoneE164: phone.e164 } : {}),
    });
    await this.repo.event(
      s.accountId,
      wasPairing ? 'paired' : 'connected',
      wasPairing ? 'Dispositivo pareado e conectado.' : 'Sessão conectada.',
      { jid },
    );
    await this.repo.resolveConnectionNotifications(s.accountId);
  }

  private async onClose(s: Session, reason: CloseReason, message?: string) {
    const { accountId } = s;
    s.open = false;
    s.conn = null;

    // Exigido pelo WhatsApp após o pareamento: reabre imediatamente com as novas credenciais.
    if (reason === 'restart_required') {
      const pairing = s.mode === 'pairing' ? s.pairing : undefined;
      this.sessions.delete(accountId);
      await this.openSession(
        accountId,
        s.mode === 'pairing' ? 'pairing' : 'restore',
        pairing,
        s.attempts,
      );
      return;
    }

    if (this.shuttingDown) return;

    if (s.mode === 'pairing') {
      this.sessions.delete(accountId);
      await this.store.clear(accountId);
      await this.locks.release(accountId);
      if (reason === 'qr_timeout') {
        await this.setPairing(accountId, { kind: 'expired', at: Date.now() });
        await this.repo.setStatus(accountId, 'NOT_CONFIGURED', STATUS_REASON.pairingExpired);
        await this.repo.event(
          accountId,
          'pairing_expired',
          'O tempo para concluir o pareamento expirou.',
        );
      } else {
        await this.setPairing(accountId, {
          kind: 'failed',
          message: 'A conexão com o WhatsApp foi encerrada durante o pareamento. Tente novamente.',
          at: Date.now(),
        });
        await this.repo.setStatus(accountId, 'NOT_CONFIGURED', STATUS_REASON.pairingExpired);
        await this.repo.event(accountId, 'pairing_failed', 'Pareamento não concluído.', {
          reason,
          message,
        });
      }
      return;
    }

    // Sessão restaurada/conectada
    await this.repo.setLastError(accountId, `${reason}${message ? `: ${message}` : ''}`);

    if (reason === 'logged_out' || reason === 'multidevice_mismatch') {
      this.sessions.delete(accountId);
      await this.locks.release(accountId);
      await this.repo.setStatus(accountId, 'NEEDS_REPAIR', STATUS_REASON.loggedOut);
      await this.repo.event(
        accountId,
        'logged_out',
        'Sessão encerrada pelo WhatsApp. É necessário parear novamente.',
        { reason },
      );
      await this.repo.notify({
        accountId,
        severity: 'ERROR',
        category: 'CONNECTION',
        title: 'Instância requer novo pareamento',
        message: 'O dispositivo foi desconectado pelo WhatsApp ou pelo celular.',
        dedupeKey: `account:${accountId}:logged_out`,
      });
      return;
    }

    if (reason === 'connection_replaced') {
      this.sessions.delete(accountId);
      await this.locks.release(accountId);
      await this.repo.setStatus(accountId, 'ATTENTION', STATUS_REASON.connectionReplaced);
      await this.repo.event(
        accountId,
        'connection_replaced',
        'A sessão foi aberta em outro local. Reconexão automática suspensa.',
      );
      await this.repo.notify({
        accountId,
        severity: 'WARNING',
        category: 'CONNECTION',
        title: 'Sessão aberta em outro local',
        message: 'A conexão foi substituída. Use "Reconectar" se desejar retomá-la aqui.',
        dedupeKey: `account:${accountId}:replaced`,
      });
      return;
    }

    if (reason === 'forbidden') {
      this.sessions.delete(accountId);
      await this.locks.release(accountId);
      await this.repo.setStatus(accountId, 'ATTENTION', 'forbidden');
      await this.repo.event(
        accountId,
        'forbidden',
        'O WhatsApp recusou o acesso desta sessão (possível restrição do número).',
      );
      await this.repo.notify({
        accountId,
        severity: 'CRITICAL',
        category: 'CONNECTION',
        title: 'Acesso recusado pelo WhatsApp',
        message: 'O WhatsApp recusou a sessão. Verifique o número no celular antes de reconectar.',
        dedupeKey: `account:${accountId}:forbidden`,
      });
      return;
    }

    // Falha temporária: reconecta com backoff, sem apagar nada.
    s.attempts++;
    const delay = this.backoff[Math.min(s.attempts - 1, this.backoff.length - 1)]!;
    const attention = s.attempts >= this.attentionAfter;
    await this.repo.setStatus(
      accountId,
      attention ? 'ATTENTION' : 'DISCONNECTED',
      attention
        ? STATUS_REASON.reconnectFailing
        : reason === 'bad_session'
          ? STATUS_REASON.badSession
          : null,
    );
    await this.repo.event(
      accountId,
      'disconnected',
      `Conexão interrompida (${reason}). Nova tentativa em ${Math.round(delay / 1000)} s.`,
      {
        reason,
        attempt: s.attempts,
      },
    );
    if (attention && s.attempts === this.attentionAfter) {
      await this.repo.notify({
        accountId,
        severity: 'WARNING',
        category: 'CONNECTION',
        title: 'Falhas seguidas de reconexão',
        message: `A instância não reconecta após ${s.attempts} tentativas. O sistema continua tentando.`,
        dedupeKey: `account:${accountId}:reconnect_failing`,
      });
    }
    const attemptsSoFar = s.attempts;
    s.reconnectTimer = setTimeout(() => {
      void this.serial(accountId, async () => {
        const still = this.current(accountId, s.generation);
        if (!still || this.shuttingDown) return;
        this.sessions.delete(accountId);
        if (!this.locks.isHeld(accountId) && !(await this.locks.acquire(accountId))) return;
        await this.openSession(accountId, 'restore', undefined, attemptsSoFar);
      });
    }, delay);
    s.reconnectTimer.unref?.();
  }
}
