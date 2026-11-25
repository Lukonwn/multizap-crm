/** Limites da base de conhecimento (valem para texto digitado, arquivos e links). */
export const KNOWLEDGE_LIMITS = {
  /** Máximo de caracteres de um texto digitado ou extraído de arquivo/link. */
  maxChars: 200_000,
  /** Máximo de trechos por fonte. */
  maxChunks: 300,
  chunkSize: 900,
  chunkOverlap: 120,
  /** Máximo de trechos entregues ao agente por pergunta. */
  searchLimit: 4,
  /** Máximo de caracteres de conhecimento colocados no prompt. */
  promptChars: 3600,
} as const;

/** Normaliza espaços e quebras de linha sem perder a separação de parágrafos. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface Chunk {
  title: string | null;
  content: string;
}

/**
 * Divide o texto em trechos de ~`size` caracteres, respeitando parágrafos e frases.
 * Parágrafos muito longos são cortados em frases; um pequeno trecho do final do trecho anterior
 * é repetido no seguinte (`overlap`) para não perder o contexto na fronteira.
 * O título de cada trecho é a primeira linha curta que parece um título, se houver.
 */
export function chunkText(
  text: string,
  opts: { size?: number; overlap?: number; maxChunks?: number } = {},
): Chunk[] {
  const size = opts.size ?? KNOWLEDGE_LIMITS.chunkSize;
  const overlap = Math.min(opts.overlap ?? KNOWLEDGE_LIMITS.chunkOverlap, Math.floor(size / 3));
  const max = opts.maxChunks ?? KNOWLEDGE_LIMITS.maxChunks;
  const clean = cleanText(text);
  if (!clean) return [];

  // Unidades: parágrafos; os longos viram frases; frases longas viram pedaços de `size`.
  const units: string[] = [];
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= size) {
      units.push(p);
      continue;
    }
    for (const sentence of p.split(/(?<=[.!?…])\s+|\n/)) {
      const s = sentence.trim();
      if (!s) continue;
      if (s.length <= size) units.push(s);
      else for (let i = 0; i < s.length; i += size) units.push(s.slice(i, i + size));
    }
  }

  const chunks: Chunk[] = [];
  let current = '';
  const flush = () => {
    const content = current.trim();
    if (content) chunks.push({ title: titleOf(content), content });
  };
  for (const u of units) {
    if (current && current.length + u.length + 2 > size) {
      flush();
      const tail = overlap > 0 ? current.slice(-overlap).replace(/^\S*\s/, '') : '';
      current = tail ? `${tail}\n${u}` : u;
    } else {
      current = current ? `${current}\n${u}` : u;
    }
    if (chunks.length >= max) break;
  }
  if (chunks.length < max) flush();
  return chunks.slice(0, max);
}

/** Primeira linha curta, sem pontuação final de frase, vira o título do trecho. */
function titleOf(content: string): string | null {
  const first = content.split('\n', 1)[0]!.trim();
  return first.length >= 3 && first.length <= 80 && !/[.!?,;]$/.test(first) ? first : null;
}

/**
 * Termos de busca a partir do texto da conversa: palavras com 3+ letras, sem repetição.
 * O PostgreSQL remove as palavras comuns do português; aqui só higienizamos para que nenhum
 * caractere especial vire sintaxe de consulta. O resultado é "termo1 | termo2 | ..." (qualquer um).
 */
export function buildSearchQuery(text: string, maxTerms = 12): string {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    // só letras e números: nada de operadores da consulta
    if (/^[\p{L}\p{N}]+$/u.test(w)) seen.add(w);
    if (seen.size >= maxTerms) break;
  }
  return [...seen].join(' | ');
}

export interface KnowledgeHit {
  sourceId: string;
  sourceName: string;
  title: string | null;
  content: string;
  rank: number;
}

/** Trechos para o prompt, respeitando o limite de caracteres. */
export function knowledgeForPrompt(
  hits: KnowledgeHit[],
  maxChars: number = KNOWLEDGE_LIMITS.promptChars,
): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  let used = 0;
  for (const h of hits) {
    const text =
      h.content.length > maxChars - used ? h.content.slice(0, maxChars - used) : h.content;
    if (text.length < 40 && out.length) break;
    out.push({ title: h.title ?? h.sourceName, text });
    used += text.length;
    if (used >= maxChars) break;
  }
  return out;
}

/** Resumo curto de cada trecho usado, para mostrar ao administrador. */
export function hitsForDisplay(
  hits: KnowledgeHit[],
): { sourceId: string; name: string; snippet: string }[] {
  return hits.map((h) => ({
    sourceId: h.sourceId,
    name: h.sourceName,
    snippet: h.content.replace(/\s+/g, ' ').slice(0, 160),
  }));
}
