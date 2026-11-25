import { generatorPackageSchema, type GeneratorPackage } from '@multizap/shared';
import type { ChatMessage, ContentPart } from './openrouter';
import { minorTermInObject } from './safety';

/** Erro de leitura da resposta do modelo, com mensagem própria para o administrador. */
export class GeneratorError extends Error {
  constructor(
    message: string,
    readonly code: 'FORMAT' | 'MINOR',
    /** Início da resposta do modelo (ajuda a ver, por exemplo, uma recusa). */
    readonly excerpt?: string,
  ) {
    super(message);
  }
}

export interface GeneratorInput {
  description: string;
  documents: { name: string; text: string }[];
  links: { url: string; title: string | null; text: string }[];
  images: { name: string; dataUrl: string }[];
  /** Modo "melhorar": o que o agente já tem. */
  existing?: { persona: Record<string, unknown>; instructions: string | null } | null;
}

const DOC_CHARS = 14_000;
const TOTAL_CHARS = 60_000;

const SYSTEM = `Você é um especialista em montar agentes de atendimento ao cliente por WhatsApp, em português do Brasil.
Com base no material enviado pelo usuário (descrição do negócio, documentos, páginas de sites e imagens como cardápios, catálogos ou tabelas), monte um PACOTE em JSON para criar o agente.

Regras:
- Use SOMENTE fatos presentes no material. NUNCA invente preços, prazos, endereços, horários, produtos ou políticas. Se algo for apenas dedução, escreva "(a confirmar)" no texto.
- Em "gaps", liste perguntas importantes que clientes fariam e que o material NÃO responde (ex.: "Qual o horário de atendimento?").
- Imagens: leia o conteúdo (textos, preços, itens) e use no conhecimento. Se uma imagem estiver ilegível, diga isso em "notes".
- A persona deve ter 18 anos ou mais. NUNCA crie persona que sugira menor de idade, estudante do ensino básico ou termos como "novinha" ou "colegial". NUNCA imite uma pessoa real.
- Tom de voz, estilo e expressões da persona: siga exatamente o que o usuário pedir (formal, informal, gírias, linguagem de rua, palavrões, provocação), sem suavizar. Isso vale para o estilo, não para fatos.
- Nas instruções, NÃO escreva nada que contrarie estas regras que já existem no sistema: afirmar ser humano quando perguntado, pedir senha ou dado de cartão, inventar informações, continuar conversa com menor de idade.
- "knowledge.texts": até 10 blocos de texto organizados por assunto (cada um com um nome curto). "knowledge.qa": perguntas e respostas prováveis, com respostas curtas, até 60.
- Escreva respostas e mensagens como o agente falaria com o cliente, no tom pedido.

Responda APENAS com um JSON válido (sem markdown, sem comentários, sem texto fora do JSON), neste formato:
{
  "persona": {
    "name": "", "age": 28, "identity": "", "biography": "", "backstory": "", "personality": "", "traits": "",
    "toneOfVoice": "", "communicationStyle": "", "formality": "formal|neutral|informal",
    "emojiUsage": "none|low|medium|high", "responseLength": "short|medium|long",
    "conversationStart": "", "expressions": [""], "instructions": "", "rules": "",
    "allowedTopics": "", "restrictedTopics": "", "openingMessages": [""]
  },
  "agentInstructions": "",
  "knowledge": { "texts": [{ "name": "", "content": "" }], "qa": [{ "question": "", "answer": "" }] },
  "gaps": [""],
  "notes": ""
}`;

/** Monta as mensagens do pedido de geração (com imagens, se houver). */
export function buildGeneratorMessages(input: GeneratorInput): ChatMessage[] {
  let budget = TOTAL_CHARS;
  const take = (text: string, cap: number) => {
    const t = text.slice(0, Math.min(cap, Math.max(0, budget)));
    budget -= t.length;
    return t;
  };
  const parts: string[] = [
    `DESCRIÇÃO DO NEGÓCIO E DO QUE O USUÁRIO QUER:\n${take(input.description, 8000)}`,
  ];
  for (const d of input.documents) parts.push(`DOCUMENTO "${d.name}":\n${take(d.text, DOC_CHARS)}`);
  for (const l of input.links)
    parts.push(`PÁGINA ${l.url}${l.title ? ` (${l.title})` : ''}:\n${take(l.text, DOC_CHARS)}`);
  if (input.existing) {
    parts.push(
      `AGENTE JÁ EXISTENTE (melhore e complete, mantendo o que já funciona; não perca informações úteis):\nPersona atual: ${JSON.stringify(input.existing.persona)}\nInstruções atuais: ${input.existing.instructions ?? '(nenhuma)'}`,
    );
  }
  if (input.images.length)
    parts.push(
      `Imagens anexadas (${input.images.length}): ${input.images.map((i) => i.name).join(', ')}. Leia o conteúdo delas.`,
    );

  const content: ContentPart[] = [{ type: 'text', text: parts.join('\n\n---\n\n') }];
  for (const img of input.images)
    content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: input.images.length ? content : (content[0] as { text: string }).text,
    },
  ];
}

/** Limites dos campos da persona (iguais aos do cadastro): o modelo às vezes passa um pouco. */
const PERSONA_MAX: Record<string, number> = {
  name: 80,
  identity: 600,
  biography: 3000,
  backstory: 3000,
  personality: 1500,
  traits: 1500,
  toneOfVoice: 600,
  communicationStyle: 1500,
  conversationStart: 1000,
  instructions: 4000,
  rules: 4000,
  allowedTopics: 2000,
  restrictedTopics: 2000,
};

const asText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join('\n');
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
};
const clip = (v: unknown, n: number) => asText(v)?.trim().slice(0, n) ?? undefined;
const list = (v: unknown, count: number, len: number) =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [])
    .map((x) => clip(x, len))
    .filter((x): x is string => !!x)
    .slice(0, count);

/** Ajusta o JSON do modelo aos limites do cadastro (sem inventar nada). */
function normalize(raw: Record<string, unknown>): unknown {
  const p = (raw.persona ?? {}) as Record<string, unknown>;
  const persona: Record<string, unknown> = {};
  for (const [k, max] of Object.entries(PERSONA_MAX)) persona[k] = clip(p[k], max);
  const age = Number(p.age);
  persona.age = Number.isFinite(age) && age > 0 ? Math.round(age) : null;
  for (const k of ['formality', 'emojiUsage', 'responseLength'] as const)
    if (typeof p[k] === 'string') persona[k] = (p[k] as string).trim().toLowerCase();
  persona.expressions = list(p.expressions, 30, 120);
  persona.openingMessages = list(p.openingMessages, 10, 500);

  const k = (raw.knowledge ?? {}) as { texts?: unknown; qa?: unknown };
  const texts = (Array.isArray(k.texts) ? k.texts : []).flatMap((t) => {
    const o = t as { name?: unknown; content?: unknown };
    const name = clip(o?.name, 120);
    const content = clip(o?.content, 20_000);
    // Itens curtos demais para o cadastro são descartados, sem derrubar o pacote inteiro.
    return name && content && name.length >= 2 && content.length >= 10 ? [{ name, content }] : [];
  });
  const qa = (Array.isArray(k.qa) ? k.qa : []).flatMap((t) => {
    const o = t as { question?: unknown; answer?: unknown };
    const question = clip(o?.question, 500);
    const answer = clip(o?.answer, 4000);
    return question && answer && question.length >= 3 && answer.length >= 2
      ? [{ question, answer }]
      : [];
  });
  return {
    persona,
    agentInstructions: clip(raw.agentInstructions, 4000) ?? '',
    knowledge: { texts: texts.slice(0, 10), qa: qa.slice(0, 60) },
    gaps: list(raw.gaps, 30, 300).filter((g) => g.length >= 3),
    notes: clip(raw.notes, 2000) ?? null,
  };
}

/** Extrai o objeto JSON de uma resposta (aceita cercas de código e texto em volta). */
function extractJson(text: string): Record<string, unknown> | null {
  const t = text.replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(t.slice(a, b + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Lê e valida a resposta do modelo. Recusa pacote cuja persona sugira menor de idade.
 * Erros trazem uma mensagem útil (incluindo o início da resposta, que costuma mostrar recusas).
 */
export function parseGeneratorResult(text: string): GeneratorPackage {
  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  const raw = extractJson(text);
  if (!raw)
    throw new GeneratorError(
      'O modelo não devolveu o pacote no formato esperado (pode ter recusado o pedido). Tente outro modelo.',
      'FORMAT',
      excerpt,
    );
  const parsed = generatorPackageSchema.safeParse(normalize(raw));
  if (!parsed.success) {
    const first = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'pacote'}: ${i.message}`)
      .join('; ');
    throw new GeneratorError(
      `O pacote veio incompleto ou inválido (${first}). Tente de novo ou use outro modelo.`,
      'FORMAT',
      excerpt,
    );
  }
  const term = minorTermInObject(parsed.data);
  if (term)
    throw new GeneratorError(
      `O pacote foi descartado porque sugere menor de idade ("${term}"). Descreva uma persona adulta e tente de novo.`,
      'MINOR',
    );
  return parsed.data;
}
