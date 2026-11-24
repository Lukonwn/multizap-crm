import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import ExcelJS from 'exceljs';
import {
  csvWriter,
  detectDelimiter,
  detectEncoding,
  detectFormat,
  readRows,
  sniff,
  xlsxWriter,
} from '../src/index';

const open = (buf: Buffer) => async () => Readable.from([buf]);

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function all(buf: Buffer, format: 'csv' | 'txt' | 'xlsx') {
  const s = await sniff(open(buf), format);
  const rows: string[][] = [];
  for await (const r of readRows(await open(buf)(), format, s)) rows.push(r);
  return { s, rows };
}

describe('detecção', () => {
  it('formato pela extensão', () => {
    expect(detectFormat('Lista.CSV')).toBe('csv');
    expect(detectFormat('a.txt')).toBe('txt');
    expect(detectFormat('a.xlsx')).toBe('xlsx');
    expect(detectFormat('a.xls')).toBeNull();
  });
  it('codificação: UTF-8 vs Windows-1252', () => {
    expect(detectEncoding(Buffer.from('João;Conceição'))).toBe('utf8');
    expect(detectEncoding(iconv.encode('João;Conceição', 'win1252'))).toBe('win1252');
  });
  it('delimitador mais consistente, ignorando os que estão entre aspas', () => {
    expect(detectDelimiter('nome;telefone\nA;1\nB;2')).toBe(';');
    expect(detectDelimiter('nome,telefone\n"Silva, João",1\nB,2')).toBe(',');
    expect(detectDelimiter('a\tb\nc\td')).toBe('\t');
    expect(detectDelimiter('11987654321\n11912345678')).toBeNull();
  });
});

describe('leitura', () => {
  it('CSV UTF-8 com BOM, ";" e campos entre aspas', async () => {
    const csv = Buffer.from(
      '﻿nome;telefone;obs\n"Silva; João";(11) 98765-4321;"linha ""citada"""\n\nMaria;11912345678;\n',
    );
    const { s, rows } = await all(csv, 'csv');
    expect(s).toMatchObject({ encoding: 'utf8', delimiter: ';' });
    expect(rows[0]).toEqual(['nome', 'telefone', 'obs']);
    expect(rows[1]).toEqual(['Silva; João', '(11) 98765-4321', 'linha "citada"']);
    expect(rows[2]).toEqual([]); // linha vazia preservada para numeração
    expect(rows[3]).toEqual(['Maria', '11912345678', '']);
  });

  it('CSV Windows-1252 (Excel PT-BR) é convertido corretamente', async () => {
    const csv = iconv.encode('nome,telefone\nJoão Conceição,11987654321\n', 'win1252');
    const { s, rows } = await all(csv, 'csv');
    expect(s.encoding).toBe('win1252');
    expect(rows[1]![0]).toBe('João Conceição');
  });

  it('TXT de coluna única com linhas vazias', async () => {
    const txt = Buffer.from('11987654321\r\n\r\n+55 11 91234-5678\r\n');
    const { s, rows } = await all(txt, 'txt');
    expect(s.delimiter).toBeNull();
    expect(rows).toEqual([['11987654321'], [], ['+55 11 91234-5678']]);
  });

  it('XLSX: números, textos, fórmulas e linhas vazias', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contatos');
    ws.addRow(['Nome', 'Telefone']);
    ws.addRow(['Ana', 5511987654321]);
    ws.getRow(4).values = ['Bruno', '(21) 99876-5432'];
    ws.getCell('C2').value = { formula: '1+1', result: 2 };
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const { rows } = await all(buf, 'xlsx');
    expect(rows[0]).toEqual(['Nome', 'Telefone']);
    expect(rows[1]).toEqual(['Ana', '5511987654321', '2']);
    expect(rows[2]).toEqual([]);
    expect(rows[3]).toEqual(['Bruno', '(21) 99876-5432']);
  });
});

describe('escrita', () => {
  it('CSV com BOM e ";" (Excel PT-BR) — ida e volta', async () => {
    const out = new PassThrough();
    const done = collect(out);
    const w = csvWriter(out);
    await w.write(['nome', 'telefone']);
    await w.write(['Silva; João', '+5511987654321']);
    await w.end();
    const buf = await done;
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const { rows } = await all(buf, 'csv');
    expect(rows[1]).toEqual(['Silva; João', '+5511987654321']);
  });

  it('XLSX em streaming — ida e volta, telefone como texto', async () => {
    const out = new PassThrough();
    const done = collect(out);
    const w = xlsxWriter(out);
    await w.write(['telefone']);
    await w.write(['+5511987654321']);
    await w.end();
    const { rows } = await all(await done, 'xlsx');
    expect(rows).toEqual([['telefone'], ['+5511987654321']]);
  });

  it('processa 200 mil linhas em streaming', async () => {
    const out = new PassThrough();
    const done = collect(out);
    const w = csvWriter(out, { bom: false, delimiter: ',' });
    for (let i = 0; i < 200_000; i++)
      await w.write([`Contato ${i}`, `55119${String(i).padStart(8, '0')}`]);
    await w.end();
    let n = 0;
    for await (const _ of readRows(Readable.from([await done]), 'csv', { delimiter: ',' })) n++;
    expect(n).toBe(200_000);
  }, 60_000);
});
