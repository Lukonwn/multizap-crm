import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { rowWriter } from '@multizap/files';
import type { OutputSink, OutputWriter } from './context';

export interface CreatedOutput {
  name: string;
  path: string;
  format: 'csv' | 'xlsx';
  writer: OutputWriter;
}

/**
 * Grava as saídas em um diretório temporário do worker. Permite várias
 * saídas abertas ao mesmo tempo (ex.: um arquivo por DDD) sem consumir
 * memória; o worker envia os arquivos ao armazenamento ao final.
 */
export class DiskSink implements OutputSink {
  readonly outputs: CreatedOutput[] = [];
  private readonly names = new Set<string>();

  constructor(private readonly dir: string) {}

  create(name: string, format: 'csv' | 'xlsx'): OutputWriter {
    let unique = name;
    for (let i = 2; this.names.has(unique); i++) unique = name.replace(/(\.[^.]+)$/, `-${i}$1`);
    this.names.add(unique);
    const path = join(this.dir, `${this.outputs.length}-${unique}`);
    const inner = rowWriter(format, createWriteStream(path));
    let rows = 0;
    const writer: OutputWriter = {
      async write(row) {
        rows++;
        await inner.write(row);
      },
      end: () => inner.end(),
      get rows() {
        return rows;
      },
    };
    this.outputs.push({ name: unique, path, format, writer });
    return writer;
  }
}

/** Saídas em memória (testes). */
export class MemorySink implements OutputSink {
  readonly files = new Map<string, (string | number | null | undefined)[][]>();
  create(name: string): OutputWriter {
    const rows: (string | number | null | undefined)[][] = [];
    this.files.set(name, rows);
    return {
      async write(row) {
        rows.push(row);
      },
      async end() {},
      get rows() {
        return rows.length;
      },
    };
  }
  get(name: string) {
    const f = this.files.get(name);
    if (!f)
      throw new Error(
        `Saída inexistente: ${name}. Existentes: ${[...this.files.keys()].join(', ')}`,
      );
    return f;
  }
}
