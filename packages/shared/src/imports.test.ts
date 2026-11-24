import { describe, expect, it } from 'vitest';
import { guessHasHeader, importMappingSchema, parseImportRow, suggestMapping } from './imports';
import { normalizePhone } from './phone';

describe('mapeamento automático', () => {
  it('reconhece cabeçalhos em português e inglês, com acentos', () => {
    const sample = [
      ['Nome Completo', 'Celular/WhatsApp', 'Observações', 'Etiquetas'],
      ['Ana', '11987654321', '', 'vip'],
    ];
    expect(guessHasHeader(sample)).toBe(true);
    expect(suggestMapping(sample, true)).toEqual({ phone: 1, name: 0, notes: 2, tags: 3 });
  });
  it('sem cabeçalho, escolhe a coluna com mais telefones', () => {
    const sample = [
      ['Ana', 'x', '11987654321'],
      ['Bia', 'y', '21998765432'],
    ];
    expect(guessHasHeader(sample)).toBe(false);
    expect(suggestMapping(sample, false).phone).toBe(2);
  });
});

describe('interpretação de linhas', () => {
  const m = { columns: { phone: 1, name: 0, tags: 2, notes: null }, defaultCountry: 'BR' };
  it('normaliza telefone e separa etiquetas', () => {
    expect(parseImportRow(['Ana', '(11) 98765-4321', 'vip; sp'], m)).toEqual({
      phoneE164: '+5511987654321',
      name: 'Ana',
      tags: ['vip', 'sp'],
      notes: null,
      invalidReason: null,
    });
  });
  it('classifica números ausentes, incompletos e inválidos', () => {
    expect(parseImportRow(['Ana', ''], m).invalidReason).toBe('Telefone ausente');
    expect(parseImportRow(['Ana', '119876'], m).invalidReason).toBe('Número incompleto');
    expect(parseImportRow(['Ana', 'abc'], m).invalidReason).not.toBeNull();
  });
  it('usa o país padrão informado', () => {
    expect(parseImportRow(['x', '912345678'], { ...m, defaultCountry: 'PT' }).phoneE164).toBe(
      '+351912345678',
    );
    expect(normalizePhone('912345678', 'PT')).toMatchObject({ ok: true });
  });
});

describe('validação do mapeamento', () => {
  it('exige origem do consentimento quando a lista é marcada como autorizada', () => {
    const base = { hasHeader: true, columns: { phone: 0 }, consent: { status: 'GRANTED' } };
    expect(importMappingSchema.safeParse(base).success).toBe(false);
    expect(
      importMappingSchema.safeParse({
        ...base,
        consent: { status: 'GRANTED', source: 'Formulário do site' },
      }).success,
    ).toBe(true);
  });
  it('impede a mesma coluna em dois campos', () => {
    expect(
      importMappingSchema.safeParse({
        hasHeader: true,
        columns: { phone: 0, name: 0 },
        consent: { status: 'PENDING' },
      }).success,
    ).toBe(false);
  });
});
