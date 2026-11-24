'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { changePasswordSchema, type AdminProfile } from '@multizap/shared';
import { Alert, Button, Field, Input } from '@multizap/ui';
import { api, ApiError } from '@/lib/api';
import { ME_QUERY_KEY } from './auth-provider';

type Errors = Partial<Record<'currentPassword' | 'newPassword' | 'confirm' | '_', string>>;

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSuccess(false);
    const parsed = changePasswordSchema.safeParse(values);
    const errs: Errors = {};
    if (!parsed.success) {
      for (const i of parsed.error.issues) errs[i.path[0] as keyof Errors] ??= i.message;
    }
    if (values.newPassword !== values.confirm) errs.confirm = 'As senhas não coincidem.';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setLoading(true);
    try {
      const r = await api<{ user: AdminProfile }>('/auth/change-password', {
        method: 'POST',
        json: { currentPassword: values.currentPassword, newPassword: values.newPassword },
      });
      queryClient.setQueryData(ME_QUERY_KEY, r.user);
      setValues({ currentPassword: '', newPassword: '', confirm: '' });
      setSuccess(true);
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') {
        setErrors({ currentPassword: 'Senha atual incorreta.' });
      } else if (err instanceof ApiError && err.fields) {
        setErrors({ newPassword: err.fields.newPassword?.[0], _: err.message });
      } else {
        setErrors({ _: err instanceof Error ? err.message : 'Erro inesperado.' });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {errors._ && <Alert tone="danger">{errors._}</Alert>}
      {success && <Alert tone="success">Senha alterada. As outras sessões foram encerradas.</Alert>}
      <Field label="Senha atual" htmlFor="currentPassword" error={errors.currentPassword}>
        <Input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          value={values.currentPassword}
          onChange={set('currentPassword')}
          aria-invalid={!!errors.currentPassword}
        />
      </Field>
      <Field
        label="Nova senha"
        htmlFor="newPassword"
        error={errors.newPassword}
        hint="Mínimo de 12 caracteres, com maiúsculas, minúsculas, número e símbolo."
      >
        <Input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          value={values.newPassword}
          onChange={set('newPassword')}
          aria-invalid={!!errors.newPassword}
        />
      </Field>
      <Field label="Confirmar nova senha" htmlFor="confirm" error={errors.confirm}>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          value={values.confirm}
          onChange={set('confirm')}
          aria-invalid={!!errors.confirm}
        />
      </Field>
      <Button type="submit" loading={loading} className="w-full sm:w-auto">
        Alterar senha
      </Button>
    </form>
  );
}
