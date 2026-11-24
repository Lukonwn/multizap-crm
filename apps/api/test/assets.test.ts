import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import sharp from 'sharp';
import type { PrismaClient } from '@multizap/database';
import type { LocalStorage } from '@multizap/storage';
import {
  authed,
  createAdmin,
  login,
  multipart,
  resetDb,
  setupTestApp,
  type Session,
} from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;
let redis: Redis;
let storage: LocalStorage;
let s: Session;

beforeAll(async () => {
  ({ app, prisma, redis, storage } = await setupTestApp());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await createAdmin(prisma);
  s = await login(app);
});

const png = (w: number, h: number, color = '#10b981') =>
  sharp({ create: { width: w, height: h, channels: 4, background: color } })
    .png()
    .toBuffer();
const upload = (name: string, content: Buffer | string, fields: Record<string, string> = {}) => {
  const m = multipart(name, content, fields);
  return app.inject({
    method: 'POST',
    url: '/assets/upload',
    headers: { ...authed(s), 'content-type': m.contentType },
    payload: m.body,
  });
};
const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: authed(s, method !== 'GET'), payload });

describe('pastas', () => {
  it('cria pastas aninhadas, impede nomes repetidos e ciclos', async () => {
    const root = (await req('POST', '/asset-folders', { name: 'Black Friday' })).json().folder;
    const child = (
      await req('POST', '/asset-folders', { name: 'Banners', parentId: root.id })
    ).json().folder;
    expect((await req('POST', '/asset-folders', { name: 'black friday' })).statusCode).toBe(409);
    expect((await req('POST', '/asset-folders', { name: 'Banners' })).statusCode).toBe(201); // outro nível: permitido
    const cycle = await req('PATCH', `/asset-folders/${root.id}`, { parentId: child.id });
    expect(cycle.json().error.code).toBe('INVALID_PARENT');
    expect(
      (await req('PATCH', `/asset-folders/${child.id}`, { name: 'Banners 2026' })).json().folder
        .name,
    ).toBe('Banners 2026');
    expect((await req('GET', '/asset-folders')).json().items).toHaveLength(3);
  });

  it('não exclui pasta com conteúdo', async () => {
    const f = (await req('POST', '/asset-folders', { name: 'Textos' })).json().folder;
    await req('POST', '/assets', {
      kind: 'TEXT',
      name: 'Saudação',
      folderId: f.id,
      textContent: 'Olá!',
    });
    expect((await req('DELETE', `/asset-folders/${f.id}`)).json().error.code).toBe(
      'FOLDER_NOT_EMPTY',
    );
  });
});

describe('upload de imagens e arquivos', () => {
  it('registra dimensões e metadados, gera miniatura e serve o arquivo', async () => {
    const r = await upload('banner promo.png', await png(1200, 628), { kind: 'BANNER' });
    expect(r.statusCode).toBe(201);
    const a = r.json().asset;
    expect(a).toMatchObject({
      kind: 'BANNER',
      name: 'banner promo',
      mimeType: 'image/png',
      width: 1200,
      height: 628,
      hasThumbnail: true,
      hasFile: true,
    });
    expect(a.sha256).toHaveLength(64);

    const thumb = await req('GET', `/assets/${a.id}/thumbnail`);
    expect(thumb.headers['content-type']).toBe('image/webp');
    const tm = await sharp(thumb.rawPayload).metadata();
    expect(tm.width).toBe(480);

    const file = await req('GET', `/assets/${a.id}/file`);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-disposition']).toMatch(/^inline/);
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(
      (await req('GET', `/assets/${a.id}/file?download=1`)).headers['content-disposition'],
    ).toMatch(/^attachment/);
  });

  it('identifica o tipo pelo conteúdo, não pela extensão', async () => {
    const fake = await upload('foto.png', Buffer.from('MZ\x90\x00 executável disfarçado'), {
      kind: 'IMAGE',
    });
    expect(fake.statusCode).toBe(415);
    const svg = await upload(
      'logo.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      { kind: 'IMAGE' },
    );
    expect(svg.statusCode).toBe(415);
    // PDF com extensão errada é aceito como PDF
    const pdf = await upload('catalogo.png', Buffer.from('%PDF-1.4\n%fake minimal'), {
      kind: 'FILE',
    });
    expect(pdf.json().asset).toMatchObject({
      kind: 'FILE',
      mimeType: 'application/pdf',
      hasThumbnail: false,
    });
    // PDF enviado como "imagem" é recusado
    expect(
      (await upload('x.pdf', Buffer.from('%PDF-1.4\n'), { kind: 'IMAGE' })).json().error.code,
    ).toBe('NOT_AN_IMAGE');
  });

  it('recusa imagem corrompida e arquivo duplicado', async () => {
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('lixo'),
    ]);
    expect((await upload('quebrada.png', broken, { kind: 'IMAGE' })).json().error.code).toBe(
      'INVALID_IMAGE',
    );
    const img = await png(10, 10);
    await upload('a.png', img);
    const dup = await upload('b.png', img);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('DUPLICATE_ASSET');
  });

  it('armazena na pasta informada', async () => {
    const f = (await req('POST', '/asset-folders', { name: 'Logos' })).json().folder;
    const a = (
      await upload('logo.png', await png(64, 64), { kind: 'IMAGE', folderId: f.id })
    ).json().asset;
    expect(a.folderId).toBe(f.id);
    expect((await req('GET', `/assets?folder=${f.id}`)).json().total).toBe(1);
    expect((await req('GET', '/assets?folder=root')).json().total).toBe(0);
  });
});

describe('textos, links e modelos', () => {
  it('valida links e variáveis dos modelos', async () => {
    expect(
      (await req('POST', '/assets', { kind: 'LINK', name: 'Site', url: 'javascript:alert(1)' }))
        .statusCode,
    ).toBe(400);
    const link = await req('POST', '/assets', {
      kind: 'LINK',
      name: 'Loja',
      url: 'https://loja.example.com/promo',
      description: 'Página da promoção',
    });
    expect(link.json().asset).toMatchObject({
      kind: 'LINK',
      url: 'https://loja.example.com/promo',
      description: 'Página da promoção',
    });

    const bad = await req('POST', '/assets', {
      kind: 'TEMPLATE',
      name: 'Promo',
      textContent: 'Oi {{nome}}, seu {{cupom}}',
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json().error.fields)).toContain('{{cupom}}');
    const ok = await req('POST', '/assets', {
      kind: 'TEMPLATE',
      name: 'Promo',
      textContent: 'Oi {{ primeiro_nome }}! Confira: {{nome}}',
    });
    expect(ok.json().asset.variables).toEqual(['primeiro_nome', 'nome']);
  });

  it('limita o texto ao tamanho de uma mensagem do WhatsApp', async () => {
    const r = await req('POST', '/assets', {
      kind: 'TEXT',
      name: 'Longo',
      textContent: 'a'.repeat(4097),
    });
    expect(r.statusCode).toBe(400);
  });

  it('edita conteúdo revalidando conforme o tipo e move entre pastas', async () => {
    const t = (
      await req('POST', '/assets', { kind: 'TEMPLATE', name: 'M', textContent: 'Olá {{nome}}' })
    ).json().asset;
    expect((await req('PATCH', `/assets/${t.id}`, { textContent: 'Olá {{x}}' })).statusCode).toBe(
      400,
    );
    const f = (await req('POST', '/asset-folders', { name: 'Modelos' })).json().folder;
    const r = await req('PATCH', `/assets/${t.id}`, {
      name: 'Boas-vindas',
      textContent: 'Bem-vindo, {{primeiro_nome}}!',
      folderId: f.id,
    });
    expect(r.json().asset).toMatchObject({
      name: 'Boas-vindas',
      folderId: f.id,
      variables: ['primeiro_nome'],
    });
    expect((await req('PATCH', `/assets/${t.id}`, { url: 'https://x.com' })).statusCode).toBe(400);
    expect(
      (await req('PATCH', `/assets/${t.id}`, { folderId: null })).json().asset.folderId,
    ).toBeNull();
  });
});

describe('pesquisa, histórico e exclusão', () => {
  it('pesquisa por nome e conteúdo e filtra por tipo', async () => {
    await req('POST', '/assets', {
      kind: 'TEXT',
      name: 'Saudação',
      textContent: 'Olá, aproveite a liquidação!',
    });
    await req('POST', '/assets', {
      kind: 'LINK',
      name: 'Catálogo',
      url: 'https://example.com/liquidacao',
    });
    await upload('verao.png', await png(20, 20), { kind: 'IMAGE' });
    expect((await req('GET', '/assets?q=liquida')).json().total).toBe(2);
    expect(
      (await req('GET', '/assets?kind=IMAGE')).json().items.map((a: { name: string }) => a.name),
    ).toEqual(['verao']);
  });

  it('mostra o histórico de uso e impede excluir criativo em campanha ativa', async () => {
    const a = (await upload('promo.png', await png(30, 30), { kind: 'IMAGE' })).json().asset;
    const c = await prisma.campaign.create({
      data: { name: 'Natal', status: 'SCHEDULED', assetId: a.id },
    });
    await prisma.assetUsage.create({ data: { assetId: a.id, campaignId: c.id } });
    const d = (await req('GET', `/assets/${a.id}`)).json();
    expect(d.asset.usageCount).toBe(1);
    expect(d.usages).toEqual([
      expect.objectContaining({ campaignName: 'Natal', campaignStatus: 'SCHEDULED' }),
    ]);
    expect((await req('DELETE', `/assets/${a.id}`)).json().error.code).toBe('ASSET_IN_USE');

    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'COMPLETED' } });
    const key = (await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).storageKey!;
    expect(await storage.exists(key)).toBe(true);
    expect((await req('DELETE', `/assets/${a.id}`)).statusCode).toBe(200);
    expect(await storage.exists(key)).toBe(false); // arquivo removido do armazenamento
  });
});
