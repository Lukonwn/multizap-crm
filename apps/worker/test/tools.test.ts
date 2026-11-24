import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, type PrismaClient } from '@multizap/database';
import { LocalStorage, streamToBuffer } from '@multizap/storage';
import { ToolJobProcessor, type StoredToolInput } from '../src/tools/processor';

const prisma: PrismaClient = createPrisma(process.env.TEST_DATABASE_URL!);
let dir: string;
let storage: LocalStorage;
let proc: ToolJobProcessor;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mz-tools-'));
  storage = new LocalStorage(dir);
  proc = new ToolJobProcessor(prisma, storage);
});
afterAll(async () => {
  await prisma.$disconnect();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await prisma.fileJob.deleteMany();
  await prisma.systemNotification.deleteMany();
});

async function job(tool: string, content: string, params: object = {}) {
  const id = crypto.randomUUID();
  const key = `tools/uploads/${id}.csv`;
  await storage.put(key, Buffer.from(content));
  const input: StoredToolInput = {
    key,
    name: 'Clientes.csv',
    format: 'csv',
    encoding: 'utf8',
    delimiter: ';',
    size: content.length,
  };
  return prisma.fileJob.create({ data: { id, tool, params, inputKeys: [input] as object[] } });
}

const LIST = 'nome;telefone\nA;11987654321\nB;21998765432\nC;11912345678\nD;abc\n';

describe('ToolJobProcessor', () => {
  it('executa a ferramenta, envia as saídas ao armazenamento e registra o resumo', async () => {
    const j = await job('sanitize', LIST);
    await proc.run(j.id);
    const done = await prisma.fileJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(done).toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect(done.summary).toMatchObject({ total: 4, valid: 3, empty: 1 });
    const outputs = done.outputKeys as { key: string; name: string; rows: number }[];
    expect(outputs.map((o) => o.name)).toEqual([
      'Clientes-higienizado.csv',
      'Clientes-validos.csv',
      'Clientes-rejeitados.csv',
    ]);
    const text = (await streamToBuffer(await storage.get(outputs[1]!.key))).toString('utf8');
    expect(text).toContain('+5511987654321');
    expect(outputs[1]!.rows).toBe(4); // cabeçalho + 3
  });

  it('entrega várias saídas também em um ZIP', async () => {
    const j = await job('group-ddd', LIST);
    await proc.run(j.id);
    const outputs = (await prisma.fileJob.findUniqueOrThrow({ where: { id: j.id } }))
      .outputKeys as { key: string; name: string }[];
    expect(outputs[0]!.name).toBe('Clientes-group-ddd.zip');
    const zip = await streamToBuffer(await storage.get(outputs[0]!.key));
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    expect(outputs.map((o) => o.name)).toEqual(
      expect.arrayContaining(['ddd-11-SP.csv', 'ddd-21-RJ.csv', 'sem-telefone-valido.csv']),
    );
  });

  it('parâmetros inválidos levam a falha registrada e notificação', async () => {
    const j = await job('split', LIST, { mode: 'parts', size: 999999 });
    await expect(proc.run(j.id)).rejects.toThrow();
    await proc.fail(j.id, new Error('parâmetros inválidos'));
    expect((await prisma.fileJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe('FAILED');
    expect(await prisma.systemNotification.count({ where: { category: 'PROCESSING' } })).toBe(1);
  });

  it('não reprocessa um job já concluído', async () => {
    const j = await job('remove-empty', LIST);
    await proc.run(j.id);
    const first = await prisma.fileJob.findUniqueOrThrow({ where: { id: j.id } });
    await proc.run(j.id);
    const second = await prisma.fileJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(second.finishedAt).toEqual(first.finishedAt);
  });
});
