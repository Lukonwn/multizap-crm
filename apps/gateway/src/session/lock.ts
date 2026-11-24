import type { Redis } from 'ioredis';
import { gatewayKeys } from '@multizap/shared';

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Trava distribuída por instância: garante um único dono para cada sessão
 * WhatsApp, inclusive durante deploys em que duas versões coexistem.
 */
export class LockManager {
  private readonly held = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: Redis,
    readonly ownerId: string,
    private readonly ttlMs = 30_000,
  ) {}

  async acquire(accountId: string): Promise<boolean> {
    if (this.held.has(accountId)) return true;
    const ok = await this.redis.set(
      gatewayKeys.lock(accountId),
      this.ownerId,
      'PX',
      this.ttlMs,
      'NX',
    );
    if (ok === 'OK') this.held.add(accountId);
    return ok === 'OK';
  }

  async release(accountId: string): Promise<void> {
    this.held.delete(accountId);
    await this.redis
      .eval(RELEASE, 1, gatewayKeys.lock(accountId), this.ownerId)
      .catch(() => undefined);
  }

  isHeld(accountId: string): boolean {
    return this.held.has(accountId);
  }

  /** Renova periodicamente; chama `onLost` para travas perdidas. */
  startRenewal(onLost: (accountId: string) => void, intervalMs = 10_000) {
    this.timer = setInterval(async () => {
      for (const accountId of [...this.held]) {
        const ok = await this.redis
          .eval(RENEW, 1, gatewayKeys.lock(accountId), this.ownerId, String(this.ttlMs))
          .catch(() => null);
        // null = Redis indisponível: mantém a sessão; a trava expira sozinha se o problema persistir.
        if (ok === 0) {
          this.held.delete(accountId);
          onLost(accountId);
        }
      }
    }, intervalMs);
    this.timer.unref();
  }

  async releaseAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.held].map((id) => this.release(id)));
  }
}
