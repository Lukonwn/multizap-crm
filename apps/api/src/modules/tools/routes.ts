import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FileJob } from '@multizap/database';
import {
  FORMAT_CONTENT_TYPE,
  detectFormat,
  sniff,
  type Delimiter,
  type Encoding,
  type FileFormat,
} from '@multizap/files';
import {
  TOOLS,
  createToolJobSchema,
  guessHasHeader,
  suggestMapping,
  toolParamsSchemas,
  type ToolId,
  type ToolJobDTO,
  type ToolOutput,
  type ToolUploadDTO,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';

interface UploadMeta {
  id: string;
  key: string;
  fileName: string;
  format: FileFormat;
  encoding: Encoding;
  delimiter: Delimiter | null;
  size: number;
}

/** Arquivos enviados ficam disponíveis por 24 h para iniciar processamentos. */
const UPLOAD_TTL_SECONDS = 24 * 3600;
const uploadKey = (id: string) => `multizap:tool-upload:${id}`;

function toJobDTO(j: FileJob): ToolJobDTO {
  const inputs = (j.inputKeys as { name: string; size: number }[]) ?? [];
  const outputs = (j.outputKeys as unknown as ToolOutput[]) ?? [];
  return {
    id: j.id,
    tool: j.tool as ToolId,
    status: j.status,
    inputs: inputs.map((i) => ({ name: i.name, size: i.size })),
    params: (j.params ?? {}) as Record<string, unknown>,
    progress: j.progress,
    outputs: outputs.map((o) => ({ name: o.name, rows: o.rows })),
    summary: (j.summary ?? {}) as Record<string, unknown>,
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

const jobParams = z.object({ id: z.string().uuid('Processamento inválido.') });

export async function toolRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  const services = () => {
    if (!app.storage || !app.toolQueue || !app.redis) {
      throw new AppError(
        503,
        'STORAGE_UNAVAILABLE',
        'Armazenamento, Redis ou fila de processamento não configurados.',
      );
    }
    return { storage: app.storage, queue: app.toolQueue, redis: app.redis };
  };

  const loadJob = async (id: string) => {
    const job = await prisma.fileJob.findUnique({ where: { id } });
    if (!job) throw Errors.notFound('Processamento não encontrado.');
    return job;
  };

  app.post('/tools/uploads', auth, async (req, reply) => {
    const { storage, redis } = services();
    const file = await req.file().catch(() => undefined);
    if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Selecione um arquivo.');
    const format = detectFormat(file.filename);
    if (!format) {
      file.file.resume();
      throw new AppError(
        400,
        'UNSUPPORTED_FORMAT',
        'Formato não suportado. Envie um arquivo CSV, TXT ou XLSX.',
      );
    }
    const id = randomUUID();
    const key = `tools/uploads/${id}.${format}`;
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        size += chunk.length;
        cb(null, chunk);
      },
    });
    await storage.put(key, file.file.pipe(meter), { contentType: FORMAT_CONTENT_TYPE[format] });
    if (file.file.truncated) {
      await storage.delete(key);
      throw new AppError(
        413,
        'FILE_TOO_LARGE',
        `Arquivo maior que o limite de ${Math.round(app.config.maxImportBytes / 1024 / 1024)} MB.`,
      );
    }
    let sniffed;
    try {
      sniffed = await sniff(() => storage.get(key), format, 20);
    } catch {
      await storage.delete(key);
      throw new AppError(
        400,
        'UNREADABLE_FILE',
        'Não foi possível ler o arquivo. Verifique se ele não está corrompido.',
      );
    }
    if (!sniffed.sample.length) {
      await storage.delete(key);
      throw new AppError(
        400,
        'EMPTY_FILE',
        'Nenhuma linha com conteúdo foi encontrada no arquivo.',
      );
    }
    const meta: UploadMeta = {
      id,
      key,
      fileName: file.filename.slice(0, 200),
      format,
      encoding: sniffed.encoding,
      delimiter: sniffed.delimiter,
      size,
    };
    await redis.set(uploadKey(id), JSON.stringify(meta), 'EX', UPLOAD_TTL_SECONDS);
    const hasHeader = guessHasHeader(sniffed.sample);
    const dto: ToolUploadDTO = {
      id,
      fileName: meta.fileName,
      format,
      size,
      sample: sniffed.sample,
      hasHeader,
      suggestedPhoneColumn: suggestMapping(sniffed.sample, hasHeader).phone,
    };
    reply.code(201);
    return { upload: dto };
  });

  app.post('/tools/jobs', auth, async (req, reply) => {
    const { queue, redis } = services();
    const input = parse(createToolJobSchema, req.body);
    const meta = TOOLS[input.tool];
    if (input.uploadIds.length !== meta.inputs) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `Esta ferramenta precisa de ${meta.inputs} arquivo(s).`,
      );
    }
    const params = parse(toolParamsSchemas[input.tool] as z.ZodTypeAny, input.params);
    const uploads: UploadMeta[] = [];
    for (const id of input.uploadIds) {
      const raw = await redis.get(uploadKey(id));
      if (!raw)
        throw new AppError(410, 'UPLOAD_EXPIRED', 'O arquivo enviado expirou. Envie-o novamente.');
      uploads.push(JSON.parse(raw) as UploadMeta);
    }
    const job = await prisma.fileJob.create({
      data: {
        tool: input.tool,
        params,
        inputKeys: uploads.map((u) => ({
          key: u.key,
          name: u.fileName,
          format: u.format,
          encoding: u.encoding,
          delimiter: u.delimiter,
          size: u.size,
        })),
      },
    });
    await queue.add({ jobId: job.id });
    await audit(prisma, req, {
      action: 'tool.started',
      actorId: req.auth!.user.id,
      entityType: 'file_job',
      entityId: job.id,
      details: { tool: input.tool },
    });
    reply.code(201);
    return { job: toJobDTO(job) };
  });

  app.get('/tools/jobs', auth, async (req) => {
    const { limit, tool } = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        tool: z.string().optional(),
      }),
      req.query,
    );
    const items = await prisma.fileJob.findMany({
      where: tool ? { tool } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return { items: items.map(toJobDTO) };
  });

  app.get('/tools/jobs/:id', auth, async (req) => {
    const { id } = parse(jobParams, req.params);
    return { job: toJobDTO(await loadJob(id)) };
  });

  app.get('/tools/jobs/:id/outputs/:index', auth, async (req, reply) => {
    const { storage } = services();
    const { id, index } = parse(
      jobParams.extend({ index: z.coerce.number().int().min(0) }),
      req.params,
    );
    const job = await loadJob(id);
    const output = ((job.outputKeys as unknown as ToolOutput[]) ?? [])[index];
    if (!output) throw Errors.notFound('Arquivo de resultado não encontrado.');
    const safe = output.name.replace(/[^\w.\-]+/g, '_');
    reply
      .header('content-type', output.contentType)
      .header('content-disposition', `attachment; filename="${safe}"`)
      .header('cache-control', 'no-store');
    return reply.send(await storage.get(output.key));
  });

  app.delete('/tools/jobs/:id', auth, async (req) => {
    const { storage } = services();
    const { id } = parse(jobParams, req.params);
    const job = await loadJob(id);
    if (job.status === 'RUNNING' || job.status === 'QUEUED') {
      throw new AppError(409, 'JOB_ACTIVE', 'Aguarde o processamento terminar para excluí-lo.');
    }
    for (const o of (job.outputKeys as unknown as ToolOutput[]) ?? [])
      await storage.delete(o.key).catch(() => undefined);
    await prisma.fileJob.delete({ where: { id } });
    await audit(prisma, req, {
      action: 'tool.deleted',
      actorId: req.auth!.user.id,
      entityType: 'file_job',
      entityId: id,
    });
    return { ok: true };
  });
}
