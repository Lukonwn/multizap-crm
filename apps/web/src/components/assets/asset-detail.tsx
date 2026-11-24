'use client';
import { useState } from 'react';
import { Download, Pencil, Trash2 } from 'lucide-react';
import {
  ALLOWED_MIME,
  ASSET_KIND_LABEL,
  SAMPLE_TEMPLATE_VALUES,
  renderTemplate,
  type AssetDTO,
  type AssetFolderDTO,
} from '@multizap/shared';
import { Alert, Badge, Button, Field, Input, Modal, Select, Spinner } from '@multizap/ui';
import { formatBytes, useAsset, useAssetMutation } from '@/lib/assets';
import { formatDateTime } from '@/lib/format';
import { MessagePreview } from './message-preview';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-fg/90">{children}</dd>
    </div>
  );
}

export function AssetDetail({
  id,
  folders,
  onEdit,
  onClose,
}: {
  id: string;
  folders: AssetFolderDTO[];
  onEdit: (a: AssetDTO) => void;
  onClose: () => void;
}) {
  const q = useAsset(id);
  const m = useAssetMutation();
  const [name, setName] = useState<string | null>(null);
  const a = q.data?.asset;
  const fileUrl = `/api/assets/${id}/file`;

  const save = (json: object) => m.mutate({ path: `/assets/${id}`, method: 'PATCH', json });

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={a?.name ?? 'Criativo'}
      description={a ? ASSET_KIND_LABEL[a.kind] : undefined}
      className="w-[min(94vw,880px)]"
    >
      {!a ? (
        <Spinner />
      ) : (
        <div className="grid gap-6 md:grid-cols-[1fr_300px]">
          <div className="space-y-4">
            {a.hasFile && a.mimeType?.startsWith('image/') && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={fileUrl}
                alt={a.name}
                className="max-h-[420px] w-full rounded-xl border border-border bg-[repeating-conic-gradient(#1e2935_0%_25%,#17202a_0%_50%)] bg-[length:20px_20px] object-contain"
              />
            )}
            {a.hasFile && a.mimeType?.startsWith('video/') && (
              <video src={fileUrl} controls className="w-full rounded-xl border border-border" />
            )}
            {a.hasFile && a.mimeType?.startsWith('audio/') && (
              <audio src={fileUrl} controls className="w-full" />
            )}
            {a.hasFile && a.mimeType === 'application/pdf' && (
              <Alert tone="info">Documento PDF. Use “Baixar” para abri-lo.</Alert>
            )}
            {a.kind === 'TEXT' && <MessagePreview text={a.textContent} />}
            {a.kind === 'TEMPLATE' && (
              <>
                <MessagePreview
                  text={renderTemplate(a.textContent ?? '', SAMPLE_TEMPLATE_VALUES)}
                />
                <div className="flex flex-wrap gap-1.5">
                  {a.variables.map((v) => (
                    <Badge key={v} tone="accent" className="font-mono">{`{{${v}}}`}</Badge>
                  ))}
                </div>
              </>
            )}
            {a.kind === 'LINK' && a.url && (
              <MessagePreview link={{ url: a.url, title: a.name, description: a.description }} />
            )}

            <div>
              <p className="mb-2 text-xs font-medium text-muted">Histórico de utilização</p>
              {q.data!.usages.length === 0 ? (
                <p className="text-sm text-subtle">Ainda não utilizado em campanhas.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {q.data!.usages.map((u) => (
                    <li key={u.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span>{u.campaignName}</span>
                      <span className="text-xs text-subtle">{formatDateTime(u.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="space-y-4">
            {m.isError && <Alert tone="danger">{m.error.message}</Alert>}
            <Field label="Nome" htmlFor="detail-name">
              <div className="flex gap-2">
                <Input
                  id="detail-name"
                  value={name ?? a.name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                />
                {name !== null && name !== a.name && (
                  <Button size="sm" onClick={() => save({ name })} loading={m.isPending}>
                    Salvar
                  </Button>
                )}
              </div>
            </Field>
            <Field label="Pasta" htmlFor="detail-folder">
              <Select
                id="detail-folder"
                value={a.folderId ?? ''}
                onChange={(e) => save({ folderId: e.target.value || null })}
              >
                <option value="">Sem pasta</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
            <dl className="divide-y divide-border">
              {a.mimeType && (
                <Row label="Formato">{ALLOWED_MIME[a.mimeType]?.label ?? a.mimeType}</Row>
              )}
              {a.width && (
                <Row label="Dimensões">
                  {a.width} × {a.height} px
                </Row>
              )}
              {a.sizeBytes !== null && <Row label="Tamanho">{formatBytes(a.sizeBytes)}</Row>}
              {a.kind === 'TEXT' || a.kind === 'TEMPLATE' ? (
                <Row label="Caracteres">{a.textContent?.length ?? 0}</Row>
              ) : null}
              {a.sha256 && (
                <Row label="SHA-256">
                  <span className="font-mono text-xs" title={a.sha256}>
                    {a.sha256.slice(0, 16)}…
                  </span>
                </Row>
              )}
              <Row label="Criado em">{formatDateTime(a.createdAt)}</Row>
              <Row label="Usos">{a.usageCount}</Row>
            </dl>
            <div className="flex flex-col gap-2">
              {a.hasFile && (
                <Button variant="secondary" asChild>
                  <a href={`${fileUrl}?download=1`} download>
                    <Download className="h-4 w-4" aria-hidden /> Baixar original
                  </a>
                </Button>
              )}
              {!a.hasFile && (
                <Button variant="secondary" onClick={() => onEdit(a)}>
                  <Pencil className="h-4 w-4" aria-hidden /> Editar conteúdo
                </Button>
              )}
              <Button
                variant="danger"
                loading={m.isPending && m.variables?.method === 'DELETE'}
                onClick={() =>
                  window.confirm(
                    `Excluir "${a.name}" definitivamente?${a.usageCount ? ' Ele já foi usado em campanhas; o histórico de uso será removido.' : ''}`,
                  ) && m.mutate({ path: `/assets/${id}`, method: 'DELETE' }, { onSuccess: onClose })
                }
              >
                <Trash2 className="h-4 w-4" aria-hidden /> Excluir
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
