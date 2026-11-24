import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { IMPORTS_QUEUE, type ImportJob } from '@multizap/shared';

/** Fila de jobs de importação (consumida pelo worker). */
export class ImportQueue {
  private readonly conn: Redis;
  readonly queue: Queue<ImportJob>;

  constructor(redisUrl: string, prefix = 'bull') {
    this.conn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.conn.on('error', () => undefined);
    this.queue = new Queue<ImportJob>(IMPORTS_QUEUE, {
      connection: this.conn,
      prefix,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    });
  }

  /** A duplicidade é evitada pelas transições atômicas de status na API. */
  async add(job: ImportJob): Promise<void> {
    await this.queue.add(job.type, job, { jobId: `${job.type}-${job.importId}-${Date.now()}` });
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.conn.disconnect();
  }
}
