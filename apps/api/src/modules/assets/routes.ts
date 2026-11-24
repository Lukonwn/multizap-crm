import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import type { Asset, Prisma } from '@multizap/database';
import {
  ALLOWED_MIME,
  FILE_ASSET_KINDS,
  assetListQuerySchema,
  assetUrlSchema,
  contentSchemaFor,
  createContentAssetSchema,
  extractVariables,
  folderSchema,
  updateAssetSchema,
  type AssetDTO,
  type AssetFolderDTO,
  type AssetKindValue,
  type AssetUsageDTO,
} from '@multizap/shared';
import { AppError, Errors } from '../../lib/errors';
import { sniffMime } from '../../lib/mime';
import { parse } from '../../lib/validate';
import { audit } from '../audit/service';

const idParams = z.object({ id: z.string().uuid('Identificador inválido.') });
const MAX_IMAGE_PIXELS = 50_000_000;

interface AssetMeta {
  description?: string | null;
  format?: string;
  hasAlpha?: boolean;
  thumbnailKey?: string;
  originalName?: string;
}

function toAssetDTO(a: Asset & { _count?: { usages: number } }): AssetDTO {
  const meta = (a.metadata ?? {}) as AssetMeta;
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    folderId: a.folderId,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes === null ? null : Number(a.sizeBytes),
    width: a.width,
    height: a.height,
    sha256: a.sha256,
    textContent: a.textContent,
    url: a.url,
    description: meta.description ?? null,
    variables: a.kind === 'TEMPLATE' && a.textContent ? extractVariables(a.textContent) : [],
    hasFile: !!a.storageKey,
    hasThumbnail: !!meta.thumbnailKey,
    usageCount: a._count?.usages ?? 0,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function assetRoutes(app: FastifyInstance) {
  const { prisma } = app;
  const auth = { preHandler: app.requireAuth };
  const withCount = { _count: { select: { usages: true } } } as const;

  const storage = () => {
    if (!app.storage)
      throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Armazenamento de arquivos não configurado.');
    return app.storage;
  };

  const assertFolder = async (folderId: string | null | undefined) => {
    if (!folderId) return;
    if (!(await prisma.assetFolder.findUnique({ where: { id: folderId } }))) {
      throw new AppError(400, 'INVALID_FOLDER', 'Pasta não encontrada.');
    }
  };

  const loadAsset = async (id: string) => {
    const asset = await prisma.asset.findUnique({ where: { id }, include: withCount });
    if (!asset) throw Errors.notFound('Criativo não encontrado.');
    return asset;
  };

  // ─── Pastas ───────────────────────────────────────────────────────────────

  app.get('/asset-folders', auth, async () => {
    const folders = await prisma.assetFolder.findMany({
      include: { _count: { select: { assets: true } } },
      orderBy: { name: 'asc' },
    });
    const items: AssetFolderDTO[] = folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      assetCount: f._count.assets,
      createdAt: f.createdAt.toISOString(),
    }));
    return { items };
  });

  const assertUniqueName = async (name: string, parentId: string | null, exceptId?: string) => {
    const dup = await prisma.assetFolder.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        parentId,
        ...(exceptId && { id: { not: exceptId } }),
      },
    });
    if (dup)
      throw new AppError(409, 'FOLDER_EXISTS', 'Já existe uma pasta com esse nome neste local.');
  };

  app.post('/asset-folders', auth, async (req, reply) => {
    const input = parse(folderSchema, req.body);
    await assertFolder(input.parentId);
    await assertUniqueName(input.name, input.parentId ?? null);
    const f = await prisma.assetFolder.create({
      data: { name: input.name, parentId: input.parentId ?? null },
    });
    reply.code(201);
    return {
      folder: {
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        assetCount: 0,
        createdAt: f.createdAt.toISOString(),
      },
    };
  });

  app.patch('/asset-folders/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const input = parse(folderSchema.partial(), req.body);
    const folder = await prisma.assetFolder.findUnique({ where: { id } });
    if (!folder) throw Errors.notFound('Pasta não encontrada.');
    const parentId = input.parentId === undefined ? folder.parentId : input.parentId;
    if (input.parentId) {
      await assertFolder(input.parentId);
      // Impede mover a pasta para dentro dela mesma ou de uma subpasta.
      let cursor: string | null = input.parentId;
      while (cursor) {
        if (cursor === id)
          throw new AppError(400, 'INVALID_PARENT', 'Uma pasta não pode ficar dentro dela mesma.');
        cursor =
          (
            await prisma.assetFolder.findUnique({
              where: { id: cursor },
              select: { parentId: true },
            })
          )?.parentId ?? null;
      }
    }
    await assertUniqueName(input.name ?? folder.name, parentId, id);
    const f = await prisma.assetFolder.update({
      where: { id },
      data: { name: input.name, parentId },
    });
    return { folder: { id: f.id, name: f.name, parentId: f.parentId } };
  });

  app.delete('/asset-folders/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const folder = await prisma.assetFolder.findUnique({
      where: { id },
      include: { _count: { select: { assets: true, children: true } } },
    });
    if (!folder) throw Errors.notFound('Pasta não encontrada.');
    if (folder._count.assets || folder._count.children) {
      throw new AppError(
        409,
        'FOLDER_NOT_EMPTY',
        'A pasta não está vazia. Mova ou exclua o conteúdo antes.',
      );
    }
    await prisma.assetFolder.delete({ where: { id } });
    return { ok: true };
  });

  // ─── Criativos ────────────────────────────────────────────────────────────

  app.get('/assets', auth, async (req) => {
    const q = parse(assetListQuerySchema, req.query);
    const where: Prisma.AssetWhereInput = {};
    if (q.folder === 'root') where.folderId = null;
    else if (q.folder) where.folderId = q.folder;
    if (q.kind) where.kind = q.kind;
    if (q.q) {
      where.OR = [
        { name: { contains: q.q, mode: 'insensitive' } },
        { textContent: { contains: q.q, mode: 'insensitive' } },
        { url: { contains: q.q, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        include: withCount,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.asset.count({ where }),
    ]);
    return { items: items.map(toAssetDTO), total, page: q.page, pageSize: q.pageSize };
  });

  /** Upload de imagem, banner ou arquivo. Tipo validado pelo conteúdo. */
  app.post('/assets/upload', auth, async (req, reply) => {
    const store = storage();
    const file = await req
      .file({ limits: { fileSize: app.config.maxAssetBytes } })
      .catch(() => undefined);
    if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Selecione um arquivo.');
    const fields = Object.fromEntries(
      Object.entries(file.fields).map(([k, v]) => [
        k,
        v && 'value' in v ? String(v.value) : undefined,
      ]),
    );
    const { kind, folderId, name } = parse(
      z.object({
        kind: z.enum(FILE_ASSET_KINDS).default('FILE'),
        folderId: z
          .string()
          .uuid()
          .optional()
          .or(z.literal('').transform(() => undefined)),
        name: z.string().trim().max(120).optional(),
      }),
      fields,
    );
    const buf = await file.toBuffer().catch(() => {
      throw new AppError(
        413,
        'FILE_TOO_LARGE',
        `Arquivo maior que o limite de ${Math.round(app.config.maxAssetBytes / 1024 / 1024)} MB.`,
      );
    });
    if (!buf.length) throw new AppError(400, 'EMPTY_FILE', 'O arquivo está vazio.');
    await assertFolder(folderId);

    const mime = sniffMime(buf);
    const allowed = mime ? ALLOWED_MIME[mime] : undefined;
    if (!mime || !allowed) {
      throw new AppError(
        415,
        'UNSUPPORTED_TYPE',
        'Tipo de arquivo não suportado. Envie JPEG, PNG, WebP, GIF, MP4, MP3, OGG ou PDF.',
      );
    }
    if ((kind === 'IMAGE' || kind === 'BANNER') && !allowed.image) {
      throw new AppError(
        415,
        'NOT_AN_IMAGE',
        'Para imagens e banners envie JPEG, PNG, WebP ou GIF.',
      );
    }

    const sha256 = createHash('sha256').update(buf).digest('hex');
    const existing = await prisma.asset.findFirst({
      where: { sha256 },
      select: { id: true, name: true },
    });
    if (existing) {
      throw new AppError(
        409,
        'DUPLICATE_ASSET',
        `Este arquivo já está na biblioteca como "${existing.name}".`,
        { assetId: [existing.id] },
      );
    }

    const id = randomUUID();
    const meta: AssetMeta = { originalName: file.filename.slice(0, 200) };
    let width: number | null = null;
    let height: number | null = null;
    let thumb: Buffer | null = null;
    if (allowed.image) {
      try {
        // Decodificar a imagem também confirma que ela é válida.
        const img = sharp(buf, {
          limitInputPixels: MAX_IMAGE_PIXELS,
          animated: mime === 'image/gif',
        });
        const m = await img.metadata();
        width = m.width ?? null;
        height = m.pageHeight ?? m.height ?? null;
        meta.format = m.format;
        meta.hasAlpha = m.hasAlpha;
        thumb = await sharp(buf, { limitInputPixels: MAX_IMAGE_PIXELS })
          .rotate()
          .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 78 })
          .toBuffer();
        if (m.orientation && m.orientation >= 5) [width, height] = [height, width];
      } catch {
        throw new AppError(415, 'INVALID_IMAGE', 'A imagem está corrompida ou não pôde ser lida.');
      }
    }

    const storageKey = `assets/${id}/original.${allowed.ext}`;
    await store.put(storageKey, buf, { contentType: mime });
    if (thumb) {
      meta.thumbnailKey = `assets/${id}/thumb.webp`;
      await store.put(meta.thumbnailKey, thumb, { contentType: 'image/webp' });
    }
    const asset = await prisma.asset.create({
      data: {
        id,
        kind: allowed.image ? kind : 'FILE',
        name: name || file.filename.replace(/\.[^.]+$/, '').slice(0, 120) || 'Arquivo',
        folderId: folderId ?? null,
        storageKey,
        mimeType: mime,
        sizeBytes: BigInt(buf.length),
        width,
        height,
        sha256,
        metadata: meta as object,
      },
      include: withCount,
    });
    await audit(prisma, req, {
      action: 'asset.uploaded',
      actorId: req.auth!.user.id,
      entityType: 'asset',
      entityId: id,
      details: { name: asset.name, mime },
    });
    reply.code(201);
    return { asset: toAssetDTO(asset) };
  });

  /** Texto, link ou modelo de mensagem. */
  app.post('/assets', auth, async (req, reply) => {
    const input = parse(createContentAssetSchema, req.body);
    await assertFolder(input.folderId);
    const asset = await prisma.asset.create({
      data: {
        kind: input.kind,
        name: input.name,
        folderId: input.folderId ?? null,
        textContent: input.kind === 'LINK' ? null : input.textContent,
        url: input.kind === 'LINK' ? input.url : null,
        metadata: input.kind === 'LINK' ? { description: input.description ?? null } : {},
      },
      include: withCount,
    });
    await audit(prisma, req, {
      action: 'asset.created',
      actorId: req.auth!.user.id,
      entityType: 'asset',
      entityId: asset.id,
      details: { name: asset.name, kind: asset.kind },
    });
    reply.code(201);
    return { asset: toAssetDTO(asset) };
  });

  app.get('/assets/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const asset = await loadAsset(id);
    const usages = await prisma.assetUsage.findMany({
      where: { assetId: id },
      include: { campaign: { select: { name: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const items: AssetUsageDTO[] = usages.map((u) => ({
      id: u.id,
      campaignId: u.campaignId,
      campaignName: u.campaign.name,
      campaignStatus: u.campaign.status,
      createdAt: u.createdAt.toISOString(),
    }));
    return { asset: toAssetDTO(asset), usages: items };
  });

  app.patch('/assets/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const asset = await loadAsset(id);
    const input = parse(updateAssetSchema, req.body);
    if (input.folderId !== undefined) await assertFolder(input.folderId);
    const data: Prisma.AssetUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.folderId !== undefined)
      data.folder = input.folderId ? { connect: { id: input.folderId } } : { disconnect: true };
    if (input.textContent !== undefined) {
      const schema = contentSchemaFor(asset.kind as AssetKindValue);
      if (!schema)
        throw new AppError(400, 'VALIDATION_ERROR', 'Este tipo de criativo não possui texto.');
      data.textContent = parse(z.object({ textContent: schema }), {
        textContent: input.textContent,
      }).textContent;
    }
    if (input.url !== undefined || input.description !== undefined) {
      if (asset.kind !== 'LINK')
        throw new AppError(400, 'VALIDATION_ERROR', 'Somente links possuem endereço e descrição.');
      if (input.url !== undefined)
        data.url = parse(z.object({ url: assetUrlSchema }), { url: input.url }).url;
      if (input.description !== undefined)
        data.metadata = { ...((asset.metadata ?? {}) as object), description: input.description };
    }
    const updated = await prisma.asset.update({ where: { id }, data, include: withCount });
    await audit(prisma, req, {
      action: 'asset.updated',
      actorId: req.auth!.user.id,
      entityType: 'asset',
      entityId: id,
    });
    return { asset: toAssetDTO(updated) };
  });

  app.delete('/assets/:id', auth, async (req) => {
    const { id } = parse(idParams, req.params);
    const asset = await loadAsset(id);
    const active = await prisma.campaign.count({
      where: {
        usages: { some: { assetId: id } },
        status: { in: ['SCHEDULED', 'READY', 'RUNNING', 'PAUSED'] },
      },
    });
    if (active)
      throw new AppError(
        409,
        'ASSET_IN_USE',
        'O criativo está em uso por uma campanha ativa ou agendada.',
      );
    await prisma.asset.delete({ where: { id } });
    const meta = (asset.metadata ?? {}) as AssetMeta;
    for (const key of [asset.storageKey, meta.thumbnailKey])
      if (key && app.storage) await app.storage.delete(key).catch(() => undefined);
    await audit(prisma, req, {
      action: 'asset.deleted',
      actorId: req.auth!.user.id,
      entityType: 'asset',
      entityId: id,
      details: { name: asset.name },
    });
    return { ok: true };
  });

  const serve = (kind: 'file' | 'thumbnail') =>
    app.get(`/assets/:id/${kind}`, auth, async (req, reply) => {
      const { id } = parse(idParams, req.params);
      const asset = await loadAsset(id);
      const meta = (asset.metadata ?? {}) as AssetMeta;
      const key = kind === 'file' ? asset.storageKey : meta.thumbnailKey;
      if (!key) throw Errors.notFound('Arquivo não disponível.');
      const contentType =
        kind === 'file' ? (asset.mimeType ?? 'application/octet-stream') : 'image/webp';
      const inline =
        contentType.startsWith('image/') ||
        contentType.startsWith('video/') ||
        contentType.startsWith('audio/');
      const download = (req.query as { download?: string }).download === '1';
      const ext = ALLOWED_MIME[asset.mimeType ?? '']?.ext ?? 'bin';
      const safe = `${asset.name
        .normalize('NFD')
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 80)}.${ext}`;
      reply
        .header('content-type', contentType)
        .header(
          'content-disposition',
          `${inline && !download ? 'inline' : 'attachment'}; filename="${safe}"`,
        )
        .header('cache-control', 'private, max-age=3600')
        // Arquivos nunca são interpretados como página (proteção extra contra XSS).
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cross-origin-resource-policy', 'same-origin');
      return reply.send(await storage().get(key));
    });
  serve('file');
  serve('thumbnail');
}
