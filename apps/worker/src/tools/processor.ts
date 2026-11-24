import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import archiver from 'archiver';
import type { PrismaClient } from '@multizap/database';
import {
  FORMAT_CONTENT_TYPE,
  type Delimiter,
  type Encoding,
  type FileFormat,
} from '@multizap/files';
import type { ToolId, ToolOutput } from '@multizap/shared';
import type { StorageDriver } from '@multizap/storage';
import { DiskSink, ZIP_OUTPUT_TOOLS, baseName, runTool, type InputFile } from '@multizap/tools';

export interface StoredToolInput {
  key: string;
  name: string;
  format: FileFormat;
  encoding: Encoding;
  delimiter: Delimiter | null;
  size: number;
}

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/**
 * Executa ferramentas de listas. As saídas são gravadas em disco temporário
 * (permite muitas saídas simultâneas sem consumir memória) e enviadas ao
 * armazenamento persistente ao final; o diretório temporário é sempre removido.
 */
export class ToolJobProcessor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageDriver,
    private readonly log: Log = () => undefined,
  ) {}

  async run(jobId: string): Promise<void> {
    const job = await this.prisma.fileJob.findUnique({ where: { id: jobId } });
    if (!job || !['QUEUED', 'RUNNING'].includes(job.status)) return;
    await this.prisma.fileJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: job.startedAt ?? new Date(), progress: 0, error: null },
    });

    const stored = job.inputKeys as unknown as StoredToolInput[];
    const totalBytes = stored.reduce((s, i) => s + i.size, 0) || 1;
    let readBytes = 0;
    let lastUpdate = 0;
    const tick = () => {
      const now = Date.now();
      if (now - lastUpdate < 1000) return;
      lastUpdate = now;
      const progress = Math.min(95, Math.round((readBytes / totalBytes) * 100));
      void this.prisma.fileJob
        .update({ where: { id: jobId }, data: { progress } })
        .catch(() => undefined);
    };

    const inputs: InputFile[] = stored.map((s) => ({
      name: s.name,
      format: s.format,
      encoding: s.encoding,
      delimiter: s.delimiter,
      open: async () => {
        const counter = new Transform({
          transform(chunk: Buffer, _e, cb) {
            readBytes += chunk.length;
            tick();
            cb(null, chunk);
          },
        });
        return (await this.storage.get(s.key)).pipe(counter);
      },
    }));

    const dir = await mkdtemp(join(tmpdir(), `mz-tool-${jobId.slice(0, 8)}-`));
    try {
      const sink = new DiskSink(dir);
      const summary = await runTool(job.tool as ToolId, { inputs, output: sink }, job.params);

      const outputs: ToolOutput[] = [];
      for (const [i, o] of sink.outputs.entries()) {
        const key = `tools/${jobId}/out/${i}-${o.name}`;
        await this.storage.put(key, createReadStream(o.path), {
          contentType: FORMAT_CONTENT_TYPE[o.format],
        });
        outputs.push({
          key,
          name: o.name,
          rows: o.writer.rows,
          contentType: FORMAT_CONTENT_TYPE[o.format],
        });
      }

      if (ZIP_OUTPUT_TOOLS.includes(job.tool as ToolId) && sink.outputs.length > 1) {
        const name = `${baseName(stored[0]?.name ?? 'lista')}-${job.tool}.zip`;
        const key = `tools/${jobId}/out/${name}`;
        const zip = archiver('zip', { zlib: { level: 6 } });
        const pass = new PassThrough();
        zip.pipe(pass);
        const upload = this.storage.put(key, pass, { contentType: 'application/zip' });
        for (const o of sink.outputs) zip.file(o.path, { name: o.name });
        await zip.finalize();
        await upload;
        outputs.unshift({ key, name, rows: null, contentType: 'application/zip' });
      }

      await this.prisma.fileJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          progress: 100,
          outputKeys: outputs as object[],
          summary: summary as object,
          finishedAt: new Date(),
        },
      });
      this.log('Ferramenta concluída', { jobId, tool: job.tool, outputs: outputs.length });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async fail(jobId: string, err: unknown): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const job = await this.prisma.fileJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    await this.prisma.fileJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: message, finishedAt: new Date() },
    });
    await this.prisma.systemNotification.create({
      data: {
        severity: 'ERROR',
        category: 'PROCESSING',
        title: 'Falha no processamento de arquivo',
        message: `A ferramenta "${job.tool}" falhou: ${message.slice(0, 200)}`,
        dedupeKey: `file_job:${jobId}:failed`,
      },
    });
  }
}
