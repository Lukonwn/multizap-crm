import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma, searchKnowledge, type PrismaClient } from '@multizap/database';
import { buildSearchQuery } from '@multizap/ai';
import { LocalStorage } from '@multizap/storage';
import { extractText } from '../src/ai/knowledge/extract';
import { fetchPage, htmlToText, isPrivateAddress } from '../src/ai/knowledge/safe-fetch';
import { KnowledgeProcessor } from '../src/ai/knowledge/processor';

const prisma: PrismaClient = createPrisma(process.env.TEST_DATABASE_URL!);
afterAll(() => prisma.$disconnect());

const truncateAll = async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
};

function makePdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const body = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'trailer<</Root 1 0 R/Size 6>>',
    '%%EOF',
  ].join('\n');
  return Buffer.from(body, 'latin1');
}

async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
      .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
      .join('')}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('endereços internos são recusados', () => {
  it('classifica IPv4 e IPv6', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('recusa literais, nomes que resolvem para endereço interno, portas e protocolos indevidos', async () => {
    await expect(fetchPage('http://127.0.0.1/')).rejects.toThrow(/não pode ser acessado/);
    await expect(fetchPage('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /não pode ser acessado/,
    );
    await expect(fetchPage('http://[::1]/')).rejects.toThrow(/não pode ser acessado/);
    // formas alternativas de escrever o mesmo endereço interno
    for (const u of [
      'http://2130706433/', // 127.0.0.1 em decimal
      'http://0x7f.0.0.1/', // hexadecimal
      'http://0177.0.0.1/', // octal
      'http://127.1/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://0.0.0.0/',
    ])
      await expect(fetchPage(u), u).rejects.toThrow(/não pode ser acessado/);
    await expect(
      fetchPage('https://exemplo.test/', {
        lookup: (_h, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]),
      }),
    ).rejects.toThrow(/não pode ser acessado/);
    // um endereço público junto com um interno também é recusado (rebinding)
    await expect(
      fetchPage('https://exemplo.test/', {
        lookup: (_h, cb) =>
          cb(null, [
            { address: '8.8.8.8', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ]),
      }),
    ).rejects.toThrow(/não pode ser acessado/);
    await expect(fetchPage('ftp://exemplo.test/x')).rejects.toThrow(/http e https/);
    await expect(fetchPage('http://exemplo.test:8080/')).rejects.toThrow(/portas 80 e 443/);
    await expect(fetchPage('http://user:pw@exemplo.test/')).rejects.toThrow(/usuário e senha/);
    await expect(fetchPage('isto não é um link')).rejects.toThrow(/inválido/);
  });
});

describe('busca de páginas (servidor local de teste)', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const send = (status: number, type: string, body: string | Buffer, h: object = {}) => {
        res.writeHead(status, { 'content-type': type, ...h });
        res.end(body);
      };
      if (req.url === '/ok')
        return send(
          200,
          'text/html; charset=utf-8',
          '<html><head><title>Loja &amp; Café</title><script>var x=1</script></head><body><nav>Menu</nav><h1>Frete</h1><p>Entrega em até 3 dias &uacute;teis.</p><ul><li>PAC</li><li>Sedex</li></ul></body></html>',
        );
      if (req.url === '/redir') return send(302, 'text/plain', '', { location: '/ok' });
      if (req.url === '/evil')
        return send(302, 'text/plain', '', { location: 'http://169.254.169.254/' });
      if (req.url === '/loop') return send(302, 'text/plain', '', { location: '/loop' });
      if (req.url === '/pdf') return send(200, 'application/pdf', 'x');
      if (req.url === '/big') return send(200, 'text/plain', 'a'.repeat(3 * 1024 * 1024));
      if (req.url === '/404') return send(404, 'text/plain', 'x');
      send(200, 'text/plain', 'texto simples');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const get = (path: string) => fetchPage(base + path, { allowHosts: ['127.0.0.1'] });

  it('extrai título e texto visível, sem scripts nem menus', async () => {
    const p = await get('/ok');
    expect(p.title).toBe('Loja & Café');
    expect(p.text).toContain('Entrega em até 3 dias úteis.');
    expect(p.text).toContain('- PAC');
    expect(p.text).not.toMatch(/var x|Menu/);
  });

  it('segue redirecionamentos, mas não para dentro da rede interna e nem em laço', async () => {
    expect((await get('/redir')).text).toContain('Frete');
    // o servidor de teste é liberado, mas o redirecionamento para metadados de nuvem não
    await expect(get('/evil')).rejects.toThrow(/não pode ser acessado/);
    await expect(get('/loop')).rejects.toThrow(/Redirecionamentos demais/);
  });

  it('recusa tipos não textuais, páginas grandes e erros HTTP', async () => {
    await expect(get('/pdf')).rejects.toThrow(/não é uma página de texto/);
    await expect(get('/big')).rejects.toThrow(/grande demais/);
    await expect(get('/404')).rejects.toThrow(/erro 404/);
    expect((await get('/txt')).text).toBe('texto simples');
  });

  it('htmlToText decodifica entidades numéricas e nomeadas', () => {
    expect(htmlToText('<p>a&#233;b &#x41; &copy;</p>').text.trim()).toBe('aéb A &copy;');
  });
});

describe('leitura de arquivos', () => {
  it('lê TXT, DOCX e PDF', async () => {
    expect(await extractText(Buffer.from('Linha 1\n\n\n\nLinha 2'), 'a.txt')).toBe(
      'Linha 1\n\nLinha 2',
    );
    expect(
      await extractText(await makeDocx(['Primeiro parágrafo', 'Segundo']), 'a.docx'),
    ).toContain('Segundo');
    expect(await extractText(makePdf('Politica de troca em 7 dias'), 'a.pdf')).toContain(
      'Politica de troca em 7 dias',
    );
  });

  it('erros claros: formato, arquivo corrompido, vazio', async () => {
    await expect(extractText(Buffer.from('x'), 'a.exe')).rejects.toThrow(/Formato não suportado/);
    await expect(extractText(randomBytes(200), 'a.pdf')).rejects.toThrow(/Não foi possível ler/);
    await expect(extractText(randomBytes(200), 'a.docx')).rejects.toThrow(/Não foi possível ler/);
    await expect(extractText(Buffer.from('   \n '), 'a.txt')).rejects.toThrow(/não tem texto/);
  });
});

describe('processamento das fontes e busca', () => {
  let storage: LocalStorage;
  let processor: KnowledgeProcessor;
  beforeEach(async () => {
    await truncateAll();
    storage = new LocalStorage(mkdtempSync(join(tmpdir(), 'mz-kb-')));
    processor = new KnowledgeProcessor(prisma, storage, undefined, { allowHosts: ['127.0.0.1'] });
  });

  const agent = async () => {
    const persona = await prisma.aiPersona.create({ data: { name: 'Marina' } });
    return prisma.aiAgent.create({
      data: { name: 'A', personaId: persona.id, model: 'm/x-model' },
    });
  };
  const link = (agentId: string, sourceId: string) =>
    prisma.aiAgentKnowledge.create({ data: { agentId, sourceId } });
  const search = (agentId: string, q: string) =>
    searchKnowledge(prisma, agentId, buildSearchQuery(q));

  it('texto: divide em trechos e fica pronto', async () => {
    const s = await prisma.aiKnowledgeSource.create({
      data: {
        name: 'Políticas',
        kind: 'TEXT',
        content:
          'Trocas\nAceitamos trocas em até 7 dias.\n\n' +
          'Frete grátis acima de R$ 200. '.repeat(60),
      },
    });
    await processor.process(s.id);
    const after = await prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: s.id } });
    expect(after).toMatchObject({ status: 'READY', error: null });
    expect(after.chunkCount).toBeGreaterThan(1);
    expect(await prisma.aiKnowledgeChunk.count({ where: { sourceId: s.id } })).toBe(
      after.chunkCount,
    );
    // reprocessar não duplica
    await processor.process(s.id);
    expect(await prisma.aiKnowledgeChunk.count({ where: { sourceId: s.id } })).toBe(
      after.chunkCount,
    );
  });

  it('pergunta e resposta viram um trecho; a busca acha por palavras da pergunta ou da resposta', async () => {
    const a = await agent();
    const s = await prisma.aiKnowledgeSource.create({
      data: {
        name: 'Prazo de entrega',
        kind: 'QA',
        question: 'Qual o prazo de entrega para São Paulo?',
        content: 'Entregamos em São Paulo em até 2 dias úteis.',
      },
    });
    await processor.process(s.id);
    await link(a.id, s.id);
    const byQuestion = await search(a.id, 'quanto tempo leva a entrega?');
    expect(byQuestion).toHaveLength(1);
    expect(byQuestion[0]).toMatchObject({ sourceName: 'Prazo de entrega' });
    expect(byQuestion[0]!.content).toContain('Resposta: Entregamos em São Paulo');
    expect(await search(a.id, 'vocês aceitam pix?')).toEqual([]);
  });

  it('busca em português: plural, acentos e ranking pelo trecho mais relevante', async () => {
    const a = await agent();
    const s1 = await prisma.aiKnowledgeSource.create({
      data: {
        name: 'Cafés',
        kind: 'TEXT',
        content: 'Vendemos cafés especiais torrados na semana. O café Bourbon é doce.',
      },
    });
    const s2 = await prisma.aiKnowledgeSource.create({
      data: { name: 'Envio', kind: 'TEXT', content: 'Enviamos para todo o Brasil pelos Correios.' },
    });
    for (const s of [s1, s2]) {
      await processor.process(s.id);
      await link(a.id, s.id);
    }
    const hits = await search(a.id, 'Tem café bourbon?');
    expect(hits[0]!.sourceName).toBe('Cafés');
    expect((await search(a.id, 'cafés'))[0]!.sourceName).toBe('Cafés'); // plural encontra singular
    expect((await search(a.id, 'enviar'))[0]!.sourceName).toBe('Envio'); // radical do verbo
    expect(await search(a.id, 'de o a')).toEqual([]);
  });

  it('só entram fontes ligadas ao agente, prontas e habilitadas', async () => {
    const a = await agent();
    const b = await agent();
    const mk = async (name: string, over: object = {}) => {
      const s = await prisma.aiKnowledgeSource.create({
        data: {
          name,
          kind: 'TEXT',
          content: 'Garantia de um ano para todos os produtos.',
          ...over,
        },
      });
      await processor.process(s.id);
      return s;
    };
    const ok = await mk('Ok');
    const off = await mk('Desligada');
    await prisma.aiKnowledgeSource.update({ where: { id: off.id }, data: { enabled: false } });
    const notLinked = await mk('Sem vínculo');
    const broken = await mk('Quebrada');
    await prisma.aiKnowledgeSource.update({ where: { id: broken.id }, data: { status: 'ERROR' } });
    for (const s of [ok, off, broken]) await link(a.id, s.id);
    await link(b.id, notLinked.id);
    const names = (await search(a.id, 'garantia')).map((h) => h.sourceName);
    expect(names).toEqual(['Ok']);
    expect((await search(b.id, 'garantia')).map((h) => h.sourceName)).toEqual(['Sem vínculo']);
  });

  it('a consulta não aceita sintaxe fora do formato (nada de injeção)', async () => {
    const a = await agent();
    expect(await searchKnowledge(prisma, a.id, "x'; DROP TABLE ai_agents; --")).toEqual([]);
    expect(await searchKnowledge(prisma, a.id, 'a & b | !c')).toEqual([]);
    expect(await prisma.aiAgent.count()).toBe(1);
  });

  it('arquivo: lê do bucket; arquivo ruim vira erro claro e não deixa trechos', async () => {
    await storage.put('ai/knowledge/ok.pdf', makePdf('Horario de atendimento das 9h as 18h'));
    await storage.put('ai/knowledge/bad.pdf', randomBytes(300));
    const ok = await prisma.aiKnowledgeSource.create({
      data: {
        name: 'Horários',
        kind: 'FILE',
        storageKey: 'ai/knowledge/ok.pdf',
        fileName: 'h.pdf',
      },
    });
    const bad = await prisma.aiKnowledgeSource.create({
      data: { name: 'Ruim', kind: 'FILE', storageKey: 'ai/knowledge/bad.pdf', fileName: 'r.pdf' },
    });
    await processor.process(ok.id);
    await processor.process(bad.id);
    expect(
      await prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: ok.id } }),
    ).toMatchObject({
      status: 'READY',
      chunkCount: 1,
    });
    const b = await prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: bad.id } });
    expect(b.status).toBe('ERROR');
    expect(b.error).toMatch(/Não foi possível ler/);
    expect(await prisma.aiKnowledgeChunk.count({ where: { sourceId: bad.id } })).toBe(0);
    expect(await prisma.systemEvent.count({ where: { type: 'ai_knowledge_failed' } })).toBe(1);
  });

  it('link: usa o título da página como nome quando o nome era o próprio endereço, e recusa endereço interno', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Sobre nós</title><p>Somos uma loja de cafés especiais fundada em 2015.</p>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sobre`;
    const s = await prisma.aiKnowledgeSource.create({ data: { name: url, kind: 'LINK', url } });
    await processor.process(s.id);
    server.close();
    expect(await prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject(
      {
        status: 'READY',
        name: 'Sobre nós',
      },
    );

    const strict = new KnowledgeProcessor(prisma, storage); // sem liberações
    const internal = await prisma.aiKnowledgeSource.create({
      data: { name: 'Interno', kind: 'LINK', url: 'http://169.254.169.254/latest/meta-data' },
    });
    await strict.process(internal.id);
    expect(
      await prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: internal.id } }),
    ).toMatchObject({
      status: 'ERROR',
      error: 'Esse endereço não pode ser acessado.',
    });
  });

  it('só um processamento por vez para a mesma fonte', async () => {
    const s = await prisma.aiKnowledgeSource.create({
      data: {
        name: 'T',
        kind: 'TEXT',
        content: 'Conteúdo qualquer da fonte.',
        status: 'PROCESSING',
      },
    });
    await processor.process(s.id);
    expect((await prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'PROCESSING',
    );
    expect(await prisma.aiKnowledgeChunk.count()).toBe(0);
  });

  it('retoma uma fonte presa em "processando" por mais de 10 minutos (worker que caiu)', async () => {
    const s = await prisma.aiKnowledgeSource.create({
      data: {
        name: 'T',
        kind: 'TEXT',
        content: 'Conteúdo qualquer da fonte para retomar.',
        status: 'PROCESSING',
      },
    });
    await prisma.$executeRaw`UPDATE ai_knowledge_sources SET updated_at = now() - interval '20 minutes' WHERE id = ${s.id}::uuid`;
    await processor.process(s.id);
    expect((await prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
      'READY',
    );
  });
});
