import { describe, expect, it } from 'vitest';
import { buildSearchQuery, chunkText, cleanText, knowledgeForPrompt } from '../src/knowledge';

describe('base de conhecimento: trechos', () => {
  it('texto curto vira um único trecho; título só se parecer título', () => {
    const c = chunkText('Horário de funcionamento\nSegunda a sexta, das 9h às 18h.');
    expect(c).toHaveLength(1);
    expect(c[0]!.title).toBe('Horário de funcionamento');
    expect(chunkText('Atendemos de segunda a sexta.')[0]!.title).toBeNull();
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('divide por parágrafos respeitando o tamanho e repetindo um pouco do contexto', () => {
    const para = (n: number) => `Parágrafo ${n}. ` + 'palavra '.repeat(40).trim() + '.';
    const text = [1, 2, 3, 4, 5, 6].map(para).join('\n\n');
    const chunks = chunkText(text, { size: 500, overlap: 60 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(500 + 60 + 2);
    // nada se perde: todo parágrafo aparece em algum trecho
    for (let n = 1; n <= 6; n++)
      expect(chunks.some((c) => c.content.includes(`Parágrafo ${n}.`))).toBe(true);
    // a fronteira repete um pedaço do trecho anterior
    const tail = chunks[0]!.content.slice(-30).trim().split(' ').slice(-2).join(' ');
    expect(chunks[1]!.content).toContain(tail);
  });

  it('frases e palavras gigantes são cortadas; respeita o máximo de trechos', () => {
    const giant = 'x'.repeat(5000);
    const c = chunkText(giant, { size: 1000, overlap: 0 });
    expect(c.length).toBe(5);
    expect(chunkText('a. '.repeat(5000), { size: 100, maxChunks: 7 })).toHaveLength(7);
  });

  it('cleanText normaliza espaços e quebras', () => {
    expect(cleanText('a \t b\r\n\r\n\r\n\r\nc d')).toBe('a b\n\nc d');
  });
});

describe('base de conhecimento: consulta', () => {
  it('só letras e números, sem repetição, em formato "qualquer termo"', () => {
    expect(buildSearchQuery('Qual o preço do café Bourbon? Café, café!')).toBe(
      'qual | preço | café | bourbon',
    );
    expect(buildSearchQuery('a de o')).toBe('');
  });

  it('operadores e sintaxe da consulta nunca passam', () => {
    const q = buildSearchQuery("café' ; DROP TABLE x; -- & | ! <-> (teste) :*");
    expect(q).toBe('café | drop | table | teste');
    expect(q).not.toMatch(/[;&!<>():*'-]/);
  });

  it('limita a quantidade de termos', () => {
    const q = buildSearchQuery(Array.from({ length: 40 }, (_, i) => `termo${i}`).join(' '), 5);
    expect(q.split(' | ')).toHaveLength(5);
  });

  it('prompt: respeita o limite de caracteres e usa o nome da fonte quando falta título', () => {
    const hit = (i: number, len: number) => ({
      sourceId: `s${i}`,
      sourceName: `Fonte ${i}`,
      title: i === 1 ? 'Frete' : null,
      content: 'a'.repeat(len),
      rank: 1,
    });
    const out = knowledgeForPrompt([hit(1, 500), hit(2, 500), hit(3, 500)], 1100);
    expect(out.map((o) => o.title)).toEqual(['Frete', 'Fonte 2', 'Fonte 3']);
    expect(out.reduce((a, o) => a + o.text.length, 0)).toBeLessThanOrEqual(1100);
  });
});
