'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, ShieldCheck } from 'lucide-react';
import type { SessionInfo } from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  Spinner,
} from '@multizap/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/components/auth/auth-provider';
import { ChangePasswordForm } from '@/components/auth/change-password-form';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function describeAgent(ua: string | null): string {
  if (!ua) return 'Navegador desconhecido';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Navegador';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Linux/.test(ua)
        ? 'Linux'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad/.test(ua)
            ? 'iOS'
            : '';
  return os ? `${browser} · ${os}` : browser;
}

function SessionsCard() {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => api<{ items: SessionInfo[] }>('/auth/sessions').then((r) => r.items),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] }),
  });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Sessões ativas</CardTitle>
          <CardDescription>
            Navegadores com acesso ao painel. Encerre as que não reconhecer.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {sessions.isPending && <Spinner />}
        {sessions.isError && <Alert tone="danger">{sessions.error.message}</Alert>}
        {revoke.isError && (
          <Alert tone="danger" className="mb-3">
            {revoke.error.message}
          </Alert>
        )}
        {sessions.data && (
          <ul className="divide-y divide-border">
            {sessions.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-muted">
                    <Monitor className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm text-fg">
                      {describeAgent(s.userAgent)}
                      {s.current && <Badge tone="accent">Esta sessão</Badge>}
                    </p>
                    <p className="truncate text-xs text-subtle">
                      {s.ip ?? 'IP desconhecido'} · último acesso{' '}
                      {dateFmt.format(new Date(s.lastSeenAt))}
                    </p>
                  </div>
                </div>
                {!s.current && (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={revoke.isPending && revoke.variables === s.id}
                    onClick={() => revoke.mutate(s.id)}
                  >
                    Encerrar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader
        title="Configurações"
        description="Conta do administrador e segurança do acesso."
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Alterar senha</CardTitle>
              <CardDescription>
                Conta: <span className="text-fg">{user.email}</span>
                {user.lastLoginAt && (
                  <> · último login {dateFmt.format(new Date(user.lastLoginAt))}</>
                )}
              </CardDescription>
            </div>
            <ShieldCheck className="h-5 w-5 text-accent" aria-hidden />
          </CardHeader>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
        <SessionsCard />
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Operações e backups</CardTitle>
              <CardDescription>Configurações que chegam nas próximas fases.</CardDescription>
            </div>
            <Badge tone="warning" dot>
              Fase 9
            </Badge>
          </CardHeader>
          <CardContent className="text-sm text-muted">
            Pausa global de operações, política de retenção de backups e restauração ficarão
            disponíveis aqui na Fase 9.
          </CardContent>
        </Card>
      </div>
    </>
  );
}
