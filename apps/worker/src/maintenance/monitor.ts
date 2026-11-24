import {
  notify,
  recordSystemEvent,
  resolveNotifications,
  type PrismaClient,
} from '@multizap/database';
import { HEARTBEAT_KEYS } from '@multizap/shared';
import type { StorageDriver } from '@multizap/storage';

interface RedisLike {
  get(key: string): Promise<string | null>;
}

/** Tempo sem heartbeat do gateway antes de notificar. */
export const GATEWAY_GRACE_MS = 2 * 60_000;
/** Backup automático considerado atrasado depois deste intervalo sem sucesso. */
export const BACKUP_OVERDUE_MS = 26 * 3_600_000;

/**
 * Verificações periódicas do worker. Cria notificações quando algo falha e as
 * resolve sozinho quando volta ao normal (sem duplicar enquanto persiste).
 */
export class Monitor {
  private gatewayMissingSince: number | null = null;
  private readonly startedAt = Date.now();
  backupStorageOk: boolean | null = null;
  backupStorageError: string | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: RedisLike,
    private readonly main: StorageDriver,
    private readonly backups: StorageDriver | null,
    private readonly now: () => number = Date.now,
  ) {}

  async tick(): Promise<void> {
    await this.checkMainStorage();
    await this.checkGateway();
    await this.checkBackupStorage();
    await this.checkBackupOverdue();
  }

  private async checkMainStorage() {
    try {
      await this.main.check();
      await resolveNotifications(this.prisma, 'storage:main');
    } catch (err) {
      const msg = (err as Error).message.slice(0, 200);
      await notify(this.prisma, {
        severity: 'CRITICAL',
        category: 'STORAGE',
        title: 'Armazenamento indisponível',
        message: `O bucket de arquivos não respondeu: ${msg}. Uploads, criativos e importações podem falhar.`,
        dedupeKey: 'storage:main',
      });
      await recordSystemEvent(this.prisma, {
        source: 'worker',
        level: 'error',
        type: 'storage_unavailable',
        message: msg,
      });
    }
  }

  private async checkGateway() {
    const alive = await this.redis.get(HEARTBEAT_KEYS.gateway).catch(() => null);
    if (alive) {
      this.gatewayMissingSince = null;
      if ((await resolveNotifications(this.prisma, 'gateway:down')) > 0)
        await recordSystemEvent(this.prisma, {
          source: 'worker',
          level: 'info',
          type: 'gateway_back',
          message: 'O gateway voltou a responder.',
        });
      return;
    }
    const now = this.now();
    this.gatewayMissingSince ??= Math.max(now, this.startedAt);
    if (now - this.gatewayMissingSince < GATEWAY_GRACE_MS) return;
    await notify(this.prisma, {
      severity: 'ERROR',
      category: 'INTEGRATION',
      title: 'Gateway WhatsApp sem resposta',
      message:
        'O serviço de conexões não envia sinal há mais de 2 minutos. Envios e recebimentos estão parados.',
      dedupeKey: 'gateway:down',
    });
  }

  private async checkBackupStorage() {
    if (!this.backups) return;
    try {
      await this.backups.check();
      this.backupStorageOk = true;
      this.backupStorageError = null;
      await resolveNotifications(this.prisma, 'backup:storage');
    } catch (err) {
      this.backupStorageOk = false;
      this.backupStorageError = (err as Error).message.slice(0, 200);
      await notify(this.prisma, {
        severity: 'ERROR',
        category: 'BACKUP',
        title: 'Bucket de backup inacessível',
        message: `Não foi possível acessar o bucket de backup: ${this.backupStorageError}`,
        dedupeKey: 'backup:storage',
      });
    }
  }

  private async checkBackupOverdue() {
    if (!this.backups || this.now() - this.startedAt < 3_600_000) return;
    const last = await this.prisma.backup.findFirst({
      where: { status: 'COMPLETED' },
      orderBy: { finishedAt: 'desc' },
    });
    const lastAt = last?.finishedAt?.getTime() ?? 0;
    if (this.now() - lastAt < BACKUP_OVERDUE_MS) return;
    await notify(this.prisma, {
      severity: 'WARNING',
      category: 'BACKUP',
      title: 'Backup atrasado',
      message: last
        ? `O último backup concluído foi em ${last.finishedAt!.toLocaleString('pt-BR', { timeZone: process.env.REPORTS_TZ || 'America/Sao_Paulo' })}.`
        : 'Nenhum backup foi concluído ainda.',
      dedupeKey: 'backup:overdue',
    });
  }
}
