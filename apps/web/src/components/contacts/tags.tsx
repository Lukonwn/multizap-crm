'use client';
import { useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { TAG_COLORS, type TagDTO } from '@multizap/shared';
import { Alert, Button, Input, Modal, cn } from '@multizap/ui';
import { useContactsMutation, useTags } from '@/lib/contacts';

export function TagChip({
  tag,
  className,
}: {
  tag: Pick<TagDTO, 'name' | 'color'>;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg/90',
        className,
      )}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: tag.color }} aria-hidden />
      {tag.name}
    </span>
  );
}

/** Seleção múltipla de etiquetas da instância. */
export function TagPicker({
  accountId,
  value,
  onChange,
}: {
  accountId: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const tags = useTags(accountId);
  if (!tags.data?.length)
    return <p className="text-xs text-subtle">Nenhuma etiqueta criada nesta instância.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.data.map((t) => {
        const on = value.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(on ? value.filter((v) => v !== t.id) : [...value, t.id])}
            aria-pressed={on}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
              on
                ? 'border-accent/50 bg-accent-soft text-fg'
                : 'border-border bg-bg-soft text-muted hover:text-fg',
            )}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: t.color }} aria-hidden />
            {t.name}
            {on && <Check className="h-3 w-3 text-accent" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

export function TagsModal({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const tags = useTags(accountId);
  const m = useContactsMutation(accountId);
  const [name, setName] = useState('');
  const [color, setColor] = useState(TAG_COLORS[0]!);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    m.mutate({ path: '/tags', json: { name, color } }, { onSuccess: () => setName('') });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Etiquetas"
      description="Etiquetas desta instância. Não são compartilhadas com outras instâncias."
    >
      <div className="space-y-5">
        {m.isError && <Alert tone="danger">{m.error.message}</Alert>}
        <form onSubmit={create} className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nova etiqueta"
              maxLength={40}
              aria-label="Nome da etiqueta"
            />
            <Button type="submit" loading={m.isPending} disabled={!name.trim()}>
              <Plus className="h-4 w-4" aria-hidden /> Criar
            </Button>
          </div>
          <div className="flex gap-2" role="radiogroup" aria-label="Cor">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                onClick={() => setColor(c)}
                className={cn(
                  'h-6 w-6 rounded-full ring-offset-2 ring-offset-surface transition',
                  color === c && 'ring-2 ring-fg',
                )}
                style={{ background: c }}
              />
            ))}
          </div>
        </form>
        <ul className="max-h-72 divide-y divide-border overflow-y-auto">
          {tags.data?.map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2.5">
              <TagChip tag={t} />
              <div className="flex items-center gap-3">
                <span className="text-xs text-subtle">{t.contactCount ?? 0} contato(s)</span>
                <button
                  className="rounded p-1 text-subtle hover:bg-danger-soft hover:text-danger"
                  aria-label={`Excluir etiqueta ${t.name}`}
                  onClick={() =>
                    window.confirm(
                      `Excluir a etiqueta "${t.name}"? Ela será removida dos contatos.`,
                    ) && m.mutate({ path: `/tags/${t.id}`, method: 'DELETE' })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
          {tags.data?.length === 0 && (
            <li className="py-6 text-center text-sm text-subtle">Nenhuma etiqueta.</li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
