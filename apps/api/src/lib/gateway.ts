import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  GATEWAY_QUEUE,
  HEARTBEAT_KEYS,
  PAIRING_STATE_TTL_SECONDS,
  gatewayKeys,
  type GatewayCommand,
  type PairingState,
} from '@multizap/shared';

/** Cliente da API para o gateway: fila de comandos + estado efêmero no Redis. */
export class GatewayClient {
  private readonly queue: Queue<GatewayCommand>;
  private readonly conn: Redis;

  constructor(
    redisUrl: string,
    private readonly redis: Redis,
    prefix = 'bull',
  ) {
    this.conn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.conn.on('error', () => undefined);
    this.queue = new Queue<GatewayCommand>(GATEWAY_QUEUE, {
      connection: this.conn,
      prefix,
      defaultJobOptions: { removeOnComplete: 200, removeOnFail: 500, attempts: 1 },
    });
  }

  async isAlive(): Promise<boolean> {
    const v = await this.redis.get(HEARTBEAT_KEYS.gateway).catch(() => null);
    return !!v;
  }

  async send(cmd: GatewayCommand): Promise<void> {
    await this.queue.add(cmd.type, cmd);
  }

  async getPairing(accountId: string): Promise<PairingState | null> {
    const v = await this.redis.get(gatewayKeys.pairing(accountId)).catch(() => null);
    return v ? (JSON.parse(v) as PairingState) : null;
  }

  async setPairing(accountId: string, state: PairingState): Promise<void> {
    await this.redis.set(
      gatewayKeys.pairing(accountId),
      JSON.stringify(state),
      'EX',
      PAIRING_STATE_TTL_SECONDS,
    );
  }

  async clearPairing(accountId: string): Promise<void> {
    await this.redis.del(gatewayKeys.pairing(accountId));
  }

  /** Uso em testes. */
  get rawQueue(): Queue<GatewayCommand> {
    return this.queue;
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.conn.disconnect();
  }
}
