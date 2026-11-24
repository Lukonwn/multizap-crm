'use client';
import { useRef, useState } from 'react';
import {
  MAX_MESSAGE_LENGTH,
  SAMPLE_TEMPLATE_VALUES,
  TEMPLATE_VARIABLES,
  renderTemplate,
  type AssetDTO,
  type AssetFolderDTO,
} from '@multizap/shared';
import { Alert, Button, Field, Input, Label, Modal, Select } from '@multizap/ui';
import { ApiError } from '@/lib/api';
import { useAssetMutation } from '@/lib/assets';
import { MessagePreview } from './message-preview';

type Kind = 'TEXT' | 'LINK' | 'TEMPLATE';
const TITLES: Record<Kind, string> = {
  TEXT: 'texto',
  LINK: 'link',
  TEMPLATE: 'modelo de mensagem',
};

/** Criação/edição de texto, link ou modelo, com pré-visualização ao vivo. */
export function ContentModal({
  kind,
  asset,
  folders,
  defaultFolderId,
  onClose,
}: {
  kind: Kind;
  asset?: AssetDTO;
  folders: AssetFolderDTO[];
  defaultFolderId: string | null;
  onClose: () => void;
}) {
  const m = useAssetMutation();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState(asset?.name ?? '');
  const [folderId, setFolderId] = useState<string | null>(asset ? asset.folderId : defaultFolderId);
  const [text, setText] = useState(asset?.textContent ?? '');
  const [url, setUrl] = useState(asset?.url ?? '');
  const [description, setDescription] = useState(asset?.description ?? '');
  const fields = m.error instanceof ApiError ? m.error.fields : undefined;

  const insertVar = (v: string) => {
    const el = ref.current;
    const token = `{{${v}}}`;
    if (!el) return setText((t) => t + token);
    const start = el.selectionStart;
    const next = text.slice(0, start) + token + text.slice(el.selectionEnd);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const content =
      kind === 'LINK' ? { url, description: description || null } : { textContent: text };
    m.mutate(
      asset
        ? { path: `/assets/${asset.id}`, method: 'PATCH', json: { name, folderId, ...content } }
        : { path: '/assets', json: { kind, name, folderId, ...content } },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${asset ? 'Editar' : 'Novo'} ${TITLES[kind]}`}
      className="w-[min(94vw,760px)]"
    >
      <form onSubmit={submit} className="grid gap-5 md:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          {m.isError && !fields && <Alert tone="danger">{m.error.message}</Alert>}
          <Field label="Nome" htmlFor="asset-name" error={fields?.name?.[0]}>
            <Input
              id="asset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
            />
          </Field>
          <Field label="Pasta" htmlFor="asset-folder">
            <Select
              id="asset-folder"
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
          {kind === 'LINK' ? (
            <>
              <Field label="Endereço" htmlFor="asset-url" error={fields?.url?.[0]}>
                <Input
                  id="asset-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://..."
                  inputMode="url"
                />
              </Field>
              <Field label="Descrição (opcional)" htmlFor="asset-desc">
                <Input
                  id="asset-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                />
              </Field>
            </>
          ) : (
            <div>
              <Label htmlFor="asset-text">Texto da mensagem</Label>
              {kind === 'TEMPLATE' && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {Object.entries(TEMPLATE_VARIABLES).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      title={label}
                      onClick={() => insertVar(v)}
                      className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-accent hover:border-accent/50"
                    >
                      {`{{${v}}}`}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={ref}
                id="asset-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                maxLength={MAX_MESSAGE_LENGTH}
                className="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
              <div className="mt-1 flex justify-between text-xs">
                <span className="text-danger">{fields?.textContent?.[0]}</span>
                <span className="tabular-nums text-subtle">
                  {text.length}/{MAX_MESSAGE_LENGTH}
                </span>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={m.isPending}>
              Salvar
            </Button>
          </div>
        </div>
        <div>
          <MessagePreview
            text={
              kind === 'TEMPLATE'
                ? renderTemplate(text, SAMPLE_TEMPLATE_VALUES)
                : kind === 'TEXT'
                  ? text
                  : null
            }
            link={kind === 'LINK' && url ? { url, title: name || undefined, description } : null}
          />
          {kind === 'TEMPLATE' && (
            <p className="mt-2 text-xs text-subtle">
              Exemplo com dados fictícios. Nas campanhas, as variáveis são preenchidas com os dados
              de cada contato.
            </p>
          )}
        </div>
      </form>
    </Modal>
  );
}
