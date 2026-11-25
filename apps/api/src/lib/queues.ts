import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  AI_GENERATOR_QUEUE,
  AI_KNOWLEDGE_QUEUE,
  AI_QUEUE,
  CAMPAIGNS_QUEUE,
  GATEWAY_QUEUE,
  IMPORTS_QUEUE,
  MAINTENANCE_QUEUE,
  QUEUE_LABEL,
  TOOLS_QUEUE,
  type AiGeneratorJob,
  type AiKnowledgeJob,
  type MaintenanceJob,
  type QueueCounts,
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

/** Fila de leitura das fontes de conhecimento do MultiZap AI (consumida pelo worker). */
export class KnowledgeQueue {
  private readonly conn: Redis;
  readonly queue: Queue<AiKnowledgeJob>;

  constructor(redisUrl: string, prefix = 'bull') {
    this.conn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.conn.on('error', () => undefined);
    this.queue = new Queue<AiKnowledgeJob>(AI_KNOWLEDGE_QUEUE, {
      connection: this.conn,
      prefix,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    });
  }

  /** Cada pedido gera um job novo: reprocessar depois de um erro é permitido. */
  async add(sourceId: string): Promise<void> {
    await this.queue.add('process', { sourceId }, { jobId: `kb-${sourceId}-${Date.now()}` });
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.conn.disconnect();
  }
}

/** Fila do Gerador de Persona (consumida pelo worker). Sem nova tentativa automática: custa dinheiro. */
export class GeneratorQueue {
  private readonly conn: Redis;
  readonly queue: Queue<AiGeneratorJob>;

  constructor(redisUrl: string, prefix = 'bull') {
    this.conn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.conn.on('error', () => undefined);
    this.queue = new Queue<AiGeneratorJob>(AI_GENERATOR_QUEUE, {
      connection: this.conn,
      prefix,
      defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 200 },
    });
  }

  async add(generationId: string): Promise<void> {
    await this.queue.add('generate', { generationId }, { jobId: `gen-${generationId}` });
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

/**
 * Fila de manutenção (backups manuais) e leitura das contagens de todas as
 * filas para o System Health.
 */
export class SystemQueues {
  private readonly conn: Redis;
  readonly maintenance: Queue<MaintenanceJob>;
  private readonly inspect: Map<string, Queue>;
  /** Filas do MultiZap AI: lidas só pela tela de saúde da IA (ficam fora da lista do System Health). */
  private readonly ai: Map<string, Queue>;

  constructor(redisUrl: string, prefix = 'bull') {
    this.conn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.conn.on('error', () => undefined);
    this.maintenance = new Queue<MaintenanceJob>(MAINTENANCE_QUEUE, {
      connection: this.conn,
      prefix,
      defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 200 },
    });
    this.inspect = new Map(
      [IMPORTS_QUEUE, TOOLS_QUEUE, CAMPAIGNS_QUEUE, GATEWAY_QUEUE].map((name) => [
        name,
        new Queue(name, { connection: this.conn, prefix }),
      ]),
    );
    this.inspect.set(MAINTENANCE_QUEUE, this.maintenance as unknown as Queue);
    this.ai = new Map(
      [AI_QUEUE, AI_KNOWLEDGE_QUEUE, AI_GENERATOR_QUEUE].map((name) => [
        name,
        new Queue(name, { connection: this.conn, prefix }),
      ]),
    );
  }

  async addBackup(backupId: string): Promise<void> {
    await this.maintenance.add(
      'backup',
      { type: 'backup', backupId },
      { jobId: `backup-${backupId}` },
    );
  }

  /** Contagem das filas do MultiZap AI (atendimento, conhecimento e gerador). */
  async aiCounts(): Promise<QueueCounts[]> {
    return Promise.all(
      [...this.ai].map(async ([name, q]) => {
        const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
        return {
          name,
          label: QUEUE_LABEL[name] ?? name,
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          failed: c.failed ?? 0,
          completed: c.completed ?? 0,
        };
      }),
    );
  }

  async counts(): Promise<QueueCounts[]> {
    return Promise.all(
      [...this.inspect].map(async ([name, q]) => {
        const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
        return {
          name,
          label: QUEUE_LABEL[name] ?? name,
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          failed: c.failed ?? 0,
          completed: c.completed ?? 0,
        };
      }),
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.inspect.values(), ...this.ai.values()].map((q) => q.close()));
    this.conn.disconnect();
  }
}
