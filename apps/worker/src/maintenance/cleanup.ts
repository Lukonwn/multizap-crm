import type { Prisma, PrismaClient } from '@multizap/database';
import { CLEANUP_SETTING_KEY, type CleanupResult } from '@multizap/shared';
import type { StorageDriver } from '@multizap/storage';

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface CleanupOptions {
  /** Resultados das ferramentas (entradas e saídas) ficam disponíveis por N dias. */
  toolRetentionDays: number;
  /** Arquivos originais e de rejeitados das importações encerradas. */
  importFileRetentionDays: number;
  /** Uploads das ferramentas que nunca viraram processamento. */
  orphanUploadHours: number;
  eventRetentionDays: number;
  resolvedNotificationRetentionDays: number;
}

export const DEFAULT_CLEANUP: CleanupOptions = {
  toolRetentionDays: 7,
  importFileRetentionDays: 30,
  orphanUploadHours: 24,
  eventRetentionDays: 30,
  resolvedNotificationRetentionDays: 90,
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/**
 * Limpeza periódica de dados temporários. Nunca remove contatos, conversas,
 * campanhas, criativos, auditoria nem credenciais.
 */
export class CleanupService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageDriver,
    private readonly opts: CleanupOptions = DEFAULT_CLEANUP,
    private readonly log: Log = () => undefined,
  ) {}

  async run(): Promise<CleanupResult> {
    const errors: string[] = [];
    const safeDelete = async (key: string) => {
      try {
        await this.storage.delete(key);
      } catch (err) {
        errors.push(`${key}: ${(err as Error).message}`.slice(0, 200));
      }
    };

    // 1. Ferramentas: resultados encerrados há mais de N dias.
    const oldJobs = await this.prisma.fileJob.findMany({
      where: {
        status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
        createdAt: { lt: daysAgo(this.opts.toolRetentionDays) },
      },
    });
    for (const j of oldJobs) {
      const keys = [
        ...(j.inputKeys as { key: string }[]),
        ...(j.outputKeys as { key: string }[]),
      ].map((k) => k.key);
      for (const k of keys) await safeDelete(k);
      await this.prisma.fileJob.delete({ where: { id: j.id } });
    }

    // 2. Uploads das ferramentas sem processamento (expiraram sem uso).
    const referenced = new Set<string>();
    for (const j of await this.prisma.fileJob.findMany({ select: { inputKeys: true } }))
      for (const k of j.inputKeys as { key: string }[]) referenced.add(k.key);
    const orphanCutoff = Date.now() - this.opts.orphanUploadHours * 3_600_000;
    let orphanUploadsRemoved = 0;
    for await (const o of this.storage.list('tools/uploads/')) {
      if (o.lastModified.getTime() < orphanCutoff && !referenced.has(o.key)) {
        await safeDelete(o.key);
        orphanUploadsRemoved++;
      }
    }

    // 3. Importações encerradas: os dados já estão no banco; os arquivos expiram.
    const oldImports = await this.prisma.import.findMany({
      where: {
        status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
        updatedAt: { lt: daysAgo(this.opts.importFileRetentionDays) },
        NOT: { fileKey: '' },
      },
      select: { id: true, fileKey: true, rejectedFileKey: true },
    });
    for (const i of oldImports) {
      await safeDelete(i.fileKey);
      if (i.rejectedFileKey) await safeDelete(i.rejectedFileKey);
      await this.prisma.import.update({
        where: { id: i.id },
        data: { fileKey: '', rejectedFileKey: null },
      });
    }

    // 4. Sessões expiradas ou encerradas, eventos antigos e notificações resolvidas.
    const sessions = await this.prisma.adminSession.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: daysAgo(1) } }] },
    });
    const events = await this.prisma.systemEvent.deleteMany({
      where: { createdAt: { lt: daysAgo(this.opts.eventRetentionDays) } },
    });
    const notifications = await this.prisma.systemNotification.deleteMany({
      where: { resolvedAt: { lt: daysAgo(this.opts.resolvedNotificationRetentionDays) } },
    });

    const result: CleanupResult = {
      at: new Date().toISOString(),
      toolJobsExpired: oldJobs.length,
      orphanUploadsRemoved,
      importFilesRemoved: oldImports.length,
      sessionsRemoved: sessions.count,
      eventsRemoved: events.count,
      notificationsRemoved: notifications.count,
      errors: errors.slice(0, 20),
    };
    await this.prisma.systemSetting.upsert({
      where: { key: CLEANUP_SETTING_KEY },
      create: { key: CLEANUP_SETTING_KEY, value: result as unknown as Prisma.InputJsonValue },
      update: { value: result as unknown as Prisma.InputJsonValue },
    });
    this.log('Limpeza concluída', { ...result, errors: errors.length });
    return result;
  }
}
