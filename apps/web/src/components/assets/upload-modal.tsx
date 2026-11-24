'use client';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Upload, XCircle } from 'lucide-react';
import type { AssetFolderDTO } from '@multizap/shared';
import { Button, Field, Modal, Segmented, Select, Spinner } from '@multizap/ui';
import { uploadAsset } from '@/lib/assets';

type Item = {
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  message?: string;
};

/** Envio de um ou mais arquivos; cada arquivo é validado pelo servidor. */
export function UploadModal({
  folders,
  defaultFolderId,
  onClose,
}: {
  folders: AssetFolderDTO[];
  defaultFolderId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<'IMAGE' | 'BANNER' | 'FILE'>('IMAGE');
  const [folderId, setFolderId] = useState<string | null>(defaultFolderId);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  const start = async () => {
    setBusy(true);
    for (const [i, it] of items.entries()) {
      if (it.status === 'done') continue;
      update(i, { status: 'uploading', progress: 0 });
      try {
        await uploadAsset(it.file, { kind, folderId }, (p) => update(i, { progress: p }));
        update(i, { status: 'done', progress: 100 });
      } catch (err) {
        update(i, { status: 'error', message: (err as Error).message });
      }
    }
    setBusy(false);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['assets'] }),
      qc.invalidateQueries({ queryKey: ['asset-folders'] }),
    ]);
  };

  const allDone = items.length > 0 && items.every((i) => i.status === 'done');

  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Enviar arquivos"
      description="Imagens: JPEG, PNG, WebP, GIF. Arquivos: MP4, MP3, OGG, PDF."
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Tipo</p>
            <Segmented<'IMAGE' | 'BANNER' | 'FILE'>
              value={kind}
              onChange={setKind}
              options={[
                { value: 'IMAGE', label: 'Imagem' },
                { value: 'BANNER', label: 'Banner' },
                { value: 'FILE', label: 'Arquivo' },
              ]}
            />
          </div>
          <Field label="Pasta" htmlFor="up-folder">
            <Select
              id="up-folder"
              value={folderId ?? ''}
              onChange={(e) => setFolderId(e.target.value || null)}
            >
              <option value="">Sem pasta</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <button
          type="button"
          onClick={() => ref.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setItems((prev) => [
              ...prev,
              ...[...e.dataTransfer.files].map((file) => ({
                file,
                status: 'pending' as const,
                progress: 0,
              })),
            ]);
          }}
          className="flex w-full flex-col items-center rounded-xl border-2 border-dashed border-border-strong bg-bg-soft px-6 py-8 text-center hover:border-accent/60"
        >
          <Upload className="h-6 w-6 text-accent" aria-hidden />
          <p className="mt-2 text-sm font-medium">Arraste os arquivos ou clique para selecionar</p>
        </button>
        <input
          ref={ref}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,audio/mpeg,audio/ogg,application/pdf"
          className="hidden"
          onChange={(e) =>
            setItems((prev) => [
              ...prev,
              ...[...(e.target.files ?? [])].map((file) => ({
                file,
                status: 'pending' as const,
                progress: 0,
              })),
            ])
          }
        />
        {items.length > 0 && (
          <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {items.map((it, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{it.file.name}</span>
                  {it.message && <span className="block text-xs text-danger">{it.message}</span>}
                </span>
                {it.status === 'uploading' && (
                  <span className="flex items-center gap-2 text-xs text-muted">
                    <Spinner className="h-4 w-4" /> {it.progress}%
                  </span>
                )}
                {it.status === 'done' && (
                  <CheckCircle2 className="h-4 w-4 text-success" aria-label="Enviado" />
                )}
                {it.status === 'error' && (
                  <XCircle className="h-4 w-4 text-danger" aria-label="Falhou" />
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {allDone ? 'Fechar' : 'Cancelar'}
          </Button>
          {!allDone && (
            <Button
              onClick={start}
              loading={busy}
              disabled={!items.some((i) => i.status !== 'done')}
            >
              Enviar {items.filter((i) => i.status !== 'done').length || ''}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
