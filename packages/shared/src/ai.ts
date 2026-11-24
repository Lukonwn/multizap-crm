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
  age: z.coerce.number().int().min(1).max(120).optional().nullable(),
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
  /** Modo da versão publicada (é o que vale no atendimento); null se não publicado. */
  publishedMode: (typeof AGENT_MODES)[number] | null;
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
  pendingDrafts: number;
  agentName: string | null;
}

export interface AiUsageSummaryDTO {
  days: number;
  live: { replies: number; promptTokens: number; completionTokens: number; costUsd: number | null };
  test: { calls: number; promptTokens: number; completionTokens: number; costUsd: number | null };
}
