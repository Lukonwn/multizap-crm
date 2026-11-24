'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Lock, ShieldCheck, Smartphone, Users } from 'lucide-react';
import { loginSchema, type AdminProfile } from '@multizap/shared';
import { Alert, Button, Field, Input } from '@multizap/ui';
import { api, ApiError } from '@/lib/api';
import { BrandMark } from '@/components/brand';
import { ME_QUERY_KEY } from '@/components/auth/auth-provider';

function safeNext(next: string | null): string {
  // Apenas caminhos internos (evita open redirect).
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; _?: string }>({});
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const errs: typeof errors = {};
      for (const i of parsed.error.issues) errs[i.path[0] as 'email' | 'password'] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      const r = await api<{ user: AdminProfile }>('/auth/login', {
        method: 'POST',
        json: parsed.data,
      });
      queryClient.setQueryData(ME_QUERY_KEY, r.user);
      router.replace(safeNext(params.get('next')));
    } catch (err) {
      setErrors({
        _: err instanceof ApiError ? err.message : 'Não foi possível entrar. Tente novamente.',
      });
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {errors._ && <Alert tone="danger">{errors._}</Alert>}
      <Field label="E-mail" htmlFor="email" error={errors.email}>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={!!errors.email}
          placeholder="admin@empresa.com"
        />
      </Field>
      <Field label="Senha" htmlFor="password" error={errors.password}>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!errors.password}
        />
      </Field>
      <Button type="submit" size="lg" loading={loading} className="w-full">
        <Lock className="h-4 w-4" aria-hidden />
        Entrar
      </Button>
    </form>
  );
}

const highlights = [
  { icon: Smartphone, text: 'Até 10 instâncias WhatsApp com sessões persistentes' },
  { icon: Users, text: 'Bases de contatos isoladas por instância' },
  { icon: ShieldCheck, text: 'Credenciais criptografadas e auditoria completa' },
];

export default function LoginPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden border-r border-border bg-bg-soft lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              'radial-gradient(600px circle at 15% 20%, rgb(16 185 129 / 0.16), transparent 60%), radial-gradient(500px circle at 85% 85%, rgb(16 185 129 / 0.08), transparent 60%)',
          }}
          aria-hidden
        />
        <div className="relative flex items-center gap-3">
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight">MultiZap CRM</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-fg">
            Todas as suas contas WhatsApp em um único painel.
          </h1>
          <ul className="mt-8 space-y-4">
            {highlights.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-muted">
                <span className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-accent">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-subtle">Acesso restrito ao administrador.</p>
      </section>

      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm animate-slide-up">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark />
            <span className="text-sm font-semibold">MultiZap CRM</span>
          </div>
          <h2 className="text-xl font-semibold tracking-tight">Entrar no painel</h2>
          <p className="mb-8 mt-1 text-sm text-muted">Use suas credenciais de administrador.</p>
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </section>
    </div>
  );
}
