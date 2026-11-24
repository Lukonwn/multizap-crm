import type { ToolId, ToolParams } from '@multizap/shared';
import {
  baseName,
  dataRows,
  outputHeader,
  pad,
  resolveLayout,
  rowsOf,
  type OutputWriter,
  type Summary,
  type ToolContext,
} from './context';
import { PHONE_CANDIDATE_RE, analyzePhone, countryName } from './phone';

const first = (ctx: ToolContext) => {
  const input = ctx.inputs[0];
  if (!input) throw new Error('Arquivo de entrada ausente.');
  return input;
};

async function writeHeader(w: OutputWriter, header: string[] | null) {
  if (header) await w.write(header);
}

// ─── Conversor ──────────────────────────────────────────────────────────────

export async function convert(ctx: ToolContext, p: ToolParams<'convert'>): Promise<Summary> {
  const input = first(ctx);
  const out = ctx.output.create(`${baseName(input.name)}.${p.outputFormat}`, p.outputFormat);
  let empty = 0;
  for await (const { row } of rowsOf(input)) {
    if (!row.length) {
      empty++;
      continue;
    }
    await out.write(row);
  }
  await out.end();
  return { rows: out.rows, emptyRowsSkipped: empty, from: input.format, to: p.outputFormat };
}

// ─── Divisor ────────────────────────────────────────────────────────────────

export async function split(ctx: ToolContext, p: ToolParams<'split'>): Promise<Summary> {
  const input = first(ctx);
  const layout = await resolveLayout(input, { hasHeader: p.hasHeader });
  let perFile = p.size;
  let total = 0;
  if (p.mode === 'parts') {
    for await (const _ of dataRows(input, layout)) total++;
    perFile = Math.max(1, Math.ceil(total / p.size));
  }
  const base = baseName(input.name);
  let part = 0;
  let current: OutputWriter | null = null;
  let count = 0;
  const parts: number[] = [];
  for await (const { row } of dataRows(input, layout)) {
    if (!current || current.rows - (layout.header ? 1 : 0) >= perFile) {
      if (current) {
        await current.end();
        parts.push(current.rows - (layout.header ? 1 : 0));
      }
      part++;
      current = ctx.output.create(
        `${base}-parte-${String(part).padStart(3, '0')}.${p.outputFormat}`,
        p.outputFormat,
      );
      await writeHeader(current, layout.header);
    }
    await current.write(row);
    count++;
  }
  if (current) {
    await current.end();
    parts.push(current.rows - (layout.header ? 1 : 0));
  }
  return { rows: count, parts: parts.length, rowsPerPart: parts, headerRepeated: layout.hasHeader };
}

// ─── Comparador ─────────────────────────────────────────────────────────────

export async function compare(ctx: ToolContext, p: ToolParams<'compare'>): Promise<Summary> {
  const [a, b] = ctx.inputs;
  if (!a || !b) throw new Error('O comparador precisa de duas listas.');
  const la = await resolveLayout(a, { hasHeader: p.hasHeaderA, phoneColumn: p.phoneColumnA });
  const lb = await resolveLayout(b, { hasHeader: p.hasHeaderB, phoneColumn: p.phoneColumnB });
  const phoneOf = (row: string[], col: number) =>
    analyzePhone(row[col] ?? '', p.defaultCountry).e164;

  const setA = new Set<string>();
  const setB = new Set<string>();
  let invalidA = 0;
  let invalidB = 0;
  let totalA = 0;
  let totalB = 0;
  for await (const { row } of dataRows(b, lb)) {
    totalB++;
    const ph = phoneOf(row, lb.phoneColumn);
    if (ph) setB.add(ph);
    else invalidB++;
  }

  const ext = p.outputFormat;
  const onlyA = ctx.output.create(`somente-na-lista-A.${ext}`, ext);
  const both = ctx.output.create(`em-ambas-as-listas.${ext}`, ext);
  await writeHeader(onlyA, la.header);
  await writeHeader(both, la.header);
  for await (const { row } of dataRows(a, la)) {
    totalA++;
    const ph = phoneOf(row, la.phoneColumn);
    if (!ph) {
      invalidA++;
      continue;
    }
    setA.add(ph);
    await (setB.has(ph) ? both : onlyA).write(row);
  }
  await onlyA.end();
  await both.end();

  const onlyB = ctx.output.create(`somente-na-lista-B.${ext}`, ext);
  await writeHeader(onlyB, lb.header);
  for await (const { row } of dataRows(b, lb)) {
    const ph = phoneOf(row, lb.phoneColumn);
    if (ph && !setA.has(ph)) await onlyB.write(row);
  }
  await onlyB.end();

  const hdr = (l: typeof la) => (l.header ? 1 : 0);
  return {
    totalA,
    totalB,
    onlyA: onlyA.rows - hdr(la),
    onlyB: onlyB.rows - hdr(lb),
    both: both.rows - hdr(la),
    uniquePhonesA: setA.size,
    uniquePhonesB: setB.size,
    withoutValidPhoneA: invalidA,
    withoutValidPhoneB: invalidB,
  };
}

// ─── Removedor de duplicados ────────────────────────────────────────────────

export async function dedupe(ctx: ToolContext, p: ToolParams<'dedupe'>): Promise<Summary> {
  const input = first(ctx);
  const layout = await resolveLayout(input, p);
  const base = baseName(input.name);
  const kept = ctx.output.create(`${base}-sem-duplicados.${p.outputFormat}`, p.outputFormat);
  const removed = ctx.output.create(
    `${base}-duplicados-removidos.${p.outputFormat}`,
    p.outputFormat,
  );
  await writeHeader(kept, layout.header);
  await removed.write([
    'linha',
    'duplicado_da_linha',
    ...(layout.header ?? Array.from({ length: layout.width }, (_, i) => `coluna_${i + 1}`)),
  ]);

  const seen = new Map<string, number>();
  let total = 0;
  let duplicates = 0;
  let noPhone = 0;
  for await (const { line, row } of dataRows(input, layout)) {
    total++;
    let key: string | null;
    if (p.by === 'phone') {
      key = analyzePhone(row[layout.phoneColumn] ?? '', p.defaultCountry).e164;
      if (!key) noPhone++; // sem telefone válido: mantida (não há como comparar)
    } else {
      key = row.map((c) => c.trim().toLowerCase()).join('\u0001');
    }
    const firstLine = key ? seen.get(key) : undefined;
    if (key && firstLine !== undefined) {
      duplicates++;
      await removed.write([line, firstLine, ...row]);
      continue;
    }
    if (key) seen.set(key, line);
    await kept.write(row);
  }
  await kept.end();
  await removed.end();
  return {
    total,
    kept: total - duplicates,
    duplicatesRemoved: duplicates,
    by: p.by,
    ...(p.by === 'phone' && { keptWithoutValidPhone: noPhone }),
  };
}

// ─── Extrator de telefones ──────────────────────────────────────────────────

export async function extractPhones(
  ctx: ToolContext,
  p: ToolParams<'extract-phones'>,
): Promise<Summary> {
  const input = first(ctx);
  const out = ctx.output.create(`telefones-extraidos.${p.outputFormat}`, p.outputFormat);
  await out.write(['telefone', 'pais', 'ddd', 'linha_origem']);
  const seen = new Set<string>();
  let candidates = 0;
  let found = 0;
  let duplicates = 0;
  let lines = 0;
  const layout = p.hasHeader === undefined ? null : { hasHeader: p.hasHeader };
  const iter = layout ? dataRows(input, layout) : rowsOf(input);
  for await (const { line, row } of iter) {
    if (!row.length) continue;
    lines++;
    for (const cell of row) {
      for (const m of cell.matchAll(PHONE_CANDIDATE_RE)) {
        candidates++;
        const info = analyzePhone(m[0], p.defaultCountry);
        if (!info.e164) continue;
        if (seen.has(info.e164)) {
          duplicates++;
          if (p.unique) continue;
        }
        seen.add(info.e164);
        found++;
        await out.write([info.e164, countryName(info.country ?? undefined), info.ddd ?? '', line]);
      }
    }
  }
  await out.end();
  return {
    linesScanned: lines,
    candidates,
    phonesWritten: found,
    uniquePhones: seen.size,
    duplicatesFound: duplicates,
  };
}

// ─── Organizadores (DDD / país) ─────────────────────────────────────────────

async function groupBy(
  ctx: ToolContext,
  p: ToolParams<'group-ddd'>,
  kind: 'ddd' | 'country',
): Promise<Summary> {
  const input = first(ctx);
  const layout = await resolveLayout(input, p);
  const base = baseName(input.name);
  const ext = p.outputFormat;
  const extraCols =
    kind === 'ddd'
      ? ['telefone_normalizado', 'ddd', 'uf']
      : ['telefone_normalizado', 'codigo_pais', 'pais'];
  const width = Math.max(layout.width, layout.header?.length ?? 0);
  const combined = ctx.output.create(
    `${base}-${kind === 'ddd' ? 'com-ddd' : 'com-pais'}.${ext}`,
    ext,
  );
  await writeHeader(combined, outputHeader(layout, extraCols));

  const groups = new Map<string, { writer: OutputWriter; label: string }>();
  const counts: Record<string, number> = {};
  const groupWriter = async (key: string, fileName: string, label: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { writer: ctx.output.create(`${fileName}.${ext}`, ext), label };
      await writeHeader(g.writer, layout.header);
      groups.set(key, g);
    }
    counts[label] = (counts[label] ?? 0) + 1;
    return g.writer;
  };

  let total = 0;
  for await (const { row } of dataRows(input, layout)) {
    total++;
    const info = analyzePhone(row[layout.phoneColumn] ?? '', p.defaultCountry);
    let w: OutputWriter;
    let extra: string[];
    if (!info.e164) {
      w = await groupWriter('__invalid', 'sem-telefone-valido', 'Sem telefone válido');
      extra = ['', '', ''];
    } else if (kind === 'ddd') {
      if (info.country !== 'BR' || !info.ddd) {
        w = await groupWriter('__foreign', 'outros-paises', 'Outros países');
        extra = [info.e164, '', ''];
      } else {
        const uf = info.uf ?? 'NA';
        w = await groupWriter(info.ddd, `ddd-${info.ddd}-${uf}`, `DDD ${info.ddd} (${uf})`);
        extra = [info.e164, info.ddd, uf];
      }
    } else {
      const iso = info.country ?? 'XX';
      const name = countryName(iso);
      w = await groupWriter(iso, `pais-${iso}-${baseName(name)}`, `${name} (+${info.countryCode})`);
      extra = [info.e164, `+${info.countryCode}`, name];
    }
    await w.write(row);
    await combined.write([...pad(row, width), ...extra]);
  }
  await combined.end();
  for (const g of groups.values()) await g.writer.end();
  const sorted = Object.fromEntries(Object.entries(counts).sort((x, y) => y[1] - x[1]));
  return { total, groups: groups.size, counts: sorted };
}

// ─── Removedor de linhas vazias ─────────────────────────────────────────────

export async function removeEmpty(
  ctx: ToolContext,
  p: ToolParams<'remove-empty'>,
): Promise<Summary> {
  const input = first(ctx);
  const out = ctx.output.create(
    `${baseName(input.name)}-sem-linhas-vazias.${p.outputFormat}`,
    p.outputFormat,
  );
  let removed = 0;
  // readRows já remove espaços nas extremidades das células e marca linhas vazias.
  for await (const { row } of rowsOf(input)) {
    if (!row.length) {
      removed++;
      continue;
    }
    await out.write(row);
  }
  await out.end();
  return { kept: out.rows, emptyRowsRemoved: removed };
}

// ─── Higienizador ───────────────────────────────────────────────────────────

const STATUS_LABEL = {
  valid: 'válido',
  duplicate: 'duplicado',
  incomplete: 'incompleto',
  invalid: 'inválido',
  empty: 'sem telefone',
} as const;

export async function sanitize(ctx: ToolContext, p: ToolParams<'sanitize'>): Promise<Summary> {
  const input = first(ctx);
  const layout = await resolveLayout(input, p);
  const base = baseName(input.name);
  const ext = p.outputFormat;
  const extra = [
    'telefone_normalizado',
    'pais',
    'codigo_pais',
    'ddd',
    'uf',
    'tipo',
    'situacao',
    'motivo',
  ];
  const header = outputHeader(layout, extra);
  const width = Math.max(layout.width, layout.header?.length ?? 0);
  const all = ctx.output.create(`${base}-higienizado.${ext}`, ext);
  const valid = ctx.output.create(`${base}-validos.${ext}`, ext);
  const rejected = ctx.output.create(`${base}-rejeitados.${ext}`, ext);
  for (const w of [all, valid, rejected]) await writeHeader(w, header);

  const seen = new Map<string, number>();
  const stats = {
    total: 0,
    valid: 0,
    duplicate: 0,
    incomplete: 0,
    invalid: 0,
    empty: 0,
    mobile: 0,
    fixed: 0,
  };
  const byCountry: Record<string, number> = {};
  const byDdd: Record<string, number> = {};

  for await (const { line, row } of dataRows(input, layout)) {
    stats.total++;
    const info = analyzePhone(row[layout.phoneColumn] ?? '', p.defaultCountry);
    let status: keyof typeof STATUS_LABEL = info.status;
    let reason = info.reason ?? '';
    if (info.e164) {
      const firstLine = seen.get(info.e164);
      if (firstLine !== undefined) {
        status = 'duplicate';
        reason = `Duplicado da linha ${firstLine}`;
      } else {
        seen.set(info.e164, line);
      }
    }
    stats[status]++;
    if (status === 'valid') {
      if (info.type === 'celular') stats.mobile++;
      if (info.type === 'fixo') stats.fixed++;
      const c = countryName(info.country ?? undefined);
      byCountry[c] = (byCountry[c] ?? 0) + 1;
      if (info.ddd)
        byDdd[`${info.ddd} (${info.uf ?? '?'})`] =
          (byDdd[`${info.ddd} (${info.uf ?? '?'})`] ?? 0) + 1;
    }
    const out = [
      ...pad(row, width),
      info.e164 ?? '',
      countryName(info.country ?? undefined),
      info.countryCode ? `+${info.countryCode}` : '',
      info.ddd ?? '',
      info.uf ?? '',
      info.type ?? '',
      STATUS_LABEL[status],
      reason,
    ];
    await all.write(out);
    await (status === 'valid' ? valid : rejected).write(out);
  }
  for (const w of [all, valid, rejected]) await w.end();
  const top = (o: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15),
    );
  return {
    ...stats,
    byCountry: top(byCountry),
    topDdd: top(byDdd),
    note: 'Validação estrutural: não indica se o número possui conta WhatsApp.',
  };
}

// ─── Registro ───────────────────────────────────────────────────────────────

export const TOOL_RUNNERS: {
  [K in ToolId]: (ctx: ToolContext, p: ToolParams<K>) => Promise<Summary>;
} = {
  convert,
  split,
  compare,
  dedupe,
  'extract-phones': extractPhones,
  'group-ddd': (ctx, p) => groupBy(ctx, p, 'ddd'),
  'group-country': (ctx, p) => groupBy(ctx, p, 'country'),
  'remove-empty': removeEmpty,
  sanitize,
};

/** Ferramentas cujas várias saídas também são entregues em um único ZIP. */
export const ZIP_OUTPUT_TOOLS: ToolId[] = ['split', 'group-ddd', 'group-country'];
