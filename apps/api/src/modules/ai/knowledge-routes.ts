import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@multizap/database';
import {
  KNOWLEDGE_FILE_EXTENSIONS,
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_KNOWLEDGE_SOURCES,
  knowledgeLinkSchema,
  knowledgeQaSchema,
  knowledgeTextSchema,
  knowledgeUpdateSchema,
  type AiKnowledgeSourceDTO,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';

const idParams = z.object({ id: z.string().uuid('Identificador inválido.') });
const actor = (req: FastifyRequest) => req.auth!.user;

const include = {
  agents: { include: { agent: { select: { id: true, name: true } } } },
} satisfies Prisma.AiKnowledgeSourceInclude;
type Row = Prisma.AiKnowledgeSourceGetPayload<{ include: typeof include }>;

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
};

function toDTO(s: Row): AiKnowledgeSourceDTO {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    status: s.status,
    error: s.error,
    enabled: s.enabled,
    question: s.question,
    preview: s.content ? s.content.slice(0, 240) : null,
    url: s.url,
    fileName: s.fileName,
    sizeBytes: s.sizeBytes,
    chunkCount: s.chunkCount,
    processedAt: s.processedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    agents: s.agents.map((a) => a.agent),
  };
}

/** Base de conhecimento do MultiZap AI: fontes, processamento e vínculo com os agentes. */
export async function aiKnowledgeRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  const load = async (id: string) => {
    const s = await prisma.aiKnowledgeSource.findUnique({ where: { id }, include });
    if (!s) throw Errors.notFound('Fonte não encontrada.');
    return s;
  };

  const enqueue = async (id: string) => {
    if (!app.knowledgeQueue)
      throw new AppError(
        503,
        'QUEUE_UNAVAILABLE',
        'O processamento está indisponível no momento (fila não configurada).',
      );
    await app.knowledgeQueue.add(id);
  };

  const assertRoom = async () => {
    if ((await prisma.aiKnowledgeSource.count()) >= MAX_KNOWLEDGE_SOURCES)
      throw new AppError(
        409,
        'KNOWLEDGE_LIMIT',
        `Limite de ${MAX_KNOWLEDGE_SOURCES} fontes atingido. Exclua alguma antes de adicionar outra.`,
      );
  };

  const created = async (req: FastifyRequest, id: string, kind: string) => {
    await audit(prisma, req, {
      action: 'ai.knowledge_created',
      actorId: actor(req).id,
      entityType: 'ai_knowledge',
      entityId: id,
      details: { kind },
    });
  };

  app.get('/ai/knowledge', auth, async (req) => {
    const q = parse(
      z.object({
        kind: z.enum(['TEXT', 'QA', 'FILE', 'LINK']).optional(),
        status: z.enum(['PENDING', 'PROCESSING', 'READY', 'ERROR']).optional(),
        q: z.string().trim().max(100).optional(),
      }),
      req.query,
    );
    const rows = await prisma.aiKnowledgeSource.findMany({
      where: {
        ...(q.kind && { kind: q.kind }),
        ...(q.status && { status: q.status }),
        ...(q.q && { name: { contains: q.q, mode: 'insensitive' as const } }),
      },
      orderBy: { createdAt: 'desc' },
      include,
    });
    return { items: rows.map(toDTO), limit: MAX_KNOWLEDGE_SOURCES };
  });

  app.get('/ai/knowledge/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const s = await load(id);
    const chunks = await prisma.aiKnowledgeChunk.findMany({
      where: { sourceId: id },
      orderBy: { position: 'asc' },
      take: 50,
      select: { id: true, position: true, title: true, content: true },
    });
    return {
      source: { ...toDTO(s), content: s.content },
      chunks,
    };
  });

  app.post('/ai/knowledge/text', auth, async (req, reply) => {
    const input = parse(knowledgeTextSchema, req.body);
    await assertRoom();
    const s = await prisma.aiKnowledgeSource.create({
      data: { name: input.name, kind: 'TEXT', content: input.content },
      include,
    });
    await enqueue(s.id);
    await created(req, s.id, 'TEXT');
    reply.code(201);
    return { source: toDTO(s) };
  });

  app.post('/ai/knowledge/qa', auth, async (req, reply) => {
    const input = parse(knowledgeQaSchema, req.body);
    await assertRoom();
    const s = await prisma.aiKnowledgeSource.create({
      data: {
        name: input.name ?? input.question.slice(0, 120),
        kind: 'QA',
        question: input.question,
        content: input.answer,
      },
      include,
    });
    await enqueue(s.id);
    await created(req, s.id, 'QA');
    reply.code(201);
    return { source: toDTO(s) };
  });

  app.post('/ai/knowledge/link', auth, async (req, reply) => {
    const input = parse(knowledgeLinkSchema, req.body);
    if (!/^https?:\/\//i.test(input.url))
      throw new AppError(400, 'INVALID_URL', 'Só links http e https são aceitos.');
    await assertRoom();
    const s = await prisma.aiKnowledgeSource.create({
      data: { name: input.name ?? input.url.slice(0, 120), kind: 'LINK', url: input.url },
      include,
    });
    await enqueue(s.id);
    await created(req, s.id, 'LINK');
    reply.code(201);
    return { source: toDTO(s) };
  });

  app.post('/ai/knowledge/file', auth, async (req, reply) => {
    if (!app.storage) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Armazenamento indisponível.');
    const file = await req.file().catch(() => undefined);
    if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Selecione um arquivo.');
    const ext = file.filename.split('.').pop()?.toLowerCase() ?? '';
    if (!(KNOWLEDGE_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
      file.file.resume();
      throw new AppError(
        400,
        'UNSUPPORTED_FORMAT',
        'Formato não suportado. Envie PDF, DOCX, TXT, MD ou CSV.',
      );
    }
    await assertRoom();
    const nameField = (file.fields.name as { value?: string } | undefined)?.value?.trim();
    const id = randomUUID();
    const key = `ai/knowledge/${id}.${ext}`;
    let size = 0;
    let exceeded = false;
    // Acima do limite o resto do envio é descartado (sem erros no fluxo) e a fonte é recusada no fim.
    const meter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        size += chunk.length;
        if (size > MAX_KNOWLEDGE_FILE_BYTES) {
          exceeded = true;
          return cb();
        }
        cb(null, chunk);
      },
    });
    try {
      await app.storage.put(key, file.file.pipe(meter), { contentType: CONTENT_TYPES[ext] });
    } catch (err) {
      file.file.resume();
      await app.storage.delete(key).catch(() => undefined);
      throw err;
    }
    if (exceeded || file.file.truncated) {
      await app.storage.delete(key).catch(() => undefined);
      throw new AppError(
        413,
        'FILE_TOO_LARGE',
        `Arquivo maior que o limite de ${MAX_KNOWLEDGE_FILE_BYTES / 1024 / 1024} MB.`,
      );
    }
    if (!size) {
      await app.storage.delete(key).catch(() => undefined);
      throw new AppError(400, 'EMPTY_FILE', 'O arquivo está vazio.');
    }
    const s = await prisma.aiKnowledgeSource.create({
      data: {
        name: (nameField || file.filename).slice(0, 120),
        kind: 'FILE',
        storageKey: key,
        fileName: file.filename.slice(0, 200),
        mimeType: CONTENT_TYPES[ext],
        sizeBytes: size,
      },
      include,
    });
    await enqueue(s.id);
    await created(req, s.id, 'FILE');
    reply.code(201);
    return { source: toDTO(s) };
  });

  app.patch('/ai/knowledge/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const input = parse(knowledgeUpdateSchema, req.body);
    const current = await load(id);
    const contentChange = input.content !== undefined || input.question !== undefined;
    if (contentChange && current.kind !== 'TEXT' && current.kind !== 'QA')
      throw new AppError(
        400,
        'NOT_EDITABLE',
        'O conteúdo de arquivos e links não pode ser editado. Envie de novo ou reprocesse.',
      );
    if (input.question !== undefined && current.kind !== 'QA')
      throw new AppError(400, 'NOT_EDITABLE', 'Só perguntas e respostas têm pergunta.');
    const s = await prisma.aiKnowledgeSource.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.content !== undefined && { content: input.content }),
        ...(input.question !== undefined && { question: input.question }),
        ...(contentChange && { status: 'PENDING' as const, error: null }),
      },
      include,
    });
    if (contentChange) await enqueue(id);
    await audit(prisma, req, {
      action: 'ai.knowledge_updated',
      actorId: actor(req).id,
      entityType: 'ai_knowledge',
      entityId: id,
      details: { fields: Object.keys(input) },
    });
    return { source: toDTO(s) };
  });

  app.post('/ai/knowledge/:id/reprocess', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const s = await load(id);
    if (s.status === 'PROCESSING' || s.status === 'PENDING')
      throw new AppError(409, 'ALREADY_QUEUED', 'Esta fonte já está sendo processada.');
    await prisma.aiKnowledgeSource.update({
      where: { id },
      data: { status: 'PENDING', error: null },
    });
    await enqueue(id);
    await audit(prisma, req, {
      action: 'ai.knowledge_reprocessed',
      actorId: actor(req).id,
      entityType: 'ai_knowledge',
      entityId: id,
    });
    reply.code(202);
    return { ok: true };
  });

  app.delete('/ai/knowledge/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { confirmName } = parse(
      z.object({ confirmName: z.string().trim().min(1, 'Digite o nome para confirmar.') }),
      req.body ?? {},
    );
    const s = await load(id);
    if (confirmName !== s.name)
      throw new AppError(400, 'NAME_MISMATCH', 'O nome digitado não confere.');
    await prisma.aiKnowledgeSource.delete({ where: { id } });
    if (s.storageKey && app.storage) await app.storage.delete(s.storageKey).catch(() => undefined);
    await audit(prisma, req, {
      action: 'ai.knowledge_deleted',
      actorId: actor(req).id,
      entityType: 'ai_knowledge',
      entityId: id,
      details: { kind: s.kind },
    });
    return { ok: true };
  });

  // ─── Fontes de cada agente ───

  app.get('/ai/agents/:id/knowledge', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    if (!(await prisma.aiAgent.findUnique({ where: { id }, select: { id: true } })))
      throw Errors.notFound('Agente não encontrado.');
    const rows = await prisma.aiAgentKnowledge.findMany({
      where: { agentId: id },
      select: { sourceId: true },
    });
    return { sourceIds: rows.map((r) => r.sourceId) };
  });

  app.put('/ai/agents/:id/knowledge', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { sourceIds } = parse(
      z.object({ sourceIds: z.array(z.string().uuid()).max(MAX_KNOWLEDGE_SOURCES) }),
      req.body,
    );
    if (!(await prisma.aiAgent.findUnique({ where: { id }, select: { id: true } })))
      throw Errors.notFound('Agente não encontrado.');
    const unique = [...new Set(sourceIds)];
    const found = await prisma.aiKnowledgeSource.count({ where: { id: { in: unique } } });
    if (found !== unique.length) throw Errors.notFound('Fonte não encontrada.');
    await prisma.$transaction([
      prisma.aiAgentKnowledge.deleteMany({ where: { agentId: id, sourceId: { notIn: unique } } }),
      prisma.aiAgentKnowledge.createMany({
        data: unique.map((sourceId) => ({ agentId: id, sourceId })),
        skipDuplicates: true,
      }),
    ]);
    await audit(prisma, req, {
      action: 'ai.agent_knowledge_updated',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: id,
      details: { count: unique.length },
    });
    return { sourceIds: unique };
  });
}
