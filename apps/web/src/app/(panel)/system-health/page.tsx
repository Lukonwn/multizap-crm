'use client';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Database, RefreshCw, Server, Smartphone, Zap } from 'lucide-react';
import { Badge, Button, Card, PageHeader, StatusDot } from '@multizap/ui';
import { api } from '@/lib/api';

type Check = { status: 'up' | 'down' | 'unconfigured'; latencyMs?: number; error?: string };
type Ready = {
  status: 'ready' | 'degraded';
  checks: Record<'database' | 'redis' | 'worker' | 'gateway', Check>;
};

const SERVICES = [
  { key: 'database', label: 'PostgreSQL', icon: Database },
  { key: 'redis', label: 'Redis', icon: Zap },
  { key: 'worker', label: 'Worker', icon: Cpu },
  { key: 'gateway', label: 'Gateway WhatsApp', icon: Smartphone },
] as const;

const statusView = {
  up: { tone: 'success' as const, label: 'Operacional' },
  down: { tone: 'danger' as const, label: 'Indisponível' },
  unconfigured: { tone: 'neutral' as const, label: 'Não verificável' },
};

/**
 * Fase 1: estado real dos serviços a partir de /health/ready.
 * Filas, erros, backups e notificações chegam na Fase 9.
 */
export default function SystemHealthPage() {
  const ready = useQuery({
    queryKey: ['health', 'ready'],
    // 503 também traz o corpo com os checks; tratamos manualmente.
    queryFn: async (): Promise<Ready> => {
      const res = await fetch('/api/health/ready', { cache: 'no-store' });
      if (res.status !== 200 && res.status !== 503) throw new Error('API indisponível.');
      return (await res.json()) as Ready;
    },
    refetchInterval: 15_000,
  });
  const api_ = useQuery({
    queryKey: ['health', 'live'],
    queryFn: () => api<{ uptimeSeconds: number }>('/health'),
    refetchInterval: 15_000,
  });

  return (
    <>
      <PageHeader
        title="System Health"
        description="Estado dos serviços do MultiZap, atualizado a cada 15 segundos."
        actions={
          <>
            <Badge tone="warning" dot>
              Monitoramento completo na Fase 9
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void ready.refetch();
                void api_.refetch();
              }}
              loading={ready.isFetching}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Atualizar
            </Button>
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <ServiceCard
          label="API"
          icon={Server}
          check={
            api_.isError
              ? { status: 'down', error: api_.error.message }
              : api_.data
                ? { status: 'up' }
                : undefined
          }
          extra={api_.data ? `Ativa há ${Math.floor(api_.data.uptimeSeconds / 60)} min` : undefined}
        />
        {SERVICES.map((s) => (
          <ServiceCard
            key={s.key}
            label={s.label}
            icon={s.icon}
            check={
              ready.isError
                ? { status: 'unconfigured', error: 'Sem resposta da API.' }
                : ready.data?.checks[s.key]
            }
          />
        ))}
      </div>
    </>
  );
}

function ServiceCard({
  label,
  icon: Icon,
  check,
  extra,
}: {
  label: string;
  icon: typeof Server;
  check?: Check;
  extra?: string;
}) {
  const view = check ? statusView[check.status] : null;
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <span className="grid h-9 w-9 place-items-center rounded-lg border border-border bg-surface-2 text-muted">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        {view ? (
          <StatusDot tone={view.tone} pulse={check?.status === 'up'} />
        ) : (
          <StatusDot tone="neutral" />
        )}
      </div>
      <p className="mt-4 text-sm font-medium text-fg">{label}</p>
      <p className="mt-1 text-xs text-muted">
        {view ? view.label : 'Verificando...'}
        {check?.latencyMs !== undefined && ` · ${check.latencyMs} ms`}
      </p>
      {(check?.error || extra) && (
        <p className="mt-2 text-xs text-subtle">{check?.error ?? extra}</p>
      )}
    </Card>
  );
}
