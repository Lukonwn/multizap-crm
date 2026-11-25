/**
 * Proteções de idade. IMPORTANTE: nada aqui VERIFICA a idade de ninguém: só detecta sinais de que
 * o contato pode ser menor de 18 anos para que o atendimento pare. É proteção de melhor esforço.
 */

export interface MinorSignal {
  /** Trecho da mensagem que disparou o alerta. */
  snippet: string;
  /** Tipo do sinal, para o administrador entender. */
  kind: 'idade' | 'declaracao' | 'escola';
}

/** Mensagem fixa e neutra enviada (no modo automático) quando há sinal de menor de idade. */
export const MINOR_NOTICE = 'Não posso continuar esta conversa.';

/** Pergunta fixa do portão de idade (opcional por agente). */
export const AGE_GATE_QUESTION =
  'Antes de continuar: você tem 18 anos ou mais? Responda sim ou não.';

const strip = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

const clip = (s: string, i: number, len: number) =>
  s.slice(Math.max(0, i - 15), Math.min(s.length, i + len + 25)).trim();

/** Idade declarada abaixo de 18: "tenho 15 anos", "15 aninhos", "faço 16", "sou de 2010". */
const AGE_PATTERNS: RegExp[] = [
  /\b(?:tenho|to com|estou com|tô com|tou com)\s+(\d{1,2})\s*(?:anos|aninhos|anin)\b/g,
  /\b(\d{1,2})\s*(?:aninhos|anin)\b/g,
  /\bsou\s+(?:uma?\s+)?(?:menina|menino|garota|garoto|moca|moco)\s+de\s+(\d{1,2})\b/g,
  /\b(?:faco|vou fazer|completo)\s+(\d{1,2})\s*(?:anos)?\s*(?:em|no dia|dia|(?:no )?mes que vem|(?:no )?ano que vem|(?:na )?semana que vem|amanha|hoje)\b/g,
  /\bidade[:\s]+(\d{1,2})\b/g,
];
const BIRTH_YEAR = /\b(?:nasci em|sou de|nascido em|nascida em)\s+(19\d{2}|20\d{2})\b/g;

const DECLARATIONS: RegExp[] = [
  /\bsou\s+(?:de\s+)?menor(?:\s+de\s+idade)?\b/,
  /\bmenor de idade\b/,
  /\bnao tenho 18\b/,
  /\bainda nao (?:tenho|fiz) 18\b/,
  /\bsou adolescente\b/,
  /\bsou crianca\b/,
  /\bfaltam? (?:\d+|alguns|poucos) (?:meses|dias|semanas) pra (?:fazer )?18\b/,
];

const SCHOOL: RegExp[] = [
  /\b(?:estou|to|tou|tô|cursando)\s+(?:no|na|em)\s+(?:\d{1,2}\s*[ºo°]?\s*ano|ensino fundamental|fundamental|6 ano|7 ano|8 ano|9 ano)\b/,
  /\bensino fundamental\b/,
  /\b[6-9]\s*[ºo°]\s*ano\b/,
  /\bminha (?:mae|mãe|pai) (?:nao|não) deixa\b/,
  /\bminha mae (?:me )?(?:proibiu|nao deixa)\b/,
  /\bsaiu da aula|\bcheguei da escola|\bfui pra escola|\bprova da escola|\bdever de casa\b/,
];

/** Procura sinais de menor de idade em UM texto. */
export function detectMinorSignals(text: string): MinorSignal | null {
  const t = strip(text);

  for (const re of AGE_PATTERNS) {
    for (const m of t.matchAll(new RegExp(re.source, 'g'))) {
      const age = Number(m[1]);
      if (age >= 5 && age < 18)
        return { kind: 'idade', snippet: clip(t, m.index ?? 0, m[0].length) };
    }
  }
  const year = new Date().getFullYear();
  for (const m of t.matchAll(new RegExp(BIRTH_YEAR.source, 'g'))) {
    const age = year - Number(m[1]);
    if (age >= 5 && age < 18) return { kind: 'idade', snippet: clip(t, m.index ?? 0, m[0].length) };
  }
  for (const re of DECLARATIONS) {
    const m = re.exec(t);
    if (m) return { kind: 'declaracao', snippet: clip(t, m.index, m[0].length) };
  }
  for (const re of SCHOOL) {
    const m = re.exec(t);
    if (m) return { kind: 'escola', snippet: clip(t, m.index, m[0].length) };
  }
  return null;
}

/** Procura sinais em várias mensagens recentes do contato (a primeira que disparar). */
export function detectMinorInMessages(texts: string[]): MinorSignal | null {
  for (const t of texts) {
    const s = detectMinorSignals(t);
    if (s) return s;
  }
  return null;
}

/** Resposta ao portão de idade. */
export function parseAgeAnswer(text: string): 'yes' | 'no' | 'unclear' {
  const t = strip(text)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return 'unclear';
  if (detectMinorSignals(text)) return 'no';
  if (/^(nao|n|nop|nope|menor|ainda nao|nao tenho)\b/.test(t)) return 'no';
  const num = /\b(\d{1,2})\b/.exec(t);
  if (num && Number(num[1]) < 18) return 'no';
  if (
    /^(sim|s|si|simm+|tenho|claro|com certeza|maior|sou maior|pode crer|yes|y|ok|positivo)\b/.test(
      t,
    )
  )
    return 'yes';
  if (num && Number(num[1]) >= 18) return 'yes';
  return 'unclear';
}

/**
 * Termos que sexualizam ou sugerem menor de idade. Bloqueiam o SALVAMENTO de persona e a saída do
 * gerador. Lista curta e inequívoca, para não barrar lojas de roupas infantis, escolas etc.
 */
const MINOR_PERSONA_TERMS: RegExp[] = [
  /\bcolegial\b/,
  /\bninfet(?:a|inha)\b/,
  /\blolita\b/,
  /\bnovinha\b/,
  /\bmenor de idade\b/,
  /\b(?:menina|garota|menino|garoto)\s+de\s+(?:1[0-7]|[5-9])\s*anos\b/,
  /\bteen\b/,
  /\bunder\s*18\b/,
  /\bjailbait\b/,
];

/** Primeiro termo problemático em um texto de persona, se houver. */
export function minorTermIn(text: string): string | null {
  const t = strip(text);
  for (const re of MINOR_PERSONA_TERMS) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
}

/** Procura o termo em todos os valores de texto de um objeto (persona, pacote do gerador...). */
export function minorTermInObject(o: unknown): string | null {
  if (typeof o === 'string') return minorTermIn(o);
  if (Array.isArray(o)) {
    for (const v of o) {
      const r = minorTermInObject(v);
      if (r) return r;
    }
    return null;
  }
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) {
      const r = minorTermInObject(v);
      if (r) return r;
    }
  }
  return null;
}
