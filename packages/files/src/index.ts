import { PassThrough, Readable, type Writable } from 'node:stream';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';

/**
 * Leitura e escrita de listas (CSV, TXT, XLSX) em streaming — suporta
 * arquivos grandes sem carregá-los inteiros em memória.
 */
export type FileFormat = 'csv' | 'txt' | 'xlsx';
export type Encoding = 'utf8' | 'win1252';
export type Delimiter = ',' | ';' | '\t' | '|';

export interface ReadOptions {
  encoding?: Encoding;
  delimiter?: Delimiter | null; // null = coluna única
}

export function detectFormat(fileName: string): FileFormat | null {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'csv') return 'csv';
  if (ext === 'txt') return 'txt';
  if (ext === 'xlsx') return 'xlsx';
  return null;
}

export const FORMAT_CONTENT_TYPE: Record<FileFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** UTF-8 válido → utf8; caso contrário Windows-1252 (CSV salvo pelo Excel em PT-BR). */
export function detectEncoding(sample: Buffer): Encoding {
  // Ignora um possível caractere multibyte cortado no fim da amostra.
  let end = sample.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = sample[end - i]!;
    if ((b & 0xc0) === 0xc0) {
      end -= i;
      break;
    }
    if ((b & 0x80) === 0) break;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, end));
    return 'utf8';
  } catch {
    return 'win1252';
  }
}

/** Escolhe o delimitador mais consistente nas primeiras linhas (fora de aspas). */
export function detectDelimiter(text: string): Delimiter | null {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 25);
  if (!lines.length) return null;
  const candidates: Delimiter[] = [';', ',', '\t', '|'];
  let best: Delimiter | null = null;
  let bestScore = 0;
  for (const d of candidates) {
    const counts = lines.map((l) => {
      let n = 0;
      let quoted = false;
      for (const ch of l) {
        if (ch === '"') quoted = !quoted;
        else if (ch === d && !quoted) n++;
      }
      return n;
    });
    const withDelim = counts.filter((c) => c > 0).length;
    if (withDelim === 0) continue;
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)]!;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    const score = (withDelim / lines.length) * consistent * (mode > 0 ? 1 : 0.5);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

async function readHead(stream: Readable, bytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    chunks.push(b);
    total += b.length;
    if (total >= bytes) break;
  }
  stream.destroy();
  return Buffer.concat(chunks).subarray(0, bytes);
}

function decode(stream: Readable, encoding: Encoding): Readable {
  if (encoding === 'utf8') return stream;
  return stream
    .pipe(iconv.decodeStream('win1252'))
    .pipe(iconv.encodeStream('utf8')) as unknown as Readable;
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText))
      return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if ('result' in o) return cellToString(o.result);
    if ('text' in o) return cellToString(o.text);
    if ('hyperlink' in o) return cellToString(o.hyperlink);
    if ('error' in o) return '';
  }
  return String(v);
}

async function* readXlsx(stream: Readable): AsyncGenerator<string[]> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
  });
  for await (const worksheet of reader) {
    let expected = 1;
    for await (const row of worksheet as AsyncIterable<ExcelJS.Row>) {
      // Linhas totalmente vazias não são emitidas pelo leitor; preserva a numeração.
      while (expected < row.number) {
        yield [];
        expected++;
      }
      const values = (row.values as unknown[]).slice(1).map(cellToString);
      yield values;
      expected = row.number + 1;
    }
    break; // somente a primeira planilha
  }
}

async function* readDelimited(
  stream: Readable,
  opts: Required<ReadOptions>,
): AsyncGenerator<string[]> {
  const parser = decode(stream, opts.encoding).pipe(
    parse({
      delimiter: opts.delimiter ?? '\u0000',
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
      quote: opts.delimiter ? '"' : false,
    }),
  );
  for await (const record of parser as AsyncIterable<string[]>) yield record;
}

/**
 * Itera as linhas do arquivo como arrays de texto (linhas vazias = []).
 * Para CSV/TXT informe encoding/delimitador detectados por `sniff`.
 */
export async function* readRows(
  stream: Readable,
  format: FileFormat,
  opts: ReadOptions = {},
): AsyncGenerator<string[]> {
  const rows =
    format === 'xlsx'
      ? readXlsx(stream)
      : readDelimited(stream, {
          encoding: opts.encoding ?? 'utf8',
          delimiter: opts.delimiter ?? null,
        });
  for await (const row of rows) {
    const cleaned = row.map((c) => (c ?? '').toString().trim());
    yield cleaned.every((c) => c === '') ? [] : cleaned;
  }
}

export interface SniffResult {
  format: FileFormat;
  encoding: Encoding;
  delimiter: Delimiter | null;
  /** Primeiras linhas não vazias. */
  sample: string[][];
}

/** Analisa o início do arquivo: codificação, delimitador e amostra. */
export async function sniff(
  open: () => Promise<Readable>,
  format: FileFormat,
  sampleRows = 25,
): Promise<SniffResult> {
  let encoding: Encoding = 'utf8';
  let delimiter: Delimiter | null = null;
  if (format !== 'xlsx') {
    const head = await readHead(await open(), 64 * 1024);
    encoding = detectEncoding(head);
    const text = encoding === 'utf8' ? head.toString('utf8') : iconv.decode(head, 'win1252');
    delimiter = detectDelimiter(text.replace(/^﻿/, ''));
  }
  const sample: string[][] = [];
  const stream = await open();
  for await (const row of readRows(stream, format, { encoding, delimiter })) {
    if (row.length) sample.push(row);
    if (sample.length >= sampleRows) break;
  }
  stream.destroy();
  return { format, encoding, delimiter, sample };
}

// ─── Escrita ────────────────────────────────────────────────────────────────

export interface RowWriter {
  write(row: (string | number | null | undefined)[]): Promise<void>;
  end(): Promise<void>;
}

/**
 * CSV com BOM UTF-8 e ";" por padrão (abre corretamente no Excel em PT-BR).
 */
export function csvWriter(
  out: Writable,
  opts: { delimiter?: Delimiter; bom?: boolean } = {},
): RowWriter {
  const s = stringify({
    delimiter: opts.delimiter ?? ';',
    bom: opts.bom ?? true,
    record_delimiter: '\r\n',
  });
  s.pipe(out);
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    s.on('error', reject);
  });
  return {
    async write(row) {
      if (!s.write(row.map((v) => (v === null || v === undefined ? '' : v)))) {
        await new Promise((r) => s.once('drain', r));
      }
    },
    async end() {
      s.end();
      await done;
    },
  };
}

/** XLSX em streaming (uma planilha). Células de telefone são gravadas como texto. */
export function xlsxWriter(out: Writable, sheetName = 'Dados'): RowWriter {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: out,
    useStyles: false,
    useSharedStrings: false,
  });
  const ws = wb.addWorksheet(sheetName);
  return {
    async write(row) {
      ws.addRow(row.map((v) => (v === null || v === undefined ? '' : String(v)))).commit();
    },
    async end() {
      ws.commit();
      await wb.commit();
    },
  };
}

export function rowWriter(format: 'csv' | 'xlsx', out: Writable): RowWriter {
  return format === 'xlsx' ? xlsxWriter(out) : csvWriter(out);
}

/** Cria um par (writer, stream legível) para enviar o resultado ao armazenamento. */
export function writerToStream(format: 'csv' | 'xlsx'): { writer: RowWriter; stream: Readable } {
  const pass = new PassThrough();
  return { writer: rowWriter(format, pass), stream: pass };
}

export { Readable };
