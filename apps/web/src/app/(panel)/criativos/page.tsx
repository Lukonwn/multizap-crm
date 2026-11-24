'use client';
import { useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Images,
  Link2,
  MessageSquareText,
  Search,
  Type,
  Upload,
} from 'lucide-react';
import { ASSET_KIND_LABEL, type AssetDTO, type AssetKindValue } from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Spinner,
  cn,
} from '@multizap/ui';
import { formatBytes, useAssets, useFolders } from '@/lib/assets';
import { AssetDetail } from '@/components/assets/asset-detail';
import { AssetThumb } from '@/components/assets/asset-thumb';
import { ContentModal } from '@/components/assets/content-modal';
import { FolderTree, type FolderSelection } from '@/components/assets/folder-tree';
import { UploadModal } from '@/components/assets/upload-modal';

const KIND_TABS: { value: '' | AssetKindValue; label: string }[] = [
  { value: '', label: 'Todos' },
  { value: 'IMAGE', label: 'Imagens' },
  { value: 'BANNER', label: 'Banners' },
  { value: 'TEXT', label: 'Textos' },
  { value: 'LINK', label: 'Links' },
  { value: 'TEMPLATE', label: 'Modelos' },
  { value: 'FILE', label: 'Arquivos' },
];

export default function AssetsPage() {
  const folders = useFolders();
  const [folder, setFolder] = useState<FolderSelection>('all');
  const [kind, setKind] = useState<'' | AssetKindValue>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [content, setContent] = useState<null | {
    kind: 'TEXT' | 'LINK' | 'TEMPLATE';
    asset?: AssetDTO;
  }>(null);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [folder, kind, q]);

  const assets = useAssets({
    folder: folder === 'all' ? undefined : folder,
    kind: kind || undefined,
    q: q || undefined,
    page,
  });
  const folderList = folders.data ?? [];
  const currentFolderId = folder !== 'all' && folder !== 'root' ? folder : null;
  const folderName =
    folder === 'all'
      ? 'Todos os criativos'
      : folder === 'root'
        ? 'Sem pasta'
        : folderList.find((f) => f.id === folder)?.name;
  const pages = assets.data ? Math.max(1, Math.ceil(assets.data.total / assets.data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Biblioteca de criativos"
        description="Imagens, banners, textos, links, modelos de mensagem e arquivos para campanhas."
        actions={
          <>
            <Button variant="secondary" onClick={() => setContent({ kind: 'TEXT' })}>
              <Type className="h-4 w-4" aria-hidden /> Texto
            </Button>
            <Button variant="secondary" onClick={() => setContent({ kind: 'LINK' })}>
              <Link2 className="h-4 w-4" aria-hidden /> Link
            </Button>
            <Button variant="secondary" onClick={() => setContent({ kind: 'TEMPLATE' })}>
              <MessageSquareText className="h-4 w-4" aria-hidden /> Modelo
            </Button>
            <Button onClick={() => setUploading(true)}>
              <Upload className="h-4 w-4" aria-hidden /> Enviar arquivos
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <Card className="h-fit p-3">
          <FolderTree folders={folderList} selected={folder} onSelect={setFolder} />
        </Card>

        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="mr-2 text-sm font-semibold text-fg">{folderName}</h2>
            <div className="flex flex-wrap gap-1">
              {KIND_TABS.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setKind(t.value)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs transition-colors',
                    kind === t.value ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="relative ml-auto w-full sm:w-72">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Pesquisar por nome ou conteúdo"
                className="h-9 pl-9"
                aria-label="Pesquisar criativos"
              />
            </div>
          </div>

          {assets.isError && <Alert tone="danger">{assets.error.message}</Alert>}
          {assets.isPending && (
            <div className="grid place-items-center py-20">
              <Spinner />
            </div>
          )}
          {assets.data?.items.length === 0 && (
            <Card>
              <EmptyState
                icon={Images}
                title={q || kind ? 'Nenhum criativo encontrado' : 'Nenhum criativo aqui'}
                description={
                  q || kind
                    ? 'Ajuste a pesquisa ou os filtros.'
                    : 'Envie imagens e arquivos ou crie textos, links e modelos de mensagem.'
                }
                action={
                  !q && !kind ? (
                    <Button onClick={() => setUploading(true)}>
                      <Upload className="h-4 w-4" aria-hidden /> Enviar arquivos
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          )}

          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 2xl:grid-cols-5">
            {assets.data?.items.map((a) => (
              <button
                key={a.id}
                onClick={() => setDetail(a.id)}
                className="group overflow-hidden rounded-card border border-border bg-surface text-left shadow-card transition-colors hover:border-accent/40 animate-slide-up"
              >
                <div className="aspect-[4/3] overflow-hidden border-b border-border">
                  <AssetThumb
                    asset={a}
                    className="transition-transform duration-300 group-hover:scale-[1.03]"
                  />
                </div>
                <div className="p-3">
                  <p className="truncate text-sm font-medium text-fg">{a.name}</p>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-subtle">
                    <Badge>{ASSET_KIND_LABEL[a.kind]}</Badge>
                    <span className="truncate">
                      {a.width
                        ? `${a.width}×${a.height}`
                        : a.sizeBytes !== null
                          ? formatBytes(a.sizeBytes)
                          : a.kind === 'TEMPLATE'
                            ? `${a.variables.length} variável(is)`
                            : ''}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {pages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted">
              <Button
                variant="ghost"
                size="icon"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                aria-label="Página anterior"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span>
                Página {page} de {pages}
              </span>
              <Button
                variant="ghost"
                size="icon"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
                aria-label="Próxima página"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </div>

      {uploading && (
        <UploadModal
          folders={folderList}
          defaultFolderId={currentFolderId}
          onClose={() => setUploading(false)}
        />
      )}
      {content && (
        <ContentModal
          kind={content.kind}
          asset={content.asset}
          folders={folderList}
          defaultFolderId={currentFolderId}
          onClose={() => setContent(null)}
        />
      )}
      {detail && (
        <AssetDetail
          id={detail}
          folders={folderList}
          onClose={() => setDetail(null)}
          onEdit={(a) => {
            setDetail(null);
            setContent({ kind: a.kind as 'TEXT' | 'LINK' | 'TEMPLATE', asset: a });
          }}
        />
      )}
    </>
  );
}
