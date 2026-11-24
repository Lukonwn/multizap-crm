import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { createPrisma, type PrismaClient } from '@multizap/database';
import { LocalStorage, streamToBuffer } from '@multizap/storage';
import type { ImportMappingInput } from '@multizap/shared';
import { ImportProcessor } from '../src/imports/processor';

const prisma: PrismaClient = createPrisma(process.env.TEST_DATABASE_URL!);
let dir: string;
let storage: LocalStorage;
let proc: ImportProcessor;
let accountId: string;
let otherAccountId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mz-imp-'));
  storage = new LocalStorage(dir);
  proc = new ImportProcessor(prisma, storage);
});
afterAll(async () => {
  await prisma.$disconnect();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  if (!/test/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname))
    throw new Error('Somente banco de testes.');
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
  accountId = (
    await prisma.account.create({ data: { name: 'Vendas', connectionType: 'WHATSAPP_WEB' } })
  ).id;
  otherAccountId = (
    await prisma.account.create({ data: { name: 'Outra', connectionType: 'WHATSAPP_WEB' } })
  ).id;
});

async function createImport(
  content: Buffer | string,
  mapping: ImportMappingInput,
  opts: { format?: 'csv' | 'txt'; delimiter?: string | null; encoding?: string } = {},
) {
  const format = opts.format ?? 'csv';
  const id = crypto.randomUUID();
  const key = `imports/${accountId}/${id}/original.${format}`;
  await storage.put(key, Buffer.isBuffer(content) ? content : Buffer.from(content));
  return prisma.import.create({
    data: {
      id,
      accountId,
      fileName: `lista.${format}`,
      fileKey: key,
      fileHash: id,
      fileSize: 1,
      format,
      status: 'ANALYZING',
      mapping: {
        defaultCountry: 'BR',
        applyTagIds: [],
        existingPolicy: 'skip',
        ...mapping,
      } as object,
      options: {
        encoding: opts.encoding ?? 'utf8',
        delimiter: opts.delimiter === undefined ? ';' : opts.delimiter,
      },
    },
  });
}

const rowsByStatus = async (importId: string) =>
  Object.fromEntries(
    (
      await prisma.importRow.groupBy({
        by: ['status'],
        where: { importId },
        _count: { _all: true },
      })
    ).map((g) => [g.status, g._count._all]),
  );

const CSV = [
  'nome;telefone;etiquetas',
  'Ana;(11) 98765-4321;vip',
  'Bruno;11912345678;vip, sp',
  '',
  'Ana repetida;11 98765-4321;',
  'Carlos;119876;',
  'Diana;11955554444;',
  'Eva;11944443333;',
].join('\n');

describe('análise', () => {
  it('classifica cada linha sem importar nada', async () => {
    await prisma.contact.create({
      data: { accountId, phoneE164: '+5511955554444', name: 'Diana antiga' },
    });
    await prisma.optOut.create({
      data: { accountId, phoneE164: '+5511944443333', source: 'manual' },
    });
    // mesmo telefone em OUTRA instância não interfere
    await prisma.contact.create({
      data: { accountId: otherAccountId, phoneE164: '+5511912345678' },
    });

    const imp = await createImport(CSV, {
      hasHeader: true,
      columns: { phone: 1, name: 0, tags: 2 },
      consent: { status: 'PENDING' },
    });
    await proc.analyze(imp.id);

    const done = await prisma.import.findUniqueOrThrow({ where: { id: imp.id } });
    expect(done.status).toBe('ANALYZED');
    expect(done).toMatchObject({
      totalRows: 6,
      validRows: 2,
      invalidRows: 1,
      optedOutRows: 1,
      existingRows: 1,
      duplicateRows: 2,
    });
    expect(await prisma.contact.count({ where: { accountId } })).toBe(1); // nada importado ainda

    const rows = await prisma.importRow.findMany({
      where: { importId: imp.id },
      orderBy: { rowNumber: 'asc' },
    });
    expect(rows.map((r) => [r.rowNumber, r.status])).toEqual([
      [2, 'VALID'],
      [3, 'VALID'],
      [5, 'DUPLICATE'],
      [6, 'INVALID'],
      [7, 'DUPLICATE'],
      [8, 'OPTED_OUT'],
    ]);
    expect(rows[2]!.reason).toBe('Duplicado no arquivo (linha 2)');
    expect(rows[3]!.reason).toBe('Número incompleto');
    expect(rows[4]!.reason).toBe('Já cadastrado nesta instância');

    const rejected = (await streamToBuffer(await storage.get(done.rejectedFileKey!))).toString(
      'utf8',
    );
    expect(rejected).toContain('linha;situacao;motivo;nome;telefone;etiquetas');
    expect(rejected).toContain('6;Inválido;Número incompleto;Carlos;119876;');
    expect(rejected).not.toContain('Bruno');
  });

  it('lê TXT de coluna única sem cabeçalho e CSV em Windows-1252', async () => {
    const txt = await createImport(
      '11987654321\n\n11912345678\n',
      { hasHeader: false, columns: { phone: 0 }, consent: { status: 'PENDING' } },
      { format: 'txt', delimiter: null },
    );
    await proc.analyze(txt.id);
    expect((await prisma.import.findUniqueOrThrow({ where: { id: txt.id } })).validRows).toBe(2);

    const win = await createImport(
      iconv.encode('nome,telefone\nJoão,11987654321\n', 'win1252'),
      { hasHeader: true, columns: { phone: 1, name: 0 }, consent: { status: 'PENDING' } },
      { delimiter: ',', encoding: 'win1252' },
    );
    await proc.analyze(win.id);
    const row = await prisma.importRow.findFirstOrThrow({ where: { importId: win.id } });
    expect(row.name).toBe('João');
  });
});

describe('importação (após confirmação)', () => {
  it('cria contatos com etiquetas, origem e consentimento documentado', async () => {
    const fixed = await prisma.tag.create({ data: { accountId, name: 'Feira 2026' } });
    const imp = await createImport(CSV, {
      hasHeader: true,
      columns: { phone: 1, name: 0, tags: 2 },
      consent: { status: 'GRANTED', source: 'Formulário da feira com aceite' },
      applyTagIds: [fixed.id],
    });
    await proc.analyze(imp.id);
    await prisma.import.update({ where: { id: imp.id }, data: { status: 'CONFIRMED' } });
    await proc.run(imp.id);

    const done = await prisma.import.findUniqueOrThrow({ where: { id: imp.id } });
    expect(done).toMatchObject({ status: 'COMPLETED', importedRows: 4 });
    const bruno = await prisma.contact.findFirstOrThrow({
      where: { accountId, phoneE164: '+5511912345678' },
      include: { tags: { include: { tag: true } }, consentEvents: true },
    });
    expect(bruno).toMatchObject({
      name: 'Bruno',
      origin: 'IMPORT',
      consentStatus: 'GRANTED',
      originDetail: 'Importação: lista.csv',
    });
    expect(bruno.tags.map((t) => t.tag.name).sort()).toEqual(['Feira 2026', 'sp', 'vip']);
    expect(bruno.consentEvents[0]).toMatchObject({
      action: 'GRANTED',
      source: 'Formulário da feira com aceite',
    });
    expect(bruno.consentEvents[0]!.evidence).toContain('linha 3');
    expect(await prisma.tag.count({ where: { accountId } })).toBe(3);
    expect(await prisma.contact.count({ where: { accountId: otherAccountId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'import.completed' } })).toBe(1);
  });

  it('política "atualizar": altera nome, eleva PENDENTE para AUTORIZADO e nunca sobrescreve revogação', async () => {
    const pending = await prisma.contact.create({
      data: { accountId, phoneE164: '+5511987654321', name: 'Antigo' },
    });
    const revoked = await prisma.contact.create({
      data: { accountId, phoneE164: '+5511912345678', consentStatus: 'REVOKED' },
    });
    const imp = await createImport(
      'nome;telefone\nAna Nova;11987654321\nBruno Novo;11912345678\n',
      {
        hasHeader: true,
        columns: { phone: 1, name: 0 },
        consent: { status: 'GRANTED', source: 'Lista de clientes com aceite' },
        existingPolicy: 'update',
      },
    );
    await proc.analyze(imp.id);
    expect((await prisma.import.findUniqueOrThrow({ where: { id: imp.id } })).validRows).toBe(2);
    await prisma.import.update({ where: { id: imp.id }, data: { status: 'CONFIRMED' } });
    await proc.run(imp.id);

    const a = await prisma.contact.findUniqueOrThrow({ where: { id: pending.id } });
    const b = await prisma.contact.findUniqueOrThrow({ where: { id: revoked.id } });
    expect(a).toMatchObject({ name: 'Ana Nova', consentStatus: 'GRANTED' });
    expect(b).toMatchObject({ name: 'Bruno Novo', consentStatus: 'REVOKED' });
    expect(await prisma.consentEvent.count({ where: { contactId: revoked.id } })).toBe(0);
    expect((await prisma.import.findUniqueOrThrow({ where: { id: imp.id } })).updatedRows).toBe(2);
  });

  it('respeita descadastramento ocorrido entre a análise e a confirmação', async () => {
    const imp = await createImport(
      'telefone\n11987654321\n11912345678\n',
      { hasHeader: true, columns: { phone: 0 }, consent: { status: 'PENDING' } },
      { delimiter: null },
    );
    await proc.analyze(imp.id);
    await prisma.optOut.create({
      data: { accountId, phoneE164: '+5511912345678', source: 'manual' },
    });
    await prisma.import.update({ where: { id: imp.id }, data: { status: 'CONFIRMED' } });
    await proc.run(imp.id);
    expect(await prisma.contact.count({ where: { accountId } })).toBe(1);
    expect(await rowsByStatus(imp.id)).toMatchObject({ IMPORTED: 1, OPTED_OUT: 1 });
  });

  it('retoma após falha no meio do processamento, sem duplicar contatos nem consentimentos', async () => {
    const lines = [
      'telefone',
      ...Array.from({ length: 1200 }, (_, i) => `11${String(900000000 + i)}`),
    ];
    const imp = await createImport(
      lines.join('\n'),
      {
        hasHeader: true,
        columns: { phone: 0 },
        consent: { status: 'GRANTED', source: 'Cadastro na loja' },
      },
      { delimiter: null },
    );
    await proc.analyze(imp.id);
    expect((await prisma.import.findUniqueOrThrow({ where: { id: imp.id } })).validRows).toBe(1200);
    await prisma.import.update({ where: { id: imp.id }, data: { status: 'CONFIRMED' } });

    const original = prisma.$transaction.bind(prisma);
    let calls = 0;
    (prisma as unknown as { $transaction: unknown }).$transaction = (async (
      ...args: Parameters<typeof original>
    ) => {
      if (++calls === 2) throw new Error('queda simulada');
      return original(...args);
    }) as typeof original;
    await expect(proc.run(imp.id)).rejects.toThrow('queda simulada');
    (prisma as unknown as { $transaction: unknown }).$transaction = original;

    const mid = await prisma.import.findUniqueOrThrow({ where: { id: imp.id } });
    expect(mid.status).toBe('PROCESSING');
    expect(await prisma.contact.count({ where: { accountId } })).toBe(500);

    await proc.run(imp.id); // nova tentativa (BullMQ)
    const done = await prisma.import.findUniqueOrThrow({ where: { id: imp.id } });
    expect(done).toMatchObject({ status: 'COMPLETED', importedRows: 1200 });
    expect(await prisma.contact.count({ where: { accountId } })).toBe(1200);
    expect(await prisma.consentEvent.count({ where: { accountId } })).toBe(1200);
  }, 60_000);

  it('não executa importação sem confirmação', async () => {
    const imp = await createImport(
      'telefone\n11987654321\n',
      { hasHeader: true, columns: { phone: 0 }, consent: { status: 'PENDING' } },
      { delimiter: null },
    );
    await proc.analyze(imp.id);
    await proc.run(imp.id); // status ANALYZED, não CONFIRMED
    expect(await prisma.contact.count()).toBe(0);
  });

  it('registra falha e notifica o administrador', async () => {
    const imp = await createImport('telefone\n1\n', {
      hasHeader: true,
      columns: { phone: 0 },
      consent: { status: 'PENDING' },
    });
    await proc.fail(imp.id, new Error('arquivo corrompido'));
    expect((await prisma.import.findUniqueOrThrow({ where: { id: imp.id } })).status).toBe(
      'FAILED',
    );
    expect(await prisma.systemNotification.count({ where: { category: 'IMPORT' } })).toBe(1);
  });
});
