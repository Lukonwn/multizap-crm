import type { Readable } from 'node:stream';
import { readRows, type Delimiter, type Encoding, type FileFormat } from '@multizap/files';
import { guessHasHeader, suggestMapping } from '@multizap/shared';

export interface InputFile {
  name: string;
  format: FileFormat;
  encoding: Encoding;
  delimiter: Delimiter | null;
  open(): Promise<Readable>;
}

export interface OutputWriter {
  write(row: (string | number | null | undefined)[]): Promise<void>;
  end(): Promise<void>;
  readonly rows: number;
}

/** Destino dos arquivos gerados (disco temporário no worker; memória nos testes). */
export interface OutputSink {
  create(name: string, format: 'csv' | 'xlsx'): OutputWriter;
}

export interface ToolContext {
  inputs: InputFile[];
  output: OutputSink;
}

export type Summary = Record<string, unknown>;

/** Nome-base seguro para arquivos de saída. */
export function baseName(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'lista'
  );
}

export async function* rowsOf(input: InputFile): AsyncGenerator<{ line: number; row: string[] }> {
  let line = 0;
  for await (const row of readRows(await input.open(), input.format, {
    encoding: input.encoding,
    delimiter: input.delimiter,
  })) {
    line++;
    yield { line, row };
  }
}

export interface Layout {
  hasHeader: boolean;
  header: string[] | null;
  phoneColumn: number;
  width: number;
}

/** Cabeçalho e coluna de telefone: informados pelo usuário ou detectados. */
export async function resolveLayout(
  input: InputFile,
  opts: { hasHeader?: boolean; phoneColumn?: number },
): Promise<Layout> {
  const sample: string[][] = [];
  for await (const { row } of rowsOf(input)) {
    if (row.length) sample.push(row);
    if (sample.length >= 25) break;
  }
  const hasHeader = opts.hasHeader ?? guessHasHeader(sample);
  const phoneColumn = opts.phoneColumn ?? suggestMapping(sample, hasHeader).phone;
  return {
    hasHeader,
    header: hasHeader ? (sample[0] ?? null) : null,
    phoneColumn,
    width: Math.max(0, ...sample.map((r) => r.length)),
  };
}

/** Linhas de dados (sem cabeçalho e sem linhas vazias), com o número da linha original. */
export async function* dataRows(
  input: InputFile,
  layout: Pick<Layout, 'hasHeader'>,
): AsyncGenerator<{ line: number; row: string[] }> {
  let headerSkipped = !layout.hasHeader;
  for await (const r of rowsOf(input)) {
    if (!r.row.length) continue;
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }
    yield r;
  }
}

/** Cabeçalho de saída: original ou genérico, seguido de colunas extras. */
export function outputHeader(layout: Layout, extra: string[] = []): string[] | null {
  if (layout.header) return [...layout.header, ...extra];
  if (!extra.length) return null;
  return [...Array.from({ length: layout.width }, (_, i) => `coluna_${i + 1}`), ...extra];
}

/** Completa a linha até a largura informada (para colunas extras alinhadas). */
export function pad(row: string[], width: number): string[] {
  return row.length >= width ? row : [...row, ...Array<string>(width - row.length).fill('')];
}
