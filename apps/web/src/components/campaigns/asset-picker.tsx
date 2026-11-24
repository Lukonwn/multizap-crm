'use client';
import { useState } from 'react';
import { Search } from 'lucide-react';
import type { AssetDTO, AssetKindValue } from '@multizap/shared';
import { EmptyState, Input, Modal, Spinner } from '@multizap/ui';
import { useAssets } from '@/lib/assets';
import { AssetThumb } from '../assets/asset-thumb';

/** Escolha de um criativo da biblioteca. */
export function AssetPicker({
  kinds,
  title,
  onPick,
  onClose,
}: {
  kinds: AssetKindValue[];
  title: string;
  onPick: (a: AssetDTO) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<AssetKindValue>(kinds[0]!);
  const assets = useAssets({ kind, q: q || undefined, page: 1 });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title} className="w-[min(94vw,820px)]">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {kinds.length > 1 &&
          kinds.map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-md px-2.5 py-1 text-xs ${kind === k ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg'}`}
            >
              {
                {
                  IMAGE: 'Imagens',
                  BANNER: 'Banners',
                  TEMPLATE: 'Modelos',
                  TEXT: 'Textos',
                  LINK: 'Links',
                  FILE: 'Arquivos',
                }[k]
              }
            </button>
          ))}
        <div className="relative ml-auto w-64">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Pesquisar"
            className="h-9 pl-9"
            aria-label="Pesquisar na biblioteca"
          />
        </div>
      </div>
      {assets.isPending && <Spinner />}
      {assets.data?.items.length === 0 && (
        <EmptyState
          title="Nada encontrado"
          description="Adicione criativos na Biblioteca de criativos."
        />
      )}
      <div className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
        {assets.data?.items.map((a) => (
          <button
            key={a.id}
            onClick={() => onPick(a)}
            className="overflow-hidden rounded-lg border border-border bg-surface text-left transition-colors hover:border-accent/50"
          >
            <div className="aspect-[4/3] overflow-hidden">
              <AssetThumb asset={a} />
            </div>
            <p className="truncate px-2.5 py-2 text-sm">{a.name}</p>
          </button>
        ))}
      </div>
    </Modal>
  );
}
