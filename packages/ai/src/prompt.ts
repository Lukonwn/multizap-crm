import type { ChatMessage } from './openrouter';

/** Campos da persona usados no prompt (mesmos nomes do banco). */
export interface PersonaSpec {
  name: string;
  age?: number | null;
  identity?: string | null;
  biography?: string | null;
  backstory?: string | null;
  personality?: string | null;
  traits?: string | null;
  toneOfVoice?: string | null;
  communicationStyle?: string | null;
  formality?: string | null;
  emojiUsage?: string | null;
  responseLength?: string | null;
  conversationStart?: string | null;
  expressions?: string[] | null;
  instructions?: string | null;
  rules?: string | null;
  allowedTopics?: string | null;
  restrictedTopics?: string | null;
  openingMessages?: string[] | null;
}

export interface AgentSpec {
  name: string;
  instructions?: string | null;
}

/** Item que o agente pode entregar (catálogo mostrado ao modelo). */
export interface DeliverableSpec {
  code: string;
  name: string;
  description?: string | null;
  adultOnly?: boolean;
  requiresPayment?: boolean;
  priceCents?: number | null;
  paymentInstructions?: string | null;
}

export interface PromptContext {
  /** Itens que este agente pode entregar. */
  deliverables?: DeliverableSpec[];
  /** Trechos da base de conhecimento relevantes para a pergunta (Entrega 3). */
  knowledge?: { title: string; text: string }[];
  /** Resumo do que já se sabe sobre o contato (Entrega 2). */
  memory?: string | null;
  /** O agente tem base de conhecimento e ela foi consultada para esta pergunta. */
  knowledgeSearched?: boolean;
  /** Nome do contato, quando conhecido. */
  contactName?: string | null;
}

/** Regras que valem para todo agente e não podem ser desligadas pela persona. */
export const FIXED_RULES = [
  'Se perguntarem diretamente se você é uma pessoa, um robô ou uma inteligência artificial, não afirme ser humano: diga com naturalidade que é um assistente virtual.',
  'Não invente informações (preços, prazos, estoque, endereços, políticas). Se não tiver a informação, diga que vai verificar ou que um atendente pode ajudar.',
  'Nunca diga que uma ação foi concluída (pagamento, cadastro, envio, agendamento) sem confirmação explícita nas informações que você recebeu.',
  'Nunca peça senhas, códigos de verificação ou dados completos de cartão.',
  'Se o contato pedir para falar com uma pessoa, diga que vai chamar um atendente.',
  'Se houver qualquer indício de que o contato tem menos de 18 anos (idade, escola, "sou menor"), encerre a conversa de forma neutra e NUNCA continue com conteúdo sexual ou adulto. Você só conversa com maiores de idade.',
  'Responda em português do Brasil, a menos que o contato escreva em outro idioma.',
];

const FORMALITY: Record<string, string> = {
  formal:
    'Use linguagem formal e respeitosa (trate por "senhor" ou "senhora" quando fizer sentido).',
  neutral: 'Use linguagem cordial e natural, nem formal demais nem informal demais.',
  informal: 'Use linguagem informal e próxima, como numa conversa entre conhecidos.',
};
const EMOJI: Record<string, string> = {
  none: 'Não use emojis.',
  low: 'Use emojis raramente (no máximo um, quando fizer sentido).',
  medium: 'Use emojis com moderação.',
  high: 'Pode usar emojis com frequência.',
};
const LENGTH: Record<string, string> = {
  short: 'Responda em mensagens curtas (1 a 3 frases), como numa conversa de WhatsApp.',
  medium: 'Responda de forma objetiva, em até um parágrafo.',
  long: 'Pode dar respostas mais completas quando o assunto pedir, sem enrolar.',
};

const line = (label: string, v: string | null | undefined) =>
  v?.trim() ? `${label}: ${v.trim()}` : null;

const brl = (cents: number) =>
  `R$ ${(cents / 100)
    .toFixed(2)
    .replace('.', ',')
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

function deliverablesSection(items: DeliverableSpec[]): string {
  const lines = items.map((d) => {
    const cond = d.requiresPayment
      ? `PAGO (${d.priceCents ? brl(d.priceCents) : 'valor a combinar'})${d.paymentInstructions ? `. Como pagar: ${d.paymentInstructions}` : ''}`
      : 'gratuito';
    return `- [${d.code}] ${d.name}${d.description ? `: ${d.description}` : ''} (${cond}${d.adultOnly ? '; só para adultos confirmados' : ''})`;
  });
  return [
    'Itens que você pode entregar ao contato (use o código exato, entre colchetes):',
    ...lines,
    'Como entregar: quando o contato pedir um item, ou aceitar uma oferta sua, escreva a resposta normalmente e termine com [[ENTREGAR:codigo]] (no máximo um por mensagem). Não escreva o marcador se o contato não pediu nem aceitou.',
    'O envio é feito pelo sistema, depois das verificações. Para item PAGO: explique o valor e como pagar e use o marcador; o sistema só entrega depois de CONFIRMAR o pagamento por outra fonte. NUNCA diga que recebeu o pagamento nem que o item já foi enviado; se o contato disser que pagou, responda que vai conferir. Não ofereça nada que não esteja nesta lista.',
  ].join('\n');
}

/** Monta o prompt de sistema a partir da persona, do agente e do contexto. */
export function buildSystemPrompt(
  persona: PersonaSpec,
  agent: AgentSpec,
  ctx: PromptContext = {},
): string {
  const who = `Você é ${persona.name}${persona.age ? `, ${persona.age} anos` : ''}.`;
  const sections: (string | null)[] = [
    [who, persona.identity?.trim()].filter(Boolean).join(' '),
    line('Biografia', persona.biography),
    line('História e contexto', persona.backstory),
    line('Personalidade', persona.personality),
    line('Traços de comportamento', persona.traits),
    line('Tom de voz', persona.toneOfVoice),
    line('Estilo de comunicação', persona.communicationStyle),
    FORMALITY[persona.formality ?? 'neutral'] ?? null,
    EMOJI[persona.emojiUsage ?? 'low'] ?? null,
    LENGTH[persona.responseLength ?? 'short'] ?? null,
    line('Como iniciar conversas', persona.conversationStart),
    persona.expressions?.length
      ? `Expressões características: ${persona.expressions.join('; ')}`
      : null,
    line('Assuntos que você pode tratar', persona.allowedTopics),
    line('Assuntos que você NÃO deve tratar (recuse com educação)', persona.restrictedTopics),
    line('Regras de comportamento', persona.rules),
    line('Instruções da persona', persona.instructions),
    line('Instruções deste atendimento', agent.instructions),
  ];
  if (ctx.contactName) sections.push(`Nome do contato: ${ctx.contactName}.`);
  if (ctx.memory?.trim())
    sections.push(`O que você já sabe sobre este contato:\n${ctx.memory.trim()}`);
  if (ctx.knowledge?.length) {
    sections.push(
      'Informações da empresa (use como fonte principal; se a resposta não estiver aqui, não invente):\n' +
        ctx.knowledge.map((k, i) => `[${i + 1}] ${k.title}\n${k.text}`).join('\n\n'),
    );
  } else if (ctx.knowledgeSearched)
    sections.push(
      'A base de conhecimento da empresa foi consultada e não traz nada sobre esta mensagem. Se o contato perguntar sobre fatos da empresa (preços, produtos, prazos, estoque, políticas, endereço), não invente: diga que vai verificar e ofereça um atendente. Para cumprimentos e conversa em geral, responda normalmente e pergunte como pode ajudar.',
    );
  if (ctx.deliverables?.length) sections.push(deliverablesSection(ctx.deliverables));
  sections.push(`Regras que sempre valem:\n${FIXED_RULES.map((r) => `- ${r}`).join('\n')}`);
  return sections.filter((s): s is string => !!s).join('\n\n');
}

/** Mensagens para o modelo: prompt de sistema + últimas mensagens da conversa. */
export function buildMessages(
  persona: PersonaSpec,
  agent: AgentSpec,
  history: { role: 'user' | 'assistant'; content: string }[],
  ctx: PromptContext = {},
  maxHistory = 20,
): ChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(persona, agent, ctx) },
    ...history.slice(-maxHistory).map((m) => ({ role: m.role, content: m.content })),
  ];
}

const DELIVER_RE = /\[\[\s*ENTREGAR\s*:\s*([a-z0-9][a-z0-9_-]{2,39})\s*\]\]/gi;

/**
 * Separa o marcador de entrega do texto da resposta. Devolve o texto sem nenhum marcador
 * (o contato nunca vê o marcador) e o código do PRIMEIRO item pedido, se houver.
 */
export function extractDelivery(reply: string): { text: string; code: string | null } {
  let code: string | null = null;
  const text = reply
    .replace(DELIVER_RE, (_m, c: string) => {
      code ??= c.toLowerCase();
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, code };
}
