'use client';
import { useState } from 'react';
import { createContactSchema, type ContactDTO } from '@multizap/shared';
import { Alert, Button, Field, Input, Label, Modal } from '@multizap/ui';
import { ApiError } from '@/lib/api';
import { useContactsMutation } from '@/lib/contacts';
import { TagPicker } from './tags';

/** Cadastro (contact ausente) ou edição de contato. */
export function ContactFormModal({
  accountId,
  contact,
  open,
  onOpenChange,
  onSaved,
}: {
  accountId: string;
  contact?: ContactDTO;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: (c: ContactDTO, warning?: string | null) => void;
}) {
  const editing = !!contact;
  const m = useContactsMutation<{ contact: ContactDTO; warning?: string | null }>(accountId);
  const [name, setName] = useState(contact?.name ?? '');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [tagIds, setTagIds] = useState<string[]>(contact?.tags.map((t) => t.id) ?? []);
  const [withConsent, setWithConsent] = useState(false);
  const [source, setSource] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) {
      const parsed = createContactSchema.safeParse({
        name,
        phone,
        notes,
        tagIds,
        consent: withConsent ? { source } : null,
      });
      if (!parsed.success) {
        const errs: Record<string, string> = {};
        for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
        setErrors(errs);
        return;
      }
    }
    setErrors({});
    try {
      const r = await m.mutateAsync(
        editing
          ? { path: `/contacts/${contact.id}`, method: 'PATCH', json: { name, notes, tagIds } }
          : {
              path: '/contacts',
              json: { name, phone, notes, tagIds, consent: withConsent ? { source } : null },
            },
      );
      onOpenChange(false);
      onSaved?.(r.contact, r.warning);
    } catch (err) {
      if (err instanceof ApiError && err.fields)
        setErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, v[0]!])));
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'Editar contato' : 'Novo contato'}
      description={editing ? undefined : 'O contato pertence somente à instância selecionada.'}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {m.isError && !(m.error instanceof ApiError && m.error.fields) && (
          <Alert tone="danger">{m.error.message}</Alert>
        )}
        <Field label="Nome" htmlFor="c-name" error={errors.name}>
          <Input
            id="c-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoFocus
          />
        </Field>
        {!editing && (
          <Field
            label="Telefone"
            htmlFor="c-phone"
            error={errors.phone}
            hint="Com DDD. Para outros países, inclua o código (+351...)."
          >
            <Input
              id="c-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              placeholder="(11) 98765-4321"
              aria-invalid={!!errors.phone}
            />
          </Field>
        )}
        <div>
          <Label>Etiquetas</Label>
          <TagPicker accountId={accountId} value={tagIds} onChange={setTagIds} />
        </div>
        <Field label="Observações" htmlFor="c-notes" error={errors.notes}>
          <textarea
            id="c-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
            rows={3}
            className="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          />
        </Field>
        {!editing && (
          <div className="rounded-lg border border-border bg-bg-soft p-3">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={withConsent}
                onChange={(e) => setWithConsent(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              Registrar consentimento agora
            </label>
            {withConsent && (
              <div className="mt-3">
                <Field
                  label="Como o consentimento foi obtido?"
                  htmlFor="c-source"
                  error={errors['consent.source']}
                >
                  <Input
                    id="c-source"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder="Ex.: pediu contato na loja em 10/11"
                  />
                </Field>
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" loading={m.isPending}>
            {editing ? 'Salvar' : 'Cadastrar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
