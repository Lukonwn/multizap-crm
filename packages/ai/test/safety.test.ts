import { describe, expect, it } from 'vitest';
import {
  detectMinorInMessages,
  detectMinorSignals,
  minorTermIn,
  minorTermInObject,
  parseAgeAnswer,
} from '../src/safety';

describe('sinais de menor de idade', () => {
  it.each([
    'oi, tenho 15 anos',
    'to com 16 anos e queria saber',
    'Tenho 17 aninhos',
    'tenho 14 ANOS',
    'sou uma menina de 13',
    'vou fazer 16 em março',
    'faço 15 no mês que vem',
    'sou menor de idade',
    'sou menor',
    'não tenho 18',
    'ainda não tenho 18 anos',
    'sou adolescente',
    'estou no 9º ano',
    'tô no 8 ano',
    'estudo no ensino fundamental',
    'minha mãe não deixa eu',
    'cheguei da escola agora',
    `nasci em ${new Date().getFullYear() - 14}`,
    'idade: 16',
    'Tenho 15 anos!',
  ])('dispara: %s', (msg) => {
    const s = detectMinorSignals(msg);
    expect(s, msg).not.toBeNull();
    expect(s!.snippet.length).toBeGreaterThan(2);
  });

  it.each([
    'tenho 25 anos',
    'tenho 18 anos',
    'tenho 40 aninhos de casado',
    'oi, tudo bem?',
    'quero um café',
    'sou maior de idade',
    'nasci em 1990',
    'moro no 15º andar',
    'faço 30 anos em março',
    'tem 15 anos de experiência',
    'a loja tem 10 anos de mercado',
    'aceitam pix?',
    'minha mãe também gosta de café',
  ])('NÃO dispara: %s', (msg) => {
    // "tem 15 anos de experiência" / "10 anos de mercado" não são idade do contato.
    expect(detectMinorSignals(msg), msg).toBeNull();
  });

  it('procura em várias mensagens e devolve a primeira que disparar', () => {
    expect(detectMinorInMessages(['oi', 'tenho 15 anos', 'tenho 16 anos'])?.snippet).toContain(
      '15',
    );
    expect(detectMinorInMessages(['oi', 'tudo bem'])).toBeNull();
  });
});

describe('portão de idade: resposta', () => {
  it.each([
    ['sim', 'yes'],
    ['Sim!', 'yes'],
    ['s', 'yes'],
    ['claro', 'yes'],
    ['tenho sim', 'yes'],
    ['tenho 25', 'yes'],
    ['30 anos', 'yes'],
    ['não', 'no'],
    ['nao', 'no'],
    ['n', 'no'],
    ['ainda não', 'no'],
    ['tenho 16', 'no'],
    ['17', 'no'],
    ['sou menor', 'no'],
    ['hm', 'unclear'],
    ['depende', 'unclear'],
    ['', 'unclear'],
  ])('%s → %s', (text, expected) => {
    expect(parseAgeAnswer(text)).toBe(expected);
  });
});

describe('persona que sugere menor de idade', () => {
  it.each([
    'persona colegial e safadinha',
    'uma novinha de 18',
    'ninfetinha',
    'Lolita',
    'menina de 15 anos',
    'teen de 19',
    'menor de idade',
  ])('bloqueia: %s', (t) => expect(minorTermIn(t), t).not.toBeNull());

  it.each([
    'loja de moda infantil',
    'atendente de uma escola de idiomas',
    'adolescentes costumam gostar',
    'a novidade da semana',
    'sapato novinho em folha? não: sapato novo',
    'mulher de 28 anos',
    'estudante universitária de 22 anos',
  ])('NÃO bloqueia: %s', (t) => {
    // "novinho" (masculino) e "novidade" não são o termo bloqueado.
    expect(minorTermIn(t), t).toBeNull();
  });

  it('procura em objetos aninhados', () => {
    expect(minorTermInObject({ a: 'ok', b: { c: ['x', 'persona colegial'] } })).toBe('colegial');
    expect(minorTermInObject({ a: 'ok', b: [1, null, { c: 'tudo certo' }] })).toBeNull();
  });
});
