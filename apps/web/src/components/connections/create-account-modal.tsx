'use client';
import { useState } from 'react';
import { Info, Smartphone, SmartphoneNfc } from 'lucide-react';
import { createAccountSchema, type AccountDTO, type ConnectionTypeValue } from '@multizap/shared';
import { Alert, Button, Field, Input, Modal, cn } from '@multizap/ui';
import { ApiError } from '@/lib/api';
import { useCreateAccount } from '@/lib/accounts';

const TYPES: {
  value: ConnectionTypeValue;
  title: string;
  description: string;
  icon: typeof Smartphone;
}[] = [
  {
    value: 'WHATSAPP_WEB',
    title: 'Dispositivo conectado',
    description: 'Pareado como no WhatsApp Web (QR Code ou código). Recebe e envia mensagens.',
    icon: SmartphoneNfc,
  },
  {
    value: 'EXTERNAL_DEVICE',
    title: 'Aparelho externo cadastrado',
    description: 'Apenas registro do número. Sem envio nem sincronização de mensagens.',
    icon: Smartphone,
  },
];

export function CreateAccountModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (account: AccountDTO) => void;
}) {
  const create = useCreateAccount();
  const [name, setName] = useState('');
  const [type, setType] = useState<ConnectionTypeValue>('WHATSAPP_WEB');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const reset = () => {
    setName('');
    setPhone('');
    setType('WHATSAPP_WEB');
    setErrors({});
    create.reset();
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const input = { name, connectionType: type, phone: phone || undefined };
    const parsed = createAccountSchema.safeParse(input);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    try {
      const r = await create.mutateAsync(input);
      onOpenChange(false);
      reset();
      onCreated(r.account);
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, v[0]])));
      }
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
      title="Nova instância"
      description="Cadastre uma conta WhatsApp para gerenciar no MultiZap."
    >
      <form onSubmit={submit} className="space-y-5" noValidate>
        {create.isError && !(create.error instanceof ApiError && create.error.fields) && (
          <Alert tone="danger">{create.error.message}</Alert>
        )}
        <Field label="Nome da instância" htmlFor="acc-name" error={errors.name}>
          <Input
            id="acc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Vendas, Suporte, Loja Centro"
            autoFocus
            aria-invalid={!!errors.name}
          />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-muted">Tipo</legend>
          <div className="grid gap-2">
            {TYPES.map((t) => (
              <label
                key={t.value}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors',
                  type === t.value
                    ? 'border-accent/60 bg-accent-soft'
                    : 'border-border bg-bg-soft hover:border-border-strong',
                )}
              >
                <input
                  type="radio"
                  name="type"
                  value={t.value}
                  checked={type === t.value}
                  onChange={() => setType(t.value)}
                  className="sr-only"
                />
                <t.icon
                  className={cn(
                    'mt-0.5 h-5 w-5 shrink-0',
                    type === t.value ? 'text-accent' : 'text-subtle',
                  )}
                  aria-hidden
                />
                <span>
                  <span className="block text-sm font-medium text-fg">{t.title}</span>
                  <span className="mt-0.5 block text-xs text-muted">{t.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {type === 'EXTERNAL_DEVICE' ? (
          <Field
            label="Número do aparelho"
            htmlFor="acc-phone"
            error={errors.phone}
            hint="Com DDD. Para outros países, inclua o código (+351...)."
          >
            <Input
              id="acc-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(11) 98765-4321"
              inputMode="tel"
              aria-invalid={!!errors.phone}
            />
          </Field>
        ) : (
          <p className="flex gap-2 text-xs text-subtle">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />O número será identificado
            automaticamente após o pareamento.
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" loading={create.isPending}>
            Cadastrar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
