import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@multizap/database';
import { minorTermInObject, type ModelInfo } from '@multizap/ai';
import {
  GENERATOR_DOC_EXTENSIONS,
  GENERATOR_IMAGE_EXTENSIONS,
  GENERATOR_LIMITS,
  MAX_KNOWLEDGE_SOURCES,
  generatorApplySchema,
  type AiGenerationDTO,
  type GeneratorPackage,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';
import { FIELD_LABEL, PERSONA_FIELDS, pick, same } from './routes';

const idParams = z.object({ id: z.string().uuid('Identificador inválido.') });
const actor = (req: FastifyRequest) => req.auth!.user;
const MODELS_CACHE_KEY = 'multizap:ai:models';
const MAX_IN_FLIGHT = 2;

const extOf = (n: string) => n.split('.').pop()?.toLowerCase() ?? '';
const safeName = (n: string) => n.replace(/[^\w.\-]+/g, '_').slice(0, 80);

const createFields = z.object({
  description: z
    .string()
    .trim()
    .min(10, 'Descreva o negócio com ao menos 10 caracteres.')
    .max(GENERATOR_LIMITS.maxDescriptionChars, 'Descrição grande demais.'),
  model: z.string().trim().min(3, 'Escolha o modelo.').max(200),
  links: z.array(z.string().trim().url('Link inválido.').max(2000)).max(GENERATOR_LIMITS.maxLinks),
  targetAgentId: z.string().uuid().optional(),
});

function toDTO(g: Prisma.AiGenerationGetPayload<object>): AiGenerationDTO {
  return {
    id: g.id,
    status: g.status,
    error: g.error,
    model: g.model,
    description: g.description,
    links: (g.links as string[]) ?? [],
    files: ((g.files as { name: string; kind: 'doc' | 'image' }[]) ?? []).map(({ name, kind }) => ({
      name,
      kind,
    })),
    targetAgentId: g.targetAgentId,
    result: (g.result as GeneratorPackage | null) ?? null,
    promptTokens: g.promptTokens,
    completionTokens: g.completionTokens,
    costUsd: g.costUsd === null ? null : Number(g.costUsd),
    costConfirmed: g.costConfirmed,
    appliedAt: g.appliedAt?.toISOString() ?? null,
    createdAt: g.createdAt.toISOString(),
  };
}

/** Termos que sugerem menor de idade nunca são salvos, venham de onde vierem. */
function assertAdult(value: unknown) {
  const term = minorTermInObject(value);
  if (term)
    throw new AppError(
      400,
      'MINOR_TERM',
      `Não é possível aplicar: o texto sugere menor de idade ("${term}"). A persona e o agente atendem apenas adultos.`,
    );
}

/** Gerador de Persona: pedido, acompanhamento, revisão e aplicação do pacote como rascunho. */
export async function aiGeneratorRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };

  app.post('/ai/generator', auth, async (req, reply) => {
    if (!app.storage) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Armazenamento indisponível.');
    if (!app.generatorQueue)
      throw new AppError(503, 'QUEUE_UNAVAILABLE', 'O processamento está indisponível no momento.');
    const id = randomUUID();
    const stored: {
      name: string;
      key: string;
      kind: 'doc' | 'image';
      mime: string;
      size: number;
    }[] = [];
    const fields: Record<string, string> = {};
    const rollback = async () => {
      for (const f of stored) await app.storage!.delete(f.key).catch(() => undefined);
    };

    try {
      // Os arquivos vão para o bucket um a um (nunca vários na memória ao mesmo tempo).
      const parts = req.parts({
        limits: {
          files: GENERATOR_LIMITS.maxDocs + GENERATOR_LIMITS.maxImages + 1,
          fields: 10,
          parts: 30,
          fileSize: GENERATOR_LIMITS.maxDocBytes,
        },
      });
      for await (const part of parts) {
        if (part.type !== 'file') {
          fields[part.fieldname] = String(part.value ?? '');
          continue;
        }
        const ext = extOf(part.filename);
        const isDoc = (GENERATOR_DOC_EXTENSIONS as readonly string[]).includes(ext);
        const isImage = (GENERATOR_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
        if (!isDoc && !isImage) {
          part.file.resume();
          throw new AppError(
            400,
            'UNSUPPORTED_FORMAT',
            `Formato não suportado: ${part.filename}. Envie PDF, DOCX, TXT, MD, CSV, PNG, JPG ou WEBP.`,
          );
        }
        let buf: Buffer;
        try {
          buf = await part.toBuffer();
        } catch {
          throw new AppError(
            413,
            'FILE_TOO_LARGE',
            `Arquivo grande demais: ${part.filename} (documentos até ${GENERATOR_LIMITS.maxDocBytes / 1024 / 1024} MB, imagens até ${GENERATOR_LIMITS.maxImageBytes / 1024 / 1024} MB).`,
          );
        }
        if (!buf.length)
          throw new AppError(400, 'EMPTY_FILE', `O arquivo ${part.filename} está vazio.`);
        if (isImage && buf.length > GENERATOR_LIMITS.maxImageBytes)
          throw new AppError(
            413,
            'FILE_TOO_LARGE',
            `Imagem grande demais: ${part.filename} (máximo de ${GENERATOR_LIMITS.maxImageBytes / 1024 / 1024} MB).`,
          );
        const kind = isImage ? 'image' : 'doc';
        if (
          stored.filter((f) => f.kind === 'doc').length >= GENERATOR_LIMITS.maxDocs &&
          kind === 'doc'
        )
          throw new AppError(
            400,
            'TOO_MANY_FILES',
            `Máximo de ${GENERATOR_LIMITS.maxDocs} documentos.`,
          );
        if (
          stored.filter((f) => f.kind === 'image').length >= GENERATOR_LIMITS.maxImages &&
          kind === 'image'
        )
          throw new AppError(
            400,
            'TOO_MANY_FILES',
            `Máximo de ${GENERATOR_LIMITS.maxImages} imagens.`,
          );
        const key = `ai/generator/${id}/${stored.length}-${safeName(part.filename)}`;
        const mime = isImage ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream';
        await app.storage.put(key, buf, { contentType: mime });
        stored.push({ name: part.filename.slice(0, 120), key, kind, mime, size: buf.length });
      }

      let links: unknown = [];
      const rawLinks = fields.links ?? '';
      try {
        links = rawLinks ? JSON.parse(rawLinks) : [];
      } catch {
        links = rawLinks
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
      }
      const input = parse(createFields, {
        description: fields.description ?? '',
        model: fields.model ?? '',
        links,
        ...(fields.targetAgentId && { targetAgentId: fields.targetAgentId }),
      });
      if (input.links.some((l) => !/^https?:\/\//i.test(l)))
        throw new AppError(400, 'INVALID_URL', 'Só links http e https são aceitos.');

      if (!(await prisma.aiCredential.findUnique({ where: { provider: 'openrouter' } })))
        throw new AppError(
          409,
          'AI_NOT_CONFIGURED',
          'Configure a chave da OpenRouter em MultiZap AI → Configurações.',
        );
      if (input.targetAgentId) {
        const exists = await prisma.aiAgent.findUnique({
          where: { id: input.targetAgentId },
          select: { id: true },
        });
        if (!exists) throw Errors.notFound('Agente não encontrado.');
      }
      if (stored.some((f) => f.kind === 'image')) {
        // Se a lista de modelos já foi carregada, confere se o modelo aceita imagens.
        const raw = app.redis ? await app.redis.get(MODELS_CACHE_KEY).catch(() => null) : null;
        const m = raw
          ? (JSON.parse(raw) as ModelInfo[]).find((x) => x.id === input.model)
          : undefined;
        if (m && m.supportsImages === false)
          throw new AppError(
            400,
            'MODEL_NO_IMAGES',
            'Esse modelo não aceita imagens. Escolha um modelo com suporte a imagem ou remova as imagens.',
          );
      }
      const inFlight = await prisma.aiGeneration.count({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
      });
      if (inFlight >= MAX_IN_FLIGHT)
        throw new AppError(
          409,
          'GENERATOR_BUSY',
          'Já há gerações em andamento. Aguarde terminarem para pedir outra.',
        );

      const g = await prisma.aiGeneration.create({
        data: {
          id,
          model: input.model,
          description: input.description,
          links: input.links,
          files: stored,
          targetAgentId: input.targetAgentId ?? null,
        },
      });
      await app.generatorQueue.add(g.id);
      await audit(prisma, req, {
        action: 'ai.generator_requested',
        actorId: actor(req).id,
        entityType: 'ai_generation',
        entityId: g.id,
        details: { model: input.model, files: stored.length, links: input.links.length },
      });
      reply.code(202);
      return { generation: toDTO(g) };
    } catch (err) {
      await rollback();
      throw err;
    }
  });

  app.get('/ai/generator', auth, async () => {
    const rows = await prisma.aiGeneration.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    return { items: rows.map((g) => ({ ...toDTO(g), result: null })) };
  });

  app.get('/ai/generator/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const g = await prisma.aiGeneration.findUnique({ where: { id } });
    if (!g) throw Errors.notFound('Geração não encontrada.');
    return { generation: toDTO(g) };
  });

  app.delete('/ai/generator/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const g = await prisma.aiGeneration.findUnique({ where: { id } });
    if (!g) throw Errors.notFound('Geração não encontrada.');
    if (g.status === 'PROCESSING')
      throw new AppError(409, 'IN_PROGRESS', 'Aguarde a geração terminar para apagar.');
    for (const f of (g.files as { key?: string }[]) ?? [])
      if (f.key && app.storage) await app.storage.delete(f.key).catch(() => undefined);
    await prisma.aiGeneration.delete({ where: { id } });
    return { ok: true };
  });

  /**
   * Aplica o pacote (já revisado e possivelmente editado pelo administrador) como RASCUNHO.
   * Nada é publicado nem ativado. Conhecimento ligado a um agente ativo vale na hora.
   */
  app.post('/ai/generator/:id/apply', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const input = parse(generatorApplySchema, req.body);
    const g = await prisma.aiGeneration.findUnique({ where: { id } });
    if (!g) throw Errors.notFound('Geração não encontrada.');
    if (g.status !== 'READY')
      throw new AppError(409, 'NOT_READY', 'A geração ainda não terminou ou falhou.');
    if (g.appliedAt)
      throw new AppError(
        409,
        'ALREADY_APPLIED',
        'Este pacote já foi aplicado. Gere outro para criar novos itens.',
      );
    const pkg = input.package;
    assertAdult(pkg);

    const wantKnowledge = input.sections.knowledge;
    const newSources = wantKnowledge
      ? [
          ...pkg.knowledge.texts.map((t) => ({
            name: t.name,
            kind: 'TEXT' as const,
            content: t.content,
            question: null as string | null,
          })),
          ...pkg.knowledge.qa.map((q) => ({
            name: q.question.slice(0, 120),
            kind: 'QA' as const,
            content: q.answer,
            question: q.question as string | null,
          })),
        ]
      : [];
    if (newSources.length) {
      const total = await prisma.aiKnowledgeSource.count();
      if (total + newSources.length > MAX_KNOWLEDGE_SOURCES)
        throw new AppError(
          409,
          'KNOWLEDGE_LIMIT',
          `O pacote cria ${newSources.length} fontes e o limite é ${MAX_KNOWLEDGE_SOURCES} (você tem ${total}). Exclua algumas ou desmarque o conhecimento.`,
        );
    }

    const { age, ...personaRest } = pkg.persona;
    const personaData = { ...personaRest, age: age ?? null };

    const result = await prisma.$transaction(async (tx) => {
      let agentId: string;
      let personaId: string;
      const changes: string[] = [];

      if (input.mode === 'new') {
        const persona = await tx.aiPersona.create({ data: { ...personaData, isTemplate: false } });
        await tx.aiPersonaRevision.create({
          data: {
            personaId: persona.id,
            snapshot: pick(persona, PERSONA_FIELDS) as Prisma.InputJsonValue,
            summary: 'Persona criada pelo Gerador de Persona',
            changedBy: actor(req).email ?? null,
          },
        });
        const agent = await tx.aiAgent.create({
          data: {
            name: input.agentName!,
            personaId: persona.id,
            model: input.agentModel!,
            instructions: pkg.agentInstructions || null,
            mode: 'REVIEW',
            status: 'DRAFT',
          },
        });
        agentId = agent.id;
        personaId = persona.id;
        changes.push('persona', 'instruções');
      } else {
        const agent = await tx.aiAgent.findUnique({
          where: { id: input.agentId! },
          include: { persona: true },
        });
        if (!agent) throw Errors.notFound('Agente não encontrado.');
        agentId = agent.id;
        personaId = agent.personaId;
        if (input.sections.persona) {
          // Só entram campos que o pacote realmente preencheu: o que veio vazio não apaga nada.
          const fields = Object.entries(personaData).filter(([k, v]) => {
            if (v === null || v === undefined || v === '') return false;
            if (Array.isArray(v) && !v.length) return false;
            return !same(v, agent.persona[k as keyof typeof agent.persona]);
          });
          if (fields.length) {
            const updated = await tx.aiPersona.update({
              where: { id: agent.personaId },
              data: Object.fromEntries(fields),
            });
            await tx.aiPersonaRevision.create({
              data: {
                personaId: updated.id,
                snapshot: pick(updated, PERSONA_FIELDS) as Prisma.InputJsonValue,
                summary: `Alterado pelo Gerador de Persona: ${fields
                  .map(([k]) => FIELD_LABEL[k] ?? k)
                  .join(', ')}`,
                changedBy: actor(req).email ?? null,
              },
            });
            changes.push('persona');
          }
        }
        if (input.sections.instructions && pkg.agentInstructions) {
          await tx.aiAgent.update({
            where: { id: agent.id },
            data: { instructions: pkg.agentInstructions },
          });
          changes.push('instruções');
        }
      }

      const sourceIds: string[] = [];
      for (const src of newSources) {
        const row = await tx.aiKnowledgeSource.create({ data: src });
        sourceIds.push(row.id);
      }
      if (sourceIds.length) {
        await tx.aiAgentKnowledge.createMany({
          data: sourceIds.map((sourceId) => ({ agentId, sourceId })),
          skipDuplicates: true,
        });
        changes.push(`${sourceIds.length} fonte(s) de conhecimento`);
      }
      await tx.aiGeneration.update({ where: { id }, data: { appliedAt: new Date() } });
      return { agentId, personaId, sourceIds, changes };
    });

    // Fora da transação: só agora a fila processa as fontes (elas já existem no banco).
    if (app.knowledgeQueue) for (const sid of result.sourceIds) await app.knowledgeQueue.add(sid);
    await audit(prisma, req, {
      action: 'ai.generator_applied',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: result.agentId,
      details: { mode: input.mode, changes: result.changes },
    });
    const agent = await prisma.aiAgent.findUniqueOrThrow({
      where: { id: result.agentId },
      select: { status: true },
    });
    return {
      agentId: result.agentId,
      personaId: result.personaId,
      knowledgeCount: result.sourceIds.length,
      changes: result.changes,
      /** Agente já ativo: instruções e persona só valem ao publicar; conhecimento vale já. */
      agentActive: agent.status === 'ACTIVE',
    };
  });
}
