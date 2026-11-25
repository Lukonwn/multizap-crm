import { z } from 'zod';

// ─── MultiZap AI ───

export const FORMALITY_OPTIONS = ['formal', 'neutral', 'informal'] as const;
export const EMOJI_OPTIONS = ['none', 'low', 'medium', 'high'] as const;
export const LENGTH_OPTIONS = ['short', 'medium', 'long'] as const;
/** Contexto criptográfico (AAD) da chave da OpenRouter guardada no banco. */
export const AI_KEY_AAD = 'ai:openrouter:key';

/** Fila do atendimento: o gateway enfileira cada mensagem recebida; o worker responde. */
export const AI_QUEUE = 'ai-inbound';
export interface AiInboundJob {
  accountId: string;
  conversationId: string;
  messageId: string;
}
/** Espera antes de responder, para juntar mensagens enviadas em sequência. */
export const AI_DEBOUNCE_MS = 6_000;
/** Contato que recebeu campanha não é atendido pela IA durante este período. */
export const AI_CAMPAIGN_QUIET_DAYS = 7;
/** Uma resposta de pessoa (Central ou celular) mais recente que isto pausa a IA na conversa. */
export const AI_HUMAN_WINDOW_HOURS = 12;
/** Teto de respostas da IA por instância por hora (proteção contra excesso de envio). */
export const AI_ACCOUNT_HOURLY_CAP = 60;

/** Fila de processamento das fontes de conhecimento (arquivos e links são lidos pelo worker). */
export const AI_KNOWLEDGE_QUEUE = 'ai-knowledge';
export interface AiKnowledgeJob {
  sourceId: string;
}
export const MAX_KNOWLEDGE_SOURCES = 200;
export const MAX_KNOWLEDGE_FILE_BYTES = 10 * 1024 * 1024;
export const KNOWLEDGE_FILE_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'csv'] as const;

export const KNOWLEDGE_KINDS = ['TEXT', 'QA', 'FILE', 'LINK'] as const;
export const KNOWLEDGE_KIND_LABEL: Record<(typeof KNOWLEDGE_KINDS)[number], string> = {
  TEXT: 'Texto',
  QA: 'Pergunta e resposta',
  FILE: 'Arquivo',
  LINK: 'Link',
};
export const KNOWLEDGE_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Na fila',
  PROCESSING: 'Processando',
  READY: 'Pronta',
  ERROR: 'Com erro',
};

const kbName = z.string().trim().min(2, 'Informe um nome com ao menos 2 caracteres.').max(120);
export const knowledgeTextSchema = z.object({
  name: kbName,
  content: z.string().trim().min(10, 'Escreva um texto com ao menos 10 caracteres.').max(200_000),
});
export const knowledgeQaSchema = z.object({
  question: z.string().trim().min(3, 'Escreva a pergunta.').max(500),
  answer: z.string().trim().min(2, 'Escreva a resposta.').max(4000),
  name: kbName.optional(),
});
export const knowledgeLinkSchema = z.object({
  url: z
    .string()
    .trim()
    .url('Informe um endereço completo, começando com http:// ou https://.')
    .max(2000),
  name: kbName.optional(),
});
export const knowledgeUpdateSchema = z.object({
  name: kbName.optional(),
  enabled: z.boolean().optional(),
  /** Texto (TEXT) ou resposta (QA): reprocessa a fonte. */
  content: z.string().trim().min(2).max(200_000).optional(),
  question: z.string().trim().min(3).max(500).optional(),
});

export interface AiKnowledgeSourceDTO {
  id: string;
  name: string;
  kind: (typeof KNOWLEDGE_KINDS)[number];
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'ERROR';
  error: string | null;
  enabled: boolean;
  question: string | null;
  /** Início do conteúdo (texto e resposta). */
  preview: string | null;
  url: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  chunkCount: number;
  processedAt: string | null;
  createdAt: string;
  agents: { id: string; name: string }[];
}

export interface AiKnowledgeUsedDTO {
  sourceId: string;
  name: string;
  snippet: string;
}

export const AGENT_MODES = ['REVIEW', 'AUTO'] as const;

export const FORMALITY_LABEL: Record<(typeof FORMALITY_OPTIONS)[number], string> = {
  formal: 'Formal',
  neutral: 'Neutro',
  informal: 'Informal',
};
export const EMOJI_LABEL: Record<(typeof EMOJI_OPTIONS)[number], string> = {
  none: 'Nunca',
  low: 'Raramente',
  medium: 'Com moderação',
  high: 'Com frequência',
};
export const LENGTH_LABEL: Record<(typeof LENGTH_OPTIONS)[number], string> = {
  short: 'Curtas',
  medium: 'Médias',
  long: 'Longas',
};
export const AGENT_MODE_LABEL: Record<(typeof AGENT_MODES)[number], string> = {
  REVIEW: 'Revisão humana',
  AUTO: 'Automático',
};
export const AGENT_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Rascunho',
  ACTIVE: 'Ativo',
  PAUSED: 'Pausado',
  ERROR: 'Com erro',
};

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Máximo de ${max} caracteres.`)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const list = (maxItems: number, maxLen: number) =>
  z
    .array(z.string().trim().min(1).max(maxLen))
    .max(maxItems, `Máximo de ${maxItems} itens.`)
    .default([]);

export const personaInputSchema = z.object({
  name: z.string().trim().min(2, 'Informe um nome com ao menos 2 caracteres.').max(80),
  age: z.coerce
    .number()
    .int()
    .min(18, 'A persona precisa ter 18 anos ou mais.')
    .max(120)
    .optional()
    .nullable(),
  identity: text(600),
  biography: text(3000),
  backstory: text(3000),
  personality: text(1500),
  traits: text(1500),
  toneOfVoice: text(600),
  communicationStyle: text(1500),
  formality: z.enum(FORMALITY_OPTIONS).default('neutral'),
  emojiUsage: z.enum(EMOJI_OPTIONS).default('low'),
  responseLength: z.enum(LENGTH_OPTIONS).default('short'),
  conversationStart: text(1000),
  expressions: list(30, 120),
  instructions: text(4000),
  rules: text(4000),
  allowedTopics: text(2000),
  restrictedTopics: text(2000),
  openingMessages: list(10, 500),
});
export type PersonaInput = z.input<typeof personaInputSchema>;
export const personaUpdateSchema = personaInputSchema.partial();

export interface PersonaDTO extends Omit<z.output<typeof personaInputSchema>, 'age'> {
  id: string;
  age: number | null;
  isTemplate: boolean;
  agentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaRevisionDTO {
  id: string;
  summary: string;
  changedBy: string | null;
  createdAt: string;
  snapshot: Record<string, unknown>;
}

export const agentInputSchema = z.object({
  name: z.string().trim().min(2, 'Informe um nome com ao menos 2 caracteres.').max(80),
  personaId: z.string().uuid('Escolha uma persona.'),
  model: z.string().trim().min(3, 'Escolha um modelo.').max(200),
  temperature: z.coerce.number().min(0).max(2).optional().nullable(),
  maxTokens: z.coerce.number().int().min(32).max(8000).default(400),
  instructions: text(4000),
  memoryEnabled: z.boolean().default(true),
  mode: z.enum(AGENT_MODES).default('REVIEW'),
  /** Ajustes operacionais (valem na hora, sem nova publicação). */
  minIntervalSeconds: z.coerce.number().int().min(0).max(120).default(8),
  showTyping: z.boolean().default(true),
  maxRepliesPerHour: z.coerce.number().int().min(1).max(60).default(10),
  /** Pergunta "você tem 18 anos ou mais?" antes de conversar. Desligada por padrão; NÃO verifica idade. */
  ageGate: z.boolean().default(false),
});
export type AgentInput = z.input<typeof agentInputSchema>;
export const agentUpdateSchema = agentInputSchema.partial();

export interface AgentAccountDTO {
  id: string;
  name: string;
  phoneE164: string | null;
  status: string;
  /** Outro agente ATIVO já atende esta instância (bloqueia ativar este). */
  activeAgent: { id: string; name: string } | null;
}

export interface AgentDTO {
  id: string;
  name: string;
  personaId: string;
  personaName: string;
  model: string;
  temperature: number | null;
  maxTokens: number;
  instructions: string | null;
  memoryEnabled: boolean;
  mode: (typeof AGENT_MODES)[number];
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ERROR';
  minIntervalSeconds: number;
  showTyping: boolean;
  maxRepliesPerHour: number;
  ageGate: boolean;
  publishedVersion: { id: string; number: number; createdAt: string } | null;
  /** Há alterações (no agente ou na persona) ainda não publicadas. */
  hasUnpublishedChanges: boolean;
  accounts: AgentAccountDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentVersionDTO {
  id: string;
  number: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  model: string;
  personaName: string;
  isPublished: boolean;
}

export interface AiSettingsDTO {
  configured: boolean;
  keyLast4: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  /** O servidor consegue guardar a chave (CREDENTIALS_MASTER_KEY configurada). */
  canStoreKey: boolean;
}

export interface AiModelDTO {
  id: string;
  name: string;
  contextLength: number | null;
  /** Dólares por 1 milhão de tokens. */
  promptPerMillion: number | null;
  completionPerMillion: number | null;
  supportsTemperature: boolean;
  /** Aceita imagens na entrada (null = a OpenRouter não informou). */
  supportsImages: boolean | null;
  /** O provedor aplica moderação de conteúdo (null = não informado). */
  isModerated: boolean | null;
}

export interface TestMessageDTO {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  createdAt: string;
  debug: {
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number | null;
    costConfirmed?: boolean;
    latencyMs?: number;
    systemPrompt?: string;
    errorCode?: string;
    /** Trechos da base de conhecimento usados nesta resposta. */
    knowledge?: AiKnowledgeUsedDTO[];
  };
}

export interface TestSessionDTO {
  id: string;
  agentId: string;
  source: 'draft' | 'published';
  versionNumber: number | null;
  createdAt: string;
  messages: TestMessageDTO[];
  totals: { promptTokens: number; completionTokens: number; costUsd: number | null };
}

export interface AiDraftDTO {
  id: string;
  conversationId: string;
  agentId: string;
  agentName: string;
  body: string;
  status: 'PENDING' | 'SENT' | 'DISCARDED' | 'FAILED';
  autoSent: boolean;
  /** Trechos da base de conhecimento em que a resposta se baseou. */
  sources: AiKnowledgeUsedDTO[];
  /** Mensagem do contato que originou a resposta. */
  inboundText: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export type AiConversationState =
  | 'serving' // IA atendendo
  | 'review' // há rascunho aguardando revisão
  | 'paused' // pausada nesta conversa
  | 'blocked'; // regra impede (campanha recente, descadastro...)

export interface AiConversationDTO {
  id: string;
  accountId: string;
  accountName: string;
  title: string | null;
  phoneE164: string | null;
  photoUrl: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  state: AiConversationState;
  /** Motivo de estar pausada ou bloqueada. */
  reason: string | null;
  pausedBy: string | null;
  enabledOverride: boolean;
  /** Pausada por sinal de menor de idade: só o administrador libera, com confirmação explícita. */
  minorLock: boolean;
  /** Quando o contexto da IA foi reiniciado nesta conversa (ela ignora o que veio antes). */
  contextResetAt: string | null;
  pendingDrafts: number;
  agentName: string | null;
}

export interface AiUsageSummaryDTO {
  days: number;
  live: { replies: number; promptTokens: number; completionTokens: number; costUsd: number | null };
  test: { calls: number; promptTokens: number; completionTokens: number; costUsd: number | null };
  generator: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number | null;
  };
}

// ─── Gerador de Persona ─────────────────────────────────────────────────────

export const AI_GENERATOR_QUEUE = 'ai-generator';
export interface AiGeneratorJob {
  generationId: string;
}
export const GENERATOR_LIMITS = {
  maxDescriptionChars: 8000,
  maxLinks: 3,
  maxDocs: 4,
  maxImages: 6,
  maxDocBytes: 8 * 1024 * 1024,
  maxImageBytes: 4 * 1024 * 1024,
} as const;
export const GENERATOR_DOC_EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'csv'] as const;
export const GENERATOR_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;

/** Pacote devolvido pelo gerador: tudo o que o MultiZap AI pede para montar um agente. */
export const generatorPackageSchema = z.object({
  persona: personaInputSchema,
  /** Instruções do agente (campo "Instruções do agente"). */
  agentInstructions: z.string().trim().max(4000).default(''),
  knowledge: z
    .object({
      texts: z
        .array(
          z.object({
            name: z.string().trim().min(2).max(120),
            content: z.string().trim().min(10).max(20_000),
          }),
        )
        .max(10)
        .default([]),
      qa: z
        .array(
          z.object({
            question: z.string().trim().min(3).max(500),
            answer: z.string().trim().min(2).max(4000),
          }),
        )
        .max(60)
        .default([]),
    })
    .default({}),
  /** Perguntas que o material não respondeu, para o administrador completar. */
  gaps: z.array(z.string().trim().min(3).max(300)).max(30).default([]),
  notes: z.string().trim().max(2000).optional().nullable(),
});
export type GeneratorPackage = z.output<typeof generatorPackageSchema>;

export const generatorApplySchema = z
  .object({
    package: generatorPackageSchema,
    mode: z.enum(['new', 'improve']),
    /** Novo agente: nome e modelo. */
    agentName: z.string().trim().min(2).max(80).optional(),
    agentModel: z.string().trim().min(3).max(200).optional(),
    /** Melhorar: agente alvo e o que aplicar. */
    agentId: z.string().uuid().optional(),
    sections: z
      .object({
        persona: z.boolean().default(true),
        instructions: z.boolean().default(true),
        knowledge: z.boolean().default(true),
      })
      .default({}),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'new') {
      if (!v.agentName)
        ctx.addIssue({ code: 'custom', path: ['agentName'], message: 'Informe o nome do agente.' });
      if (!v.agentModel)
        ctx.addIssue({
          code: 'custom',
          path: ['agentModel'],
          message: 'Escolha o modelo do agente.',
        });
    } else if (!v.agentId)
      ctx.addIssue({ code: 'custom', path: ['agentId'], message: 'Escolha o agente a melhorar.' });
  });
export type GeneratorApplyInput = z.input<typeof generatorApplySchema>;

export interface AiGenerationDTO {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'ERROR';
  error: string | null;
  model: string;
  description: string;
  links: string[];
  files: { name: string; kind: 'doc' | 'image' }[];
  targetAgentId: string | null;
  result: GeneratorPackage | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  costConfirmed: boolean;
  appliedAt: string | null;
  createdAt: string;
}
