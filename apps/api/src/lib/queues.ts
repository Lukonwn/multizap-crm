import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  CAMPAIGNS_QUEUE,
  IMPORTS_QUEUE,
  TOOLS_QUEUE,
  type CampaignJob,
  type ImportJob,
  type ToolJobData,
} from '@multizap/shared';

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

/** Fila das ferramentas de listas (consumida pelo worker). */
export class ToolQueue {
  private readonly conn: Redis;
  readonly queue: Queue<ToolJobData>;

  constructor(redisUrl: string, prefix = 'bull') {
    this.conn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.conn.on('error', () => undefined);
    this.queue = new Queue<ToolJobData>(TOOLS_QUEUE, {
      connection: this.conn,
      prefix,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    });
  }

  async add(data: ToolJobData): Promise<void> {
    await this.queue.add('run', data, { jobId: data.jobId });
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.conn.disconnect();
  }
}

/** Fila de preparação de campanhas (consumida pelo worker). */
export class CampaignQueue {
  private readonly conn: Redis;
  readonly queue: Queue<CampaignJob>;

  constructor(redisUrl: string, prefix = 'bull') {
    this.conn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.conn.on('error', () => undefined);
    this.queue = new Queue<CampaignJob>(CAMPAIGNS_QUEUE, { connection: this.conn, prefix });
  }

  async prepareNow(campaignId: string): Promise<void> {
    await this.queue.add(
      'prepare',
      { type: 'prepare', campaignId },
      { jobId: `prepare-${campaignId}`, removeOnComplete: true, removeOnFail: 100 },
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.conn.disconnect();
  }
}
