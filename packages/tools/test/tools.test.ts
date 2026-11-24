import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { MemorySink, analyzePhone, runTool, type InputFile } from '../src/index';

const csv = (name: string, text: string, delimiter: ';' | ',' | null = ';'): InputFile => ({
  name,
  format: 'csv',
  encoding: 'utf8',
  delimiter,
  open: async () => Readable.from([Buffer.from(text)]),
});

async function run(tool: Parameters<typeof runTool>[0], inputs: InputFile[], params: object = {}) {
  const sink = new MemorySink();
  const summary = await runTool(tool, { inputs, output: sink }, params);
  return { sink, summary };
}

const LIST =
  'nome;telefone\nAna;(11) 98765-4321\nBruno;21 99876-5432\n\nAna 2;+55 11 98765-4321\nCarla;119876\nDiego;+351 912 345 678\nEva;(11) 3456-7890\n';

describe('análise de telefone (estrutural)', () => {
  it('identifica país, DDD, UF e tipo', () => {
    expect(analyzePhone('(11) 98765-4321')).toMatchObject({
      status: 'valid',
      e164: '+5511987654321',
      country: 'BR',
      ddd: '11',
      uf: 'SP',
      type: 'celular',
    });
    expect(analyzePhone('(11) 3456-7890')).toMatchObject({ status: 'valid', type: 'fixo' });
    expect(analyzePhone('+351 912 345 678')).toMatchObject({
      status: 'valid',
      country: 'PT',
      countryCode: '351',
      ddd: null,
    });
    expect(analyzePhone('119876')).toMatchObject({
      status: 'incomplete',
      reason: 'Número incompleto',
    });
    expect(analyzePhone('')).toMatchObject({ status: 'empty' });
    expect(analyzePhone('abc')).toMatchObject({ status: 'empty' });
  });
});

describe('ferramentas', () => {
  it('conversor CSV → XLSX (linhas vazias removidas)', async () => {
    const { sink, summary } = await run('convert', [csv('Lista Clientes.csv', LIST)], {
      outputFormat: 'xlsx',
    });
    expect(summary).toMatchObject({ rows: 7, emptyRowsSkipped: 1, to: 'xlsx' });
    expect(sink.get('Lista-Clientes.xlsx')[0]).toEqual(['nome', 'telefone']);
  });

  it('divisor por linhas repete o cabeçalho em cada parte', async () => {
    const { sink, summary } = await run('split', [csv('l.csv', LIST)], { mode: 'rows', size: 2 });
    expect(summary).toMatchObject({ rows: 6, parts: 3, rowsPerPart: [2, 2, 2] });
    expect(sink.get('l-parte-001.csv')).toEqual([
      ['nome', 'telefone'],
      ['Ana', '(11) 98765-4321'],
      ['Bruno', '21 99876-5432'],
    ]);
    expect(sink.get('l-parte-003.csv')[0]).toEqual(['nome', 'telefone']);
  });

  it('divisor em N partes', async () => {
    const { summary } = await run('split', [csv('l.csv', LIST)], { mode: 'parts', size: 4 });
    expect(summary).toMatchObject({ parts: 3, rowsPerPart: [2, 2, 2] });
  });

  it('comparador de listas pelo telefone normalizado', async () => {
    const a = csv('a.csv', 'tel\n11987654321\n21998765432\n31987651234\n');
    const b = csv('b.csv', 'nome,celular\nX,+55 (11) 98765-4321\nY,41999998888\n', ',');
    const { sink, summary } = await run('compare', [a, b]);
    expect(summary).toMatchObject({ totalA: 3, totalB: 2, onlyA: 2, onlyB: 1, both: 1 });
    expect(sink.get('em-ambas-as-listas.csv')).toEqual([['tel'], ['11987654321']]);
    expect(sink.get('somente-na-lista-B.csv')).toEqual([
      ['nome', 'celular'],
      ['Y', '41999998888'],
    ]);
  });

  it('removedor de duplicados pelo telefone, com relatório', async () => {
    const { sink, summary } = await run('dedupe', [csv('l.csv', LIST)]);
    expect(summary).toMatchObject({
      total: 6,
      kept: 5,
      duplicatesRemoved: 1,
      keptWithoutValidPhone: 1,
    });
    expect(sink.get('l-duplicados-removidos.csv')[1]).toEqual([5, 2, 'Ana 2', '+55 11 98765-4321']);
  });

  it('removedor de duplicados pela linha inteira', async () => {
    const { summary } = await run('dedupe', [csv('l.csv', 'a;b\nx;1\nX ;1\ny;2\n')], {
      by: 'row',
      hasHeader: true,
    });
    expect(summary).toMatchObject({ kept: 2, duplicatesRemoved: 1 });
  });

  it('extrator de telefones em texto livre', async () => {
    const text =
      'obs\n"Ligar para (11) 98765-4321 ou 21 99876-5432"\nSem número aqui\nRepetido: +55 11 98765-4321\n';
    const { sink, summary } = await run('extract-phones', [csv('t.csv', text, null)]);
    expect(summary).toMatchObject({ phonesWritten: 2, uniquePhones: 2, duplicatesFound: 1 });
    expect(sink.get('telefones-extraidos.csv')).toEqual([
      ['telefone', 'pais', 'ddd', 'linha_origem'],
      ['+5511987654321', 'Brasil', '11', 2],
      ['+5521998765432', 'Brasil', '21', 2],
    ]);
  });

  it('organizador por DDD (arquivos por DDD + arquivo com colunas DDD/UF)', async () => {
    const { sink, summary } = await run('group-ddd', [csv('l.csv', LIST)]);
    expect(summary).toMatchObject({
      total: 6,
      counts: { 'DDD 11 (SP)': 3, 'DDD 21 (RJ)': 1, 'Outros países': 1, 'Sem telefone válido': 1 },
    });
    expect(sink.get('ddd-11-SP.csv')).toHaveLength(4);
    expect(sink.get('l-com-ddd.csv')[0]).toEqual([
      'nome',
      'telefone',
      'telefone_normalizado',
      'ddd',
      'uf',
    ]);
    expect(sink.get('l-com-ddd.csv')[2]).toEqual([
      'Bruno',
      '21 99876-5432',
      '+5521998765432',
      '21',
      'RJ',
    ]);
  });

  it('organizador por país', async () => {
    const { sink, summary } = await run('group-country', [csv('l.csv', LIST)]);
    expect(summary.counts).toMatchObject({
      'Brasil (+55)': 4,
      'Portugal (+351)': 1,
      'Sem telefone válido': 1,
    });
    expect(sink.get('pais-PT-Portugal.csv')).toEqual([
      ['nome', 'telefone'],
      ['Diego', '+351 912 345 678'],
    ]);
  });

  it('removedor de linhas vazias', async () => {
    const { summary } = await run('remove-empty', [csv('l.csv', 'a;b\n\n;\n1;2\n   ;  \n')]);
    expect(summary).toMatchObject({ kept: 2, emptyRowsRemoved: 3 });
  });

  it('higienizador classifica cada registro e separa válidos e rejeitados', async () => {
    const { sink, summary } = await run('sanitize', [csv('l.csv', LIST)]);
    expect(summary).toMatchObject({
      total: 6,
      valid: 4,
      duplicate: 1,
      incomplete: 1,
      invalid: 0,
      empty: 0,
      mobile: 3,
      fixed: 1,
    });
    expect(summary.topDdd).toMatchObject({ '11 (SP)': 2, '21 (RJ)': 1 });
    const all = sink.get('l-higienizado.csv');
    expect(all[0]).toEqual([
      'nome',
      'telefone',
      'telefone_normalizado',
      'pais',
      'codigo_pais',
      'ddd',
      'uf',
      'tipo',
      'situacao',
      'motivo',
    ]);
    expect(all[3]).toEqual([
      'Ana 2',
      '+55 11 98765-4321',
      '+5511987654321',
      'Brasil',
      '+55',
      '11',
      'SP',
      'celular',
      'duplicado',
      'Duplicado da linha 2',
    ]);
    expect(all[4]!.slice(-2)).toEqual(['incompleto', 'Número incompleto']);
    expect(sink.get('l-validos.csv')).toHaveLength(5);
    expect(sink.get('l-rejeitados.csv')).toHaveLength(3);
  });

  it('aceita XLSX como entrada e respeita coluna/cabeçalho informados', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('a');
    ws.addRow(['x', 5511987654321]);
    ws.addRow(['y', 5511987654321]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const input: InputFile = {
      name: 'p.xlsx',
      format: 'xlsx',
      encoding: 'utf8',
      delimiter: null,
      open: async () => Readable.from([buf]),
    };
    const { summary } = await run('dedupe', [input], { hasHeader: false, phoneColumn: 1 });
    expect(summary).toMatchObject({ total: 2, duplicatesRemoved: 1 });
  });

  it('rejeita parâmetros inválidos', async () => {
    await expect(
      run('split', [csv('l.csv', LIST)], { mode: 'parts', size: 5000 }),
    ).rejects.toThrow();
  });
});
