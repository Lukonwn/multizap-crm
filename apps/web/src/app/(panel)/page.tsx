'use client';
import Link from 'next/link';
import {
  Activity,
  BellRing,
  CalendarClock,
  CheckCircle2,
  Clock,
  Megaphone,
  PlugZap,
  ShieldCheck,
  Smartphone,
  Unplug,
  Users,
} from 'lucide-react';
import { formatPhone } from '@multizap/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Spinner,
  StatCard,
  StatusDot,
} from '@multizap/ui';
import { useDashboard, useMarkNotificationsRead } from '@/lib/dashboard';
import { STATUS_TONE } from '@/lib/accounts';
import { formatNumber, timeAgo } from '@/lib/format';
import { AccountStatusBadge } from '@/components/connections/status-badge';
import { StatusDistribution } from '@/components/dashboard/status-distribution';
import { SeverityBadge } from '@/components/dashboard/severity';

const DOT_TONE = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'accent',
  accent: 'accent',
  neutral: 'neutral',
} as const;

export default function DashboardPage() {
  const dash = useDashboard();
  const mark = useMarkNotificationsRead();

  if (dash.isPending) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (dash.isError) return <Alert tone="danger">{dash.error.message}</Alert>;

  const d = dash.data;
  const web = d.connections.filter((c) => c.connectionType === 'WHATSAPP_WEB');
  const external = d.connections.length - web.length;
  const webCounts = web.reduce<Record<string, number>>(
    (acc, c) => ((acc[c.status] = (acc[c.status] ?? 0) + 1), acc),
    {},
  );
  const connected = webCounts.CONNECTED ?? 0;
  const disconnected =
    (webCounts.DISCONNECTED ?? 0) + (webCounts.ATTENTION ?? 0) + (webCounts.NEEDS_REPAIR ?? 0);
  const awaiting = (webCounts.NOT_CONFIGURED ?? 0) + (webCounts.AWAITING_CONNECTION ?? 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Visão geral do MultiZap, atualizada automaticamente."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Instâncias"
          value={`${d.accounts.total}/${d.accounts.limit}`}
          icon={Smartphone}
          hint={
            external
              ? `${external} aparelho(s) externo(s) cadastrado(s)`
              : 'Dispositivos e aparelhos cadastrados'
          }
        />
        <StatCard
          label="Conectadas"
          value={connected}
          icon={PlugZap}
          tone="success"
          hint="Sessões ativas agora"
        />
        <StatCard
          label="Desconectadas"
          value={disconnected}
          icon={Unplug}
          tone={disconnected ? 'warning' : 'neutral'}
          hint="Inclui atenção e novo pareamento"
        />
        <StatCard
          label="Aguardando configuração"
          value={awaiting}
          icon={Clock}
          tone="info"
          hint="Ainda não pareadas"
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Contatos"
          value={formatNumber(d.contacts.total)}
          icon={Users}
          tone="neutral"
          hint="Em todas as instâncias"
        />
        <StatCard
          label="Com consentimento"
          value={formatNumber(d.contacts.consented)}
          icon={ShieldCheck}
          tone="neutral"
          hint="Autorizados e não descadastrados"
        />
        <StatCard
          label="Campanhas criadas"
          value={formatNumber(d.campaigns.total)}
          icon={Megaphone}
          tone="neutral"
          hint="Módulo na Fase 6"
        />
        <StatCard
          label="Campanhas agendadas"
          value={formatNumber(d.campaigns.scheduled)}
          icon={CalendarClock}
          tone="neutral"
        />
        <StatCard
          label="Campanhas concluídas"
          value={formatNumber(d.campaigns.completed)}
          icon={CheckCircle2}
          tone="neutral"
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Saúde das conexões</CardTitle>
              <CardDescription>Estado de cada instância, informado pelo gateway.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/conexoes">Gerenciar</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {d.connections.length === 0 ? (
              <EmptyState
                icon={Smartphone}
                title="Nenhuma instância cadastrada"
                description="Cadastre e conecte suas contas WhatsApp."
                action={
                  <Button asChild size="sm">
                    <Link href="/conexoes">Ir para Conexões</Link>
                  </Button>
                }
              />
            ) : (
              <>
                <StatusDistribution counts={webCounts} total={web.length} />
                <ul className="mt-5 divide-y divide-border">
                  {d.connections.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/conexoes/${c.id}`}
                        className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-surface-2/60"
                      >
                        <StatusDot
                          tone={
                            c.connectionType === 'EXTERNAL_DEVICE'
                              ? 'neutral'
                              : DOT_TONE[STATUS_TONE[c.status]]
                          }
                          pulse={c.status === 'CONNECTED'}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-fg">{c.name}</p>
                          <p className="truncate text-xs text-subtle">{formatPhone(c.phoneE164)}</p>
                        </div>
                        <span className="hidden text-xs text-subtle md:block">
                          {c.connectionType === 'WHATSAPP_WEB'
                            ? `Atividade ${timeAgo(c.lastActivityAt)}`
                            : ''}
                        </span>
                        <AccountStatusBadge account={c} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Alertas do sistema</CardTitle>
                <CardDescription>Problemas que exigem atenção.</CardDescription>
              </div>
              <BellRing className="h-4 w-4 text-subtle" aria-hidden />
            </CardHeader>
            <CardContent>
              {d.alerts.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> Nenhum alerta ativo.
                </p>
              ) : (
                <ul className="space-y-3">
                  {d.alerts.map((a) => (
                    <li key={a.id} className="rounded-lg border border-border bg-bg-soft p-3">
                      <div className="flex items-center justify-between gap-2">
                        <SeverityBadge severity={a.severity} />
                        <span className="text-[11px] text-subtle">{timeAgo(a.createdAt)}</span>
                      </div>
                      <p className="mt-1.5 text-sm font-medium text-fg">{a.title}</p>
                      <p className="mt-0.5 text-xs text-muted">{a.message}</p>
                      <div className="mt-2 flex gap-3 text-xs">
                        {a.accountId && (
                          <Link
                            href={`/conexoes/${a.accountId}`}
                            className="text-accent hover:underline"
                          >
                            Ver instância
                          </Link>
                        )}
                        {!a.readAt && (
                          <button
                            className="text-subtle hover:text-fg"
                            onClick={() => mark.mutate(a.id)}
                          >
                            Marcar como lido
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Atividades recentes</CardTitle>
                <CardDescription>Conexões, desconexões e alterações.</CardDescription>
              </div>
              <Activity className="h-4 w-4 text-subtle" aria-hidden />
            </CardHeader>
            <CardContent>
              {d.activity.length === 0 ? (
                <p className="text-sm text-subtle">Nenhuma atividade registrada ainda.</p>
              ) : (
                <ul className="space-y-3">
                  {d.activity.map((a) => (
                    <li key={a.id} className="flex gap-3 text-sm">
                      <span
                        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong"
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <p className="text-fg/90">
                          {a.message}
                          {a.accountName && <span className="text-muted"> · {a.accountName}</span>}
                        </p>
                        <p className="text-xs text-subtle">{timeAgo(a.createdAt)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
