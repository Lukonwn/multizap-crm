'use client';
import { useState } from 'react';
import { ChevronRight, Folder, FolderOpen, FolderPlus, Layers, Pencil, Trash2 } from 'lucide-react';
import type { AssetFolderDTO } from '@multizap/shared';
import { Alert, Button, Field, Input, Modal, cn } from '@multizap/ui';
import { useAssetMutation } from '@/lib/assets';

export type FolderSelection = 'all' | 'root' | string;

function FolderModal({
  folders,
  edit,
  parentId,
  onClose,
}: {
  folders: AssetFolderDTO[];
  edit?: AssetFolderDTO;
  parentId?: string | null;
  onClose: () => void;
}) {
  const m = useAssetMutation();
  const [name, setName] = useState(edit?.name ?? '');
  const parentName = parentId ? folders.find((f) => f.id === parentId)?.name : null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    m.mutate(
      edit
        ? { path: `/asset-folders/${edit.id}`, method: 'PATCH', json: { name } }
        : { path: '/asset-folders', json: { name, parentId: parentId ?? null } },
      { onSuccess: onClose },
    );
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={edit ? 'Renomear pasta' : 'Nova pasta'}
      description={parentName ? `Dentro de "${parentName}"` : undefined}
    >
      <form onSubmit={submit} className="space-y-4">
        {m.isError && <Alert tone="danger">{m.error.message}</Alert>}
        <Field label="Nome" htmlFor="folder-name">
          <Input
            id="folder-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoFocus
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={m.isPending} disabled={!name.trim()}>
            Salvar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function FolderTree({
  folders,
  selected,
  onSelect,
}: {
  folders: AssetFolderDTO[];
  selected: FolderSelection;
  onSelect: (s: FolderSelection) => void;
}) {
  const m = useAssetMutation();
  const [modal, setModal] = useState<null | { edit?: AssetFolderDTO; parentId?: string | null }>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const children = (parentId: string | null) => folders.filter((f) => f.parentId === parentId);

  const remove = (f: AssetFolderDTO) => {
    if (!window.confirm(`Excluir a pasta "${f.name}"?`)) return;
    setError(null);
    m.mutate(
      { path: `/asset-folders/${f.id}`, method: 'DELETE' },
      {
        onSuccess: () => selected === f.id && onSelect('all'),
        onError: (e) => setError(e.message),
      },
    );
  };

  const Item = ({ f, depth }: { f: AssetFolderDTO; depth: number }) => {
    const active = selected === f.id;
    const kids = children(f.id);
    return (
      <li>
        <div
          className={cn(
            'group flex h-8 items-center gap-1.5 rounded-md pr-1 text-sm transition-colors',
            active ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <button
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => onSelect(f.id)}
          >
            {active ? (
              <FolderOpen className="h-4 w-4 shrink-0 text-accent" />
            ) : (
              <Folder className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{f.name}</span>
            <span className="text-[11px] text-subtle">{f.assetCount || ''}</span>
          </button>
          <span className="hidden items-center group-hover:flex">
            <button
              className="rounded p-1 hover:bg-surface-3"
              aria-label={`Nova subpasta em ${f.name}`}
              onClick={() => setModal({ parentId: f.id })}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
            <button
              className="rounded p-1 hover:bg-surface-3"
              aria-label={`Renomear ${f.name}`}
              onClick={() => setModal({ edit: f })}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              className="rounded p-1 hover:bg-danger-soft hover:text-danger"
              aria-label={`Excluir ${f.name}`}
              onClick={() => remove(f)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
        {kids.length > 0 && (
          <ul>
            {kids.map((k) => (
              <Item key={k.id} f={k} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  const Fixed = ({
    value,
    label,
    icon: Icon,
  }: {
    value: FolderSelection;
    label: string;
    icon: typeof Layers;
  }) => (
    <button
      onClick={() => onSelect(value)}
      className={cn(
        'flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-sm transition-colors',
        selected === value
          ? 'bg-accent-soft text-fg'
          : 'text-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      <Icon className={cn('h-4 w-4', selected === value && 'text-accent')} /> {label}
    </button>
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-subtle">Pastas</p>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Nova pasta"
          onClick={() => setModal({ parentId: null })}
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      </div>
      {error && (
        <Alert tone="danger" className="mb-2 text-xs">
          {error}
        </Alert>
      )}
      <Fixed value="all" label="Todos os criativos" icon={Layers} />
      <Fixed value="root" label="Sem pasta" icon={ChevronRight} />
      <ul className="mt-1">
        {children(null).map((f) => (
          <Item key={f.id} f={f} depth={0} />
        ))}
      </ul>
      {modal && (
        <FolderModal
          folders={folders}
          edit={modal.edit}
          parentId={modal.parentId}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
