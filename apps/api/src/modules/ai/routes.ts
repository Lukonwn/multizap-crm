import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AiAgent, AiPersona, Prisma } from '@multizap/database';
import {
  OpenRouterClient,
  OpenRouterError,
  buildMessages,
  buildSystemPrompt,
  estimateCost,
  type ModelInfo,
  type PersonaSpec,
} from '@multizap/ai';
import {
  agentInputSchema,
  agentUpdateSchema,
  personaInputSchema,
  personaUpdateSchema,
  type AgentDTO,
  type AgentVersionDTO,
  type AiModelDTO,
  type AiSettingsDTO,
  type PersonaDTO,
  type PersonaRevisionDTO,
  type TestMessageDTO,
  type TestSessionDTO,
  AI_KEY_AAD,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';

const PROVIDER = 'openrouter';
const KEY_AAD = AI_KEY_AAD;
const MODELS_CACHE_KEY = 'multizap:ai:models';
const MAX_TEST_MESSAGES = 100;

const idParams = z.object({ id: z.string().uuid('Identificador inválido.') });
const confirmSchema = z.object({
  confirmName: z.string().trim().min(1, 'Digite o nome para confirmar.'),
});

/** Campos da persona que entram no prompt (e na fotografia das versões). */
const PERSONA_FIELDS = [
  'name',
  'age',
  'identity',
  'biography',
  'backstory',
  'personality',
  'traits',
  'toneOfVoice',
  'communicationStyle',
  'formality',
  'emojiUsage',
  'responseLength',
  'conversationStart',
  'expressions',
  'instructions',
  'rules',
  'allowedTopics',
  'restrictedTopics',
  'openingMessages',
] as const;
const AGENT_FIELDS = [
  'name',
  'model',
  'temperature',
  'maxTokens',
  'instructions',
  'memoryEnabled',
  'mode',
] as const;

const FIELD_LABEL: Record<string, string> = {
  name: 'nome',
  age: 'idade',
  identity: 'identidade',
  biography: 'biografia',
  backstory: 'história',
  personality: 'personalidade',
  traits: 'traços',
  toneOfVoice: 'tom de voz',
  communicationStyle: 'estilo',
  formality: 'formalidade',
  emojiUsage: 'emojis',
  responseLength: 'tamanho das respostas',
  conversationStart: 'início de conversa',
  expressions: 'expressões',
  instructions: 'instruções',
  rules: 'regras',
  allowedTopics: 'assuntos permitidos',
  restrictedTopics: 'restrições',
  openingMessages: 'mensagens de abertura',
};

type PersonaFields = Pick<AiPersona, (typeof PERSONA_FIELDS)[number]>;
type AgentFields = Pick<AiAgent, (typeof AGENT_FIELDS)[number]>;

export interface AgentSnapshot {
  agent: AgentFields;
  persona: PersonaFields & { id: string };
}

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

/** JSON com chaves em ordem alfabética (o jsonb do PostgreSQL não preserva a ordem). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k] ?? null)}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** Comparação estável de dois valores (para listar campos alterados). */
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

function toPersonaDTO(p: AiPersona & { _count?: { agents: number } }): PersonaDTO {
  return {
    ...pick(p, PERSONA_FIELDS),
    id: p.id,
    isTemplate: p.isTemplate,
    agentCount: p._count?.agents ?? 0,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  } as PersonaDTO;
}

export function snapshotOf(agent: AgentFields, persona: AiPersona): AgentSnapshot {
  return {
    agent: pick(agent, AGENT_FIELDS),
    persona: { ...pick(persona, PERSONA_FIELDS), id: persona.id },
  };
}

const agentInclude = {
  persona: true,
  publishedVersion: { select: { id: true, number: true, createdAt: true, snapshot: true } },
  accounts: {
    include: {
      account: {
        select: {
          id: true,
          name: true,
          status: true,
          integration: { select: { waJid: true } },
          aiAgentLinks: {
            where: { agent: { status: 'ACTIVE' } },
            select: { agent: { select: { id: true, name: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.AiAgentInclude;
type AgentRow = Prisma.AiAgentGetPayload<{ include: typeof agentInclude }>;

const phoneOfJid = (jid: string | null | undefined) => {
  const m = jid ? /^(\d+)(?::\d+)?@/.exec(jid) : null;
  return m ? `+${m[1]}` : null;
};

function toAgentDTO(a: AgentRow): AgentDTO {
  const current = stable(snapshotOf(a, a.persona));
  // O modo de resposta vale na hora (interruptor operacional): não conta como alteração não publicada.
  const snap = a.publishedVersion?.snapshot as unknown as AgentSnapshot | null;
  const published = snap ? stable({ ...snap, agent: { ...snap.agent, mode: a.mode } }) : null;
  return {
    id: a.id,
    name: a.name,
    personaId: a.personaId,
    personaName: a.persona.name,
    model: a.model,
    temperature: a.temperature,
    maxTokens: a.maxTokens,
    instructions: a.instructions,
    memoryEnabled: a.memoryEnabled,
    mode: a.mode,
    status: a.status,
    minIntervalSeconds: a.minIntervalSeconds,
    showTyping: a.showTyping,
    maxRepliesPerHour: a.maxRepliesPerHour,
    publishedVersion: a.publishedVersion
      ? {
          id: a.publishedVersion.id,
          number: a.publishedVersion.number,
          createdAt: a.publishedVersion.createdAt.toISOString(),
        }
      : null,
    hasUnpublishedChanges: published !== current,
    accounts: a.accounts.map((l) => {
      const other = l.account.aiAgentLinks.map((x) => x.agent).find((x) => x.id !== a.id) ?? null;
      return {
        id: l.account.id,
        name: l.account.name,
        phoneE164: phoneOfJid(l.account.integration?.waJid),
        status: l.account.status,
        activeAgent: other,
      };
    }),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function aiRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };
  const actor = (req: FastifyRequest) => req.auth!.user;

  // ─── OpenRouter: chave e cliente ───

  const loadClient = async (): Promise<OpenRouterClient> => {
    const cred = await prisma.aiCredential.findUnique({ where: { provider: PROVIDER } });
    if (!cred)
      throw new AppError(
        409,
        'AI_NOT_CONFIGURED',
        'Configure a chave da OpenRouter em MultiZap AI → Configurações.',
      );
    if (!app.cipher)
      throw new AppError(
        503,
        'AI_CIPHER_UNAVAILABLE',
        'O servidor não está configurado para ler a chave (CREDENTIALS_MASTER_KEY).',
      );
    let apiKey: string;
    try {
      apiKey = app.cipher.decrypt(Buffer.from(cred.keyEnc), KEY_AAD).toString('utf8');
    } catch {
      throw new AppError(
        409,
        'AI_KEY_UNREADABLE',
        'A chave salva não pôde ser lida. Salve a chave da OpenRouter novamente.',
      );
    }
    return new OpenRouterClient({ apiKey, fetchImpl: app.aiFetch, appUrl: app.config.webOrigin });
  };

  const openRouterFailure = (err: unknown): never => {
    if (err instanceof OpenRouterError)
      throw new AppError(502, `OPENROUTER_${err.code}`, err.message);
    throw err;
  };

  const loadModels = async (client: OpenRouterClient): Promise<ModelInfo[]> => {
    const cached = app.redis ? await app.redis.get(MODELS_CACHE_KEY).catch(() => null) : null;
    if (cached) return JSON.parse(cached) as ModelInfo[];
    const models = await client.models();
    if (app.redis)
      await app.redis
        .set(MODELS_CACHE_KEY, JSON.stringify(models), 'EX', 3600)
        .catch(() => undefined);
    return models;
  };

  const recordEvent = (
    agentId: string | null,
    category: 'OPENROUTER' | 'AGENT',
    level: string,
    message: string,
    details: Prisma.InputJsonValue = {},
  ) =>
    prisma.aiAgentEvent
      .create({ data: { agentId, category, level, message: message.slice(0, 500), details } })
      .catch(() => undefined);

  app.get('/ai/settings', auth, async () => {
    const c = await prisma.aiCredential.findUnique({ where: { provider: PROVIDER } });
    const dto: AiSettingsDTO = {
      configured: !!c,
      keyLast4: c?.keyLast4 ?? null,
      lastTestAt: c?.lastTestAt?.toISOString() ?? null,
      lastTestOk: c?.lastTestOk ?? null,
      lastError: c?.lastError ?? null,
      canStoreKey: !!app.cipher,
    };
    return dto;
  });

  app.put('/ai/settings', auth, async (req) => {
    const { apiKey } = parse(
      z.object({ apiKey: z.string().trim().min(10, 'Chave muito curta.').max(400) }),
      req.body,
    );
    if (!app.cipher)
      throw new AppError(
        503,
        'AI_CIPHER_UNAVAILABLE',
        'Defina CREDENTIALS_MASTER_KEY na API para guardar a chave com segurança.',
      );
    const keyEnc = new Uint8Array(app.cipher.encrypt(apiKey, KEY_AAD));
    const data = {
      keyEnc,
      keyVersion: app.cipher.keyVersion,
      keyLast4: apiKey.slice(-4),
      lastTestAt: null,
      lastTestOk: null,
      lastError: null,
    };
    await prisma.aiCredential.upsert({
      where: { provider: PROVIDER },
      create: { provider: PROVIDER, ...data },
      update: data,
    });
    if (app.redis) await app.redis.del(MODELS_CACHE_KEY).catch(() => undefined);
    await audit(prisma, req, {
      action: 'ai.key_updated',
      actorId: actor(req).id,
      entityType: 'ai_settings',
    });
    return { ok: true };
  });

  app.delete('/ai/settings', auth, async (req) => {
    await prisma.aiCredential.deleteMany({ where: { provider: PROVIDER } });
    await audit(prisma, req, {
      action: 'ai.key_removed',
      actorId: actor(req).id,
      entityType: 'ai_settings',
    });
    return { ok: true };
  });

  app.post('/ai/settings/test', auth, async () => {
    const client = await loadClient();
    try {
      const info = await client.keyInfo();
      await prisma.aiCredential.update({
        where: { provider: PROVIDER },
        data: { lastTestAt: new Date(), lastTestOk: true, lastError: null },
      });
      return { ok: true, info };
    } catch (err) {
      const message =
        err instanceof OpenRouterError ? err.message : 'Falha inesperada ao testar a conexão.';
      await prisma.aiCredential.update({
        where: { provider: PROVIDER },
        data: { lastTestAt: new Date(), lastTestOk: false, lastError: message },
      });
      await recordEvent(null, 'OPENROUTER', 'error', `Teste de conexão falhou: ${message}`);
      return { ok: false, error: message };
    }
  });

  app.get('/ai/models', auth, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().max(100).optional() }), req.query);
    const client = await loadClient();
    const models = await loadModels(client).catch(openRouterFailure);
    const needle = q?.toLowerCase();
    const items: AiModelDTO[] = models
      .filter(
        (m) =>
          !needle || m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle),
      )
      .map((m) => ({
        id: m.id,
        name: m.name,
        contextLength: m.contextLength,
        promptPerMillion: m.promptPrice === null ? null : m.promptPrice * 1_000_000,
        completionPerMillion: m.completionPrice === null ? null : m.completionPrice * 1_000_000,
        supportsTemperature: m.supportsTemperature,
      }));
    return { items, total: items.length };
  });

  // ─── Personas ───

  const loadPersona = async (id: string) => {
    const p = await prisma.aiPersona.findUnique({
      where: { id },
      include: { _count: { select: { agents: true } } },
    });
    if (!p) throw Errors.notFound('Persona não encontrada.');
    return p;
  };

  app.get('/ai/personas', auth, async (req) => {
    const { templates } = parse(
      z.object({ templates: z.enum(['true', 'false']).optional() }),
      req.query,
    );
    const rows = await prisma.aiPersona.findMany({
      where: templates ? { isTemplate: templates === 'true' } : {},
      include: { _count: { select: { agents: true } } },
      orderBy: [{ isTemplate: 'asc' }, { name: 'asc' }],
    });
    return { items: rows.map(toPersonaDTO) };
  });

  app.get('/ai/personas/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    return { persona: toPersonaDTO(await loadPersona(id)) };
  });

  app.post('/ai/personas', auth, async (req, reply) => {
    const body = parse(
      personaInputSchema.extend({ isTemplate: z.boolean().default(false) }),
      req.body,
    );
    const { isTemplate, ...data } = body;
    const p = await prisma.aiPersona.create({
      data: { ...data, age: data.age ?? null, isTemplate },
    });
    await prisma.aiPersonaRevision.create({
      data: {
        personaId: p.id,
        snapshot: pick(p, PERSONA_FIELDS) as Prisma.InputJsonValue,
        summary: isTemplate ? 'Template criado' : 'Persona criada',
        changedBy: actor(req).email,
      },
    });
    await audit(prisma, req, {
      action: 'ai.persona_created',
      actorId: actor(req).id,
      entityType: 'ai_persona',
      entityId: p.id,
    });
    reply.code(201);
    return { persona: toPersonaDTO({ ...p, _count: { agents: 0 } }) };
  });

  app.patch('/ai/personas/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const input = parse(personaUpdateSchema, req.body);
    const before = await loadPersona(id);
    const changed = (Object.keys(input) as (keyof typeof input)[]).filter(
      (k) => input[k] !== undefined && !same(input[k], before[k as keyof AiPersona]),
    );
    if (!changed.length) return { persona: toPersonaDTO(before) };
    const p = await prisma.aiPersona.update({
      where: { id },
      data: input,
      include: { _count: { select: { agents: true } } },
    });
    await prisma.aiPersonaRevision.create({
      data: {
        personaId: id,
        snapshot: pick(p, PERSONA_FIELDS) as Prisma.InputJsonValue,
        summary: `Alterado: ${changed.map((k) => FIELD_LABEL[k] ?? k).join(', ')}`,
        changedBy: actor(req).email,
      },
    });
    await audit(prisma, req, {
      action: 'ai.persona_updated',
      actorId: actor(req).id,
      entityType: 'ai_persona',
      entityId: id,
      details: { fields: changed },
    });
    return { persona: toPersonaDTO(p) };
  });

  /** Duplicar, salvar como template (asTemplate) ou criar persona a partir de um template. */
  app.post('/ai/personas/:id/duplicate', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { asTemplate, name } = parse(
      z.object({
        asTemplate: z.boolean().default(false),
        name: z.string().trim().min(2).max(80).optional(),
      }),
      req.body ?? {},
    );
    const src = await loadPersona(id);
    const fields = pick(src, PERSONA_FIELDS);
    const p = await prisma.aiPersona.create({
      data: {
        ...fields,
        name:
          name ?? (src.isTemplate && !asTemplate ? src.name : `${src.name} (cópia)`).slice(0, 80),
        isTemplate: asTemplate,
      },
    });
    await prisma.aiPersonaRevision.create({
      data: {
        personaId: p.id,
        snapshot: pick(p, PERSONA_FIELDS) as Prisma.InputJsonValue,
        summary: asTemplate
          ? `Template salvo a partir de "${src.name}"`
          : src.isTemplate
            ? `Criada a partir do template "${src.name}"`
            : `Duplicada de "${src.name}"`,
        changedBy: actor(req).email,
      },
    });
    await audit(prisma, req, {
      action: 'ai.persona_created',
      actorId: actor(req).id,
      entityType: 'ai_persona',
      entityId: p.id,
      details: { from: src.id, asTemplate },
    });
    reply.code(201);
    return { persona: toPersonaDTO({ ...p, _count: { agents: 0 } }) };
  });

  app.delete('/ai/personas/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { confirmName } = parse(confirmSchema, req.body ?? {});
    const p = await loadPersona(id);
    if (confirmName !== p.name)
      throw new AppError(400, 'CONFIRMATION_MISMATCH', 'O nome digitado não confere.');
    const agents = await prisma.aiAgent.findMany({
      where: { personaId: id },
      select: { name: true },
    });
    if (agents.length)
      throw new AppError(
        409,
        'PERSONA_IN_USE',
        `Em uso pelos agentes: ${agents.map((a) => a.name).join(', ')}. Troque a persona deles antes de excluir.`,
      );
    await prisma.aiPersona.delete({ where: { id } });
    await audit(prisma, req, {
      action: 'ai.persona_deleted',
      actorId: actor(req).id,
      entityType: 'ai_persona',
      entityId: id,
      details: { name: p.name },
    });
    return { ok: true };
  });

  app.get('/ai/personas/:id/revisions', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    await loadPersona(id);
    const rows = await prisma.aiPersonaRevision.findMany({
      where: { personaId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const items: PersonaRevisionDTO[] = rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      changedBy: r.changedBy,
      createdAt: r.createdAt.toISOString(),
      snapshot: r.snapshot as Record<string, unknown>,
    }));
    return { items };
  });

  // ─── Agentes ───

  const loadAgent = async (id: string) => {
    const a = await prisma.aiAgent.findUnique({ where: { id }, include: agentInclude });
    if (!a) throw Errors.notFound('Agente não encontrado.');
    return a;
  };

  const assertUsablePersona = async (personaId: string) => {
    const p = await prisma.aiPersona.findUnique({ where: { id: personaId } });
    if (!p)
      throw new AppError(400, 'VALIDATION_ERROR', 'Persona não encontrada.', {
        personaId: ['Persona não encontrada.'],
      });
    if (p.isTemplate)
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Crie uma persona a partir do template antes de usá-la em um agente.',
        {
          personaId: ['Templates não podem ser usados diretamente.'],
        },
      );
  };

  app.get('/ai/agents', auth, async () => {
    const rows = await prisma.aiAgent.findMany({ include: agentInclude, orderBy: { name: 'asc' } });
    return { items: rows.map(toAgentDTO) };
  });

  app.get('/ai/agents/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    return { agent: toAgentDTO(await loadAgent(id)) };
  });

  app.post('/ai/agents', auth, async (req, reply) => {
    const input = parse(agentInputSchema, req.body);
    await assertUsablePersona(input.personaId);
    const a = await prisma.aiAgent.create({
      data: { ...input, temperature: input.temperature ?? null },
      include: agentInclude,
    });
    await audit(prisma, req, {
      action: 'ai.agent_created',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: a.id,
    });
    reply.code(201);
    return { agent: toAgentDTO(a) };
  });

  app.patch('/ai/agents/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const input = parse(agentUpdateSchema, req.body);
    await loadAgent(id);
    if (input.personaId) await assertUsablePersona(input.personaId);
    const a = await prisma.aiAgent.update({ where: { id }, data: input, include: agentInclude });
    await audit(prisma, req, {
      action: 'ai.agent_updated',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: id,
      details: { fields: Object.keys(input) },
    });
    return { agent: toAgentDTO(a) };
  });

  /** Instâncias atendidas pelo agente (somente dispositivos conectados). */
  app.put('/ai/agents/:id/accounts', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { accountIds } = parse(
      z.object({ accountIds: z.array(z.string().uuid()).max(10) }),
      req.body,
    );
    const agent = await loadAgent(id);
    const unique = [...new Set(accountIds)];
    const accounts = await prisma.account.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, connectionType: true },
    });
    if (accounts.length !== unique.length) throw Errors.notFound('Instância não encontrada.');
    const external = accounts.filter((a) => a.connectionType !== 'WHATSAPP_WEB');
    if (external.length)
      throw new AppError(
        400,
        'NOT_WHATSAPP_WEB',
        `Só dispositivos conectados podem ter agente: ${external.map((a) => a.name).join(', ')}.`,
      );
    if (agent.status === 'ACTIVE') {
      const conflicts = await prisma.aiAgentAccount.findMany({
        where: { accountId: { in: unique }, agentId: { not: id }, agent: { status: 'ACTIVE' } },
        include: { account: { select: { name: true } }, agent: { select: { name: true } } },
      });
      if (conflicts.length)
        throw new AppError(
          409,
          'ACCOUNT_HAS_ACTIVE_AGENT',
          conflicts.map((c) => `${c.account.name} já é atendida por "${c.agent.name}"`).join('; ') +
            '.',
        );
    }
    await prisma.$transaction([
      prisma.aiAgentAccount.deleteMany({ where: { agentId: id, accountId: { notIn: unique } } }),
      ...unique.map((accountId) =>
        prisma.aiAgentAccount.upsert({
          where: { agentId_accountId: { agentId: id, accountId } },
          create: { agentId: id, accountId },
          update: {},
        }),
      ),
    ]);
    await audit(prisma, req, {
      action: 'ai.agent_accounts_updated',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: id,
      details: { accountIds: unique },
    });
    return { agent: toAgentDTO(await loadAgent(id)) };
  });

  /** Publicar: cria uma versão com a fotografia do agente e da persona usadas. */
  app.post('/ai/agents/:id/publish', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { note } = parse(
      z.object({ note: z.string().trim().max(300).optional() }),
      req.body ?? {},
    );
    const agent = await loadAgent(id);
    const version = await prisma.$transaction(async (tx) => {
      const last = await tx.aiAgentVersion.findFirst({
        where: { agentId: id },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const v = await tx.aiAgentVersion.create({
        data: {
          agentId: id,
          number: (last?.number ?? 0) + 1,
          snapshot: snapshotOf(agent, agent.persona) as unknown as Prisma.InputJsonValue,
          note: note || null,
          createdBy: actor(req).email,
        },
      });
      await tx.aiAgent.update({ where: { id }, data: { publishedVersionId: v.id } });
      return v;
    });
    await audit(prisma, req, {
      action: 'ai.agent_published',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: id,
      details: { version: version.number },
    });
    return { agent: toAgentDTO(await loadAgent(id)) };
  });

  app.get('/ai/agents/:id/versions', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const agent = await loadAgent(id);
    const rows = await prisma.aiAgentVersion.findMany({
      where: { agentId: id },
      orderBy: { number: 'desc' },
      take: 50,
    });
    const items: AgentVersionDTO[] = rows.map((v) => {
      const snap = v.snapshot as unknown as AgentSnapshot;
      return {
        id: v.id,
        number: v.number,
        note: v.note,
        createdBy: v.createdBy,
        createdAt: v.createdAt.toISOString(),
        model: snap.agent?.model ?? '',
        personaName: snap.persona?.name ?? '',
        isPublished: agent.publishedVersionId === v.id,
      };
    });
    return { items };
  });

  /**
   * Restaurar: volta a configuração do agente (rascunho) à de uma versão anterior.
   * Nada muda no atendimento até você publicar de novo. A persona é compartilhada e não é
   * alterada; a versão guarda a fotografia da persona daquela época.
   */
  app.post('/ai/agents/:id/versions/:versionId/restore', auth, async (req) => {
    const { id, versionId } = parse(
      z.object({ id: z.string().uuid(), versionId: z.string().uuid() }),
      req.params,
    );
    await loadAgent(id);
    const v = await prisma.aiAgentVersion.findFirst({ where: { id: versionId, agentId: id } });
    if (!v) throw Errors.notFound('Versão não encontrada.');
    const snap = v.snapshot as unknown as AgentSnapshot;
    await prisma.aiAgent.update({ where: { id }, data: pick(snap.agent, AGENT_FIELDS) });
    await audit(prisma, req, {
      action: 'ai.agent_restored',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: id,
      details: { version: v.number },
    });
    return { agent: toAgentDTO(await loadAgent(id)), restoredFrom: v.number };
  });

  app.delete('/ai/agents/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { confirmName } = parse(confirmSchema, req.body ?? {});
    const a = await loadAgent(id);
    if (confirmName !== a.name)
      throw new AppError(400, 'CONFIRMATION_MISMATCH', 'O nome digitado não confere.');
    if (a.status === 'ACTIVE')
      throw new AppError(409, 'AGENT_ACTIVE', 'Pause o agente antes de excluí-lo.');
    await prisma.aiAgent.update({ where: { id }, data: { publishedVersionId: null } });
    await prisma.aiAgent.delete({ where: { id } });
    await audit(prisma, req, {
      action: 'ai.agent_deleted',
      actorId: actor(req).id,
      entityType: 'ai_agent',
      entityId: id,
      details: { name: a.name },
    });
    return { ok: true };
  });

  // ─── Laboratório (simulação: nunca envia mensagens reais) ───

  const toMessageDTO = (m: {
    id: string;
    role: string;
    content: string;
    debug: unknown;
    createdAt: Date;
  }): TestMessageDTO => ({
    id: m.id,
    role: m.role as TestMessageDTO['role'],
    content: m.content,
    debug: (m.debug ?? {}) as TestMessageDTO['debug'],
    createdAt: m.createdAt.toISOString(),
  });

  const sessionDTO = async (id: string): Promise<TestSessionDTO> => {
    const s = await prisma.aiTestSession.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!s) throw Errors.notFound('Sessão de teste não encontrada.');
    const version = s.versionId
      ? await prisma.aiAgentVersion.findUnique({
          where: { id: s.versionId },
          select: { number: true },
        })
      : null;
    let promptTokens = 0;
    let completionTokens = 0;
    let cost: number | null = null;
    for (const m of s.messages) {
      const d = m.debug as TestMessageDTO['debug'];
      promptTokens += d.promptTokens ?? 0;
      completionTokens += d.completionTokens ?? 0;
      if (typeof d.costUsd === 'number') cost = (cost ?? 0) + d.costUsd;
    }
    return {
      id: s.id,
      agentId: s.agentId,
      source: s.source as TestSessionDTO['source'],
      versionNumber: version?.number ?? null,
      createdAt: s.createdAt.toISOString(),
      messages: s.messages.map(toMessageDTO),
      totals: { promptTokens, completionTokens, costUsd: cost },
    };
  };

  app.get('/ai/agents/:id/test-sessions', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const rows = await prisma.aiTestSession.findMany({
      where: { agentId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { _count: { select: { messages: true } } },
    });
    return {
      items: rows.map((s) => ({
        id: s.id,
        source: s.source,
        createdAt: s.createdAt.toISOString(),
        messages: s._count.messages,
      })),
    };
  });

  app.post('/ai/agents/:id/test-sessions', auth, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { source } = parse(
      z.object({ source: z.enum(['draft', 'published']).default('draft') }),
      req.body ?? {},
    );
    const agent = await loadAgent(id);
    if (source === 'published' && !agent.publishedVersionId)
      throw new AppError(409, 'NOT_PUBLISHED', 'Este agente ainda não tem versão publicada.');
    const s = await prisma.aiTestSession.create({
      data: {
        agentId: id,
        source,
        versionId: source === 'published' ? agent.publishedVersionId : null,
      },
    });
    reply.code(201);
    return { session: await sessionDTO(s.id) };
  });

  app.get('/ai/test-sessions/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    return { session: await sessionDTO(id) };
  });

  app.delete('/ai/test-sessions/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    await prisma.aiTestSession.deleteMany({ where: { id } });
    return { ok: true };
  });

  app.post('/ai/test-sessions/:id/messages', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const { text } = parse(
      z.object({ text: z.string().trim().min(1, 'Escreva uma mensagem.').max(2000) }),
      req.body,
    );
    const session = await prisma.aiTestSession.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw Errors.notFound('Sessão de teste não encontrada.');
    if (session.messages.length >= MAX_TEST_MESSAGES)
      throw new AppError(
        409,
        'SESSION_FULL',
        'Esta sessão chegou ao limite de mensagens. Comece uma nova.',
      );
    const agent = await loadAgent(session.agentId);

    // Fonte: rascunho atual ou a versão publicada no momento em que a sessão começou.
    let spec: AgentSnapshot = snapshotOf(agent, agent.persona);
    if (session.source === 'published') {
      const v = session.versionId
        ? await prisma.aiAgentVersion.findUnique({ where: { id: session.versionId } })
        : null;
      if (!v)
        throw new AppError(
          409,
          'NOT_PUBLISHED',
          'A versão publicada desta sessão não existe mais.',
        );
      spec = v.snapshot as unknown as AgentSnapshot;
    }

    const history = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    history.push({ role: 'user', content: text });
    const persona = spec.persona as PersonaSpec;
    const messages = buildMessages(
      persona,
      { name: spec.agent.name, instructions: spec.agent.instructions },
      history,
    );

    const userMsg = await prisma.aiTestMessage.create({
      data: { sessionId: id, role: 'user', content: text },
    });
    let reply;
    try {
      const client = await loadClient();
      const result = await client.chat({
        model: spec.agent.model,
        messages,
        temperature: spec.agent.temperature,
        maxTokens: spec.agent.maxTokens,
      });
      let cost = result.costUsd;
      let confirmed = cost !== null;
      if (cost === null) {
        const models = await loadModels(client).catch(() => [] as ModelInfo[]);
        cost = estimateCost(
          result.promptTokens,
          result.completionTokens,
          models.find((m) => m.id === spec.agent.model),
        );
        confirmed = false;
      }
      await prisma.aiTokenUsage.create({
        data: {
          agentId: agent.id,
          context: 'TEST',
          model: result.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          costUsd: cost,
          costConfirmed: confirmed,
          latencyMs: result.latencyMs,
        },
      });
      reply = await prisma.aiTestMessage.create({
        data: {
          sessionId: id,
          role: 'assistant',
          content: result.content,
          debug: {
            model: result.model,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            costUsd: cost,
            costConfirmed: confirmed,
            latencyMs: result.latencyMs,
            systemPrompt: buildSystemPrompt(persona, {
              name: spec.agent.name,
              instructions: spec.agent.instructions,
            }),
          },
        },
      });
    } catch (err) {
      if (!(err instanceof OpenRouterError) && !(err instanceof AppError)) throw err;
      const message = err.message;
      const code = err instanceof OpenRouterError ? err.code : err.code;
      if (err instanceof OpenRouterError)
        await recordEvent(agent.id, 'OPENROUTER', 'error', `Laboratório: ${message}`, { code });
      reply = await prisma.aiTestMessage.create({
        data: { sessionId: id, role: 'error', content: message, debug: { errorCode: code } },
      });
    }
    return { messages: [toMessageDTO(userMsg), toMessageDTO(reply)] };
  });
}
