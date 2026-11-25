import { describe, expect, it } from 'vitest';
import { personaInputSchema } from '@multizap/shared';
import { GeneratorError, buildGeneratorMessages, parseGeneratorResult } from '../src/generator';
import { FIXED_RULES } from '../src/prompt';

const pkg = (over: Record<string, unknown> = {}) => ({
  persona: {
    name: 'Marina',
    age: 28,
    identity: 'Atendente da Casa do Café',
    toneOfVoice: 'Acolhedor',
    formality: 'informal',
    emojiUsage: 'low',
    responseLength: 'short',
    expressions: ['Boa pedida!'],
    openingMessages: ['Oi! Como posso ajudar?'],
  },
  agentInstructions: 'Atenda com simpatia.',
  knowledge: {
    texts: [{ name: 'Entrega', content: 'Entregamos em 3 dias úteis para todo o Brasil.' }],
    qa: [{ question: 'Aceitam pix?', answer: 'Sim, com 5% de desconto.' }],
  },
  gaps: ['Qual o horário de atendimento?'],
  notes: 'Cardápio legível.',
  ...over,
});

describe('Gerador de Persona: leitura da resposta', () => {
  it('lê o JSON puro, em cerca de código e com texto em volta', () => {
    const json = JSON.stringify(pkg());
    for (const raw of [
      json,
      '```json\n' + json + '\n```',
      'Claro! Aqui está:\n' + json + '\nQualquer ajuste, avise.',
    ]) {
      const r = parseGeneratorResult(raw);
      expect(r.persona.name).toBe('Marina');
      expect(r.persona.age).toBe(28);
      expect(r.knowledge.qa).toHaveLength(1);
      expect(r.gaps).toEqual(['Qual o horário de atendimento?']);
    }
  });

  it('ajusta textos grandes demais aos limites do cadastro (o resultado sempre passa no schema da persona)', () => {
    const big = 'x'.repeat(9000);
    const r = parseGeneratorResult(
      JSON.stringify(
        pkg({
          persona: {
            name: 'Ana',
            age: 30,
            identity: big,
            biography: big,
            rules: big,
            expressions: Array(60).fill('oi'),
            openingMessages: Array(30).fill('olá'),
          },
          agentInstructions: big,
        }),
      ),
    );
    expect(r.persona.identity!.length).toBe(600);
    expect(r.persona.expressions.length).toBe(30);
    expect(r.persona.openingMessages.length).toBe(10);
    expect(r.agentInstructions.length).toBe(4000);
    expect(personaInputSchema.safeParse(r.persona).success).toBe(true);
  });

  it('aceita campos como texto ou lista e descarta itens vazios ou curtos demais', () => {
    const r = parseGeneratorResult(
      JSON.stringify(
        pkg({
          persona: {
            name: 'Bia',
            age: '25',
            expressions: 'ótimo\n\nperfeito',
            rules: ['uma', 'duas'],
          },
          knowledge: {
            texts: [{ name: '', content: 'x' }],
            qa: [
              { question: 'a', answer: 'b' },
              { question: 'Tem frete?', answer: 'Grátis acima de R$ 200.' },
            ],
          },
          gaps: ['ok', 'Qual o prazo para o Nordeste?'],
        }),
      ),
    );
    expect(r.persona.age).toBe(25);
    expect(r.persona.expressions).toEqual(['ótimo', 'perfeito']);
    expect(r.persona.rules).toBe('uma\nduas');
    expect(r.knowledge.texts).toEqual([]);
    expect(r.knowledge.qa).toHaveLength(1);
    expect(r.gaps).toEqual(['Qual o prazo para o Nordeste?']);
  });

  it('recusas e respostas fora do formato viram erro claro com o início da resposta', () => {
    for (const raw of ['Não posso ajudar com isso.', '{ quebrado', '[]', '']) {
      try {
        parseGeneratorResult(raw);
        throw new Error('deveria falhar');
      } catch (e) {
        expect(e).toBeInstanceOf(GeneratorError);
        expect((e as GeneratorError).code).toBe('FORMAT');
      }
    }
    try {
      parseGeneratorResult('Desculpe, não posso criar esse conteúdo.');
    } catch (e) {
      expect((e as GeneratorError).excerpt).toContain('Desculpe');
    }
  });

  it('persona menor de 18 ou com termo que sugere menor é recusada', () => {
    expect(() =>
      parseGeneratorResult(JSON.stringify(pkg({ persona: { name: 'Lia', age: 16 } }))),
    ).toThrow(GeneratorError);
    for (const text of ['persona colegial e travessa', 'uma novinha safada']) {
      try {
        parseGeneratorResult(JSON.stringify(pkg({ agentInstructions: text })));
        throw new Error('deveria falhar');
      } catch (e) {
        expect((e as GeneratorError).code).toBe('MINOR');
      }
    }
    // termo escondido em qualquer parte do pacote (conhecimento, abertura...)
    expect(() =>
      parseGeneratorResult(
        JSON.stringify(
          pkg({
            knowledge: { texts: [], qa: [{ question: 'Quem é?', answer: 'Uma ninfetinha' }] },
          }),
        ),
      ),
    ).toThrow(/menor de idade/);
  });
});

describe('Gerador de Persona: pedido ao modelo', () => {
  const base = { description: 'Loja de cafés especiais', documents: [], links: [], images: [] };

  it('só texto: usuário em texto simples; regras de segurança e formato JSON no sistema', () => {
    const [sys, user] = buildGeneratorMessages(base);
    expect(sys!.role).toBe('system');
    expect(sys!.content).toMatch(/SOMENTE fatos presentes no material/);
    expect(sys!.content).toMatch(/18 anos ou mais/);
    expect(sys!.content).toMatch(/palavrões/); // o estilo pedido pelo usuário é respeitado
    expect(typeof user!.content).toBe('string');
    expect(user!.content).toContain('Loja de cafés especiais');
  });

  it('imagens vão como partes de imagem; documentos e páginas entram no texto', () => {
    const [, user] = buildGeneratorMessages({
      ...base,
      documents: [{ name: 'cardapio.pdf', text: 'Café R$ 8' }],
      links: [{ url: 'https://loja.com/sobre', title: 'Sobre', text: 'Fundada em 2015' }],
      images: [{ name: 'tabela.png', dataUrl: 'data:image/png;base64,AAAA' }],
    });
    expect(Array.isArray(user!.content)).toBe(true);
    const parts = user!.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0]!.type).toBe('text');
    expect(parts[0]!.text).toContain('DOCUMENTO "cardapio.pdf"');
    expect(parts[0]!.text).toContain('Café R$ 8');
    expect(parts[0]!.text).toContain('https://loja.com/sobre');
    expect(parts[0]!.text).toContain('tabela.png');
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
  });

  it('modo melhorar leva a persona e as instruções atuais', () => {
    const [, user] = buildGeneratorMessages({
      ...base,
      existing: { persona: { name: 'Marina', tone: 'doce' }, instructions: 'Atenda bem' },
    });
    expect(user!.content).toContain('AGENTE JÁ EXISTENTE');
    expect(user!.content).toContain('"name":"Marina"');
    expect(user!.content).toContain('Atenda bem');
  });

  it('respeita o limite total de texto do pedido', () => {
    const [, user] = buildGeneratorMessages({
      ...base,
      description: 'd'.repeat(8000),
      documents: Array.from({ length: 6 }, (_, i) => ({ name: `d${i}`, text: 'x'.repeat(30_000) })),
    });
    expect((user!.content as string).length).toBeLessThan(65_000);
  });

  it('a regra fixa de menores existe em todo agente', () => {
    expect(FIXED_RULES.join(' ')).toMatch(/menos de 18 anos/);
  });
});

import { buildSystemPrompt, extractDelivery } from '../src/prompt';

describe('entregáveis no prompt e no marcador', () => {
  const items = [
    {
      code: 'ebook-cafe',
      name: 'E-book de cafés',
      description: 'Guia de métodos de preparo',
      requiresPayment: true,
      priceCents: 4990,
      paymentInstructions: 'Pix 11 99999-0000',
    },
    { code: 'amostra', name: 'Amostra grátis', adultOnly: false },
    {
      code: 'conteudo-18',
      name: 'Conteúdo adulto',
      adultOnly: true,
      requiresPayment: true,
      priceCents: 1500,
      paymentInstructions: 'Pix',
    },
  ];

  it('o catálogo mostra código, preço, como pagar e o aviso de adulto; e proíbe afirmar pagamento', () => {
    const p = buildSystemPrompt({ name: 'Marina' }, { name: 'A' }, { deliverables: items });
    expect(p).toContain(
      '[ebook-cafe] E-book de cafés: Guia de métodos de preparo (PAGO (R$ 49,90). Como pagar: Pix 11 99999-0000)',
    );
    expect(p).toContain('[amostra] Amostra grátis (gratuito)');
    expect(p).toContain('só para adultos confirmados');
    expect(p).toMatch(/\[\[ENTREGAR:codigo\]\]/);
    expect(p).toMatch(/NUNCA diga que recebeu o pagamento/);
  });

  it('sem entregáveis o prompt não fala de entrega', () => {
    expect(buildSystemPrompt({ name: 'Marina' }, { name: 'A' })).not.toMatch(/ENTREGAR/);
  });

  it('extrai o primeiro código, remove todos os marcadores e limpa o texto', () => {
    expect(extractDelivery('Claro! Segue o e-book. [[ENTREGAR:ebook-cafe]]')).toEqual({
      text: 'Claro! Segue o e-book.',
      code: 'ebook-cafe',
    });
    expect(extractDelivery('Oi [[entregar: Amostra ]] tchau [[ENTREGAR:outro-item]]')).toEqual({
      text: 'Oi  tchau',
      code: 'amostra',
    });
    expect(extractDelivery('Sem entrega aqui.')).toEqual({ text: 'Sem entrega aqui.', code: null });
    expect(extractDelivery('[[ENTREGAR:ebook-cafe]]')).toEqual({ text: '', code: 'ebook-cafe' });
    // códigos inválidos não são marcadores (continuam como texto)
    expect(extractDelivery('veja [[ENTREGAR:a]]').code).toBeNull();
  });
});
