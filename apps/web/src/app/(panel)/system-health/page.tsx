'use client';
import { useState } from 'react';
import Link from 'next/link';
import {
  Archive,
  BellRing,
  Check,
  Cpu,
  Database,
  HardDrive,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Server,
  Smartphone,
  Sparkles,
  Zap,
} from 'lucide-react';
import {
  ACCOUNT_STATUS_LABEL,
  STATUS_REASON_LABEL,
  type AccountStatusValue,
  type BackupDTO,
  type ServiceCheck,
  type SystemStatusDTO,
} from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatusDot,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  cn,
  type Tone,
} from '@multizap/ui';
import { useNotifications } from '@/lib/dashboard';
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format';
import {
  useRequestBackup,
  useResolveNotification,
  useSetOperations,
  useSystemEvents,
  useSystemStatus,
} from '@/lib/system';

const statusView: Record<
  ServiceCheck['status'],
  { tone: 'success' | 'danger' | 'neutral'; label: string }
> = {
  up: { tone: 'success', label: 'Operacional' },
  down: { tone: 'danger', label: 'Indisponível' },
  unconfigured: { tone: 'neutral', label: 'Não verificável' },
};

const SERVICES = [
  { key: 'api', label: 'API', icon: Server },
  { key: 'database', label: 'PostgreSQL', icon: Database },
  { key: 'redis', label: 'Redis', icon: Zap },
  { key: 'storage', label: 'Armazenamento', icon: HardDrive },
  { key: 'worker', label: 'Worker', icon: Cpu },
  { key: 'gateway', label: 'Gateway WhatsApp', icon: Smartphone },
] as const;

const BACKUP_STATUS: Record<BackupDTO['status'], { tone: Tone; label: string }> = {
  QUEUED: { tone: 'info', label: 'Na fila' },
  RUNNING: { tone: 'info', label: 'Em andamento' },
  COMPLETED: { tone: 'success', label: 'Concluído' },
  FAILED: { tone: 'danger', label: 'Falhou' },
  CANCELLED: { tone: 'neutral', label: 'Cancelado' },
};

const SEVERITY: Record<string, { tone: Tone; label: string }> = {
  CRITICAL: { tone: 'danger', label: 'Crítico' },
  ERROR: { tone: 'danger', label: 'Erro' },
  WARNING: { tone: 'warning', label: 'Aviso' },
  INFO: { tone: 'info', label: 'Info' },
};

const LEVEL: Record<string, { tone: Tone; label: string }> = {
  error: { tone: 'danger', label: 'Erro' },
  warn: { tone: 'warning', label: 'Aviso' },
  info: { tone: 'neutral', label: 'Info' },
};

const SOURCE_LABEL: Record<string, string> = { api: 'API', worker: 'Worker', gateway: 'Gateway' };

function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function duration(b: BackupDTO): string {
  if (!b.startedAt || !b.finishedAt) return '—';
  const s = Math.round((Date.parse(b.finishedAt) - Date.parse(b.startedAt)) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export default function SystemHealthPage() {
  const status = useSystemStatus();
  const d = status.data;

  return (
    <>
      <PageHeader
        title="System Health"
        description="Estado real dos serviços, filas, conexões, erros e backups. Atualizado a cada 15 segundos."
        actions={
          <>
            {d && (
              <span className="text-xs text-subtle">
                Verificado às {new Date(d.checkedAt).toLocaleTimeString('pt-BR')}
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void status.refetch()}
              loading={status.isFetching}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Atualizar
            </Button>
          </>
        }
      />

      {status.isError && (
        <Alert tone="danger" title="A API não respondeu" className="mb-6">
          {status.error.message}
        </Alert>
      )}
      {status.isPending && (
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      )}

      {d && (
        <div className="space-y-6">
          <PauseCard operations={d.operations} />

          <section
            aria-label="Serviços"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6"
          >
            {SERVICES.map((s) => (
              <ServiceCard key={s.key} label={s.label} icon={s.icon} check={d.services[s.key]} />
            ))}
          </section>

          <div className="grid gap-6 xl:grid-cols-5 [&>*]:min-w-0">
            <QueuesCard queues={d.queues} redisUp={d.services.redis.status === 'up'} />
            <ConnectionsCard connections={d.connections} />
          </div>

          <div className="grid gap-6 xl:grid-cols-2 [&>*]:min-w-0">
            <ErrorsCard errors={d.errors24h} />
            <NotificationsCard counts={d.notifications} />
          </div>

          <div className="grid gap-6 xl:grid-cols-3 [&>*]:min-w-0">
            <div className="xl:col-span-2">
              <BackupsCard backups={d.backups} />
            </div>
            <CleanupCard cleanup={d.cleanup} />
          </div>

          <EventsCard />
        </div>
      )}
    </>
  );
}

function ServiceCard({
  label,
  icon: Icon,
  check,
}: {
  label: string;
  icon: typeof Server;
  check: ServiceCheck;
}) {
  const view = statusView[check.status];
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <span className="grid h-9 w-9 place-items-center rounded-lg border border-border bg-surface-2 text-muted">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <StatusDot tone={view.tone} pulse={check.status === 'up'} />
      </div>
      <p className="mt-4 text-sm font-medium text-fg">{label}</p>
      <p className="mt-1 text-xs text-muted">
        {view.label}
        {check.latencyMs !== undefined && ` · ${check.latencyMs} ms`}
      </p>
      {(check.error || check.detail) && (
        <p className="mt-2 text-xs text-subtle">{check.error ?? check.detail}</p>
      )}
    </Card>
  );
}

function PauseCard({ operations }: { operations: SystemStatusDTO['operations'] }) {
  const set = useSetOperations();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const paused = operations.paused;

  return (
    <Card
      className={cn(
        'flex flex-wrap items-center gap-4 p-5',
        paused && 'border-warning/40 bg-warning-soft',
      )}
    >
      <span
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
          paused ? 'bg-warning/15 text-warning' : 'bg-success-soft text-success',
        )}
      >
        {paused ? (
          <PauseCircle className="h-5 w-5" aria-hidden />
        ) : (
          <PlayCircle className="h-5 w-5" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg">
          {paused ? 'Operações pausadas' : 'Operações ativas'}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {paused
            ? `Pausadas ${operations.at ? timeAgo(operations.at) : ''}${operations.by ? ` por ${operations.by}` : ''}${operations.reason ? ` · Motivo: ${operations.reason}` : ''}`
            : 'A pausa global suspende envios de campanha, respostas pela Central e o início de campanhas agendadas.'}
        </p>
      </div>
      {set.isError && <Alert tone="danger">{set.error.message}</Alert>}
      {paused ? (
        <Button onClick={() => set.mutate({ paused: false })} loading={set.isPending}>
          <PlayCircle className="h-4 w-4" aria-hidden /> Retomar operações
        </Button>
      ) : (
        <Button variant="danger" onClick={() => setOpen(true)}>
          <PauseCircle className="h-4 w-4" aria-hidden /> Pausar operações
        </Button>
      )}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Pausar todas as operações?"
        description="Use em emergências, como uma restrição em um número ou um erro em campanha."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              loading={set.isPending}
              onClick={() =>
                set.mutate(
                  { paused: true, reason: reason.trim() || undefined },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      setReason('');
                    },
                  },
                )
              }
            >
              Pausar agora
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Fica suspenso</p>
              <ul className="list-disc space-y-0.5 pl-4 text-fg/90">
                <li>Envios de campanha</li>
                <li>Respostas pela Central</li>
                <li>Início de campanhas agendadas</li>
              </ul>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Continua funcionando</p>
              <ul className="list-disc space-y-0.5 pl-4 text-fg/90">
                <li>Conexões e recebimento</li>
                <li>Importações e ferramentas</li>
                <li>Relatórios e backups</li>
              </ul>
            </div>
          </div>
          <label className="block text-xs font-medium text-muted">
            Motivo (opcional, aparece para quem acessar o painel)
            <Input
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1"
              placeholder="Ex.: número em análise"
            />
          </label>
        </div>
      </Modal>
    </Card>
  );
}

function QueuesCard({ queues, redisUp }: { queues: SystemStatusDTO['queues']; redisUp: boolean }) {
  return (
    <Card className="xl:col-span-3">
      <CardHeader>
        <div>
          <CardTitle>Filas</CardTitle>
          <CardDescription>
            Trabalhos em segundo plano (BullMQ). Falhas ficam guardadas para análise.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {!redisUp ? (
          <p className="py-6 text-center text-sm text-subtle">
            Sem acesso ao Redis: filas não verificáveis.
          </p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Fila</TH>
                <TH className="text-right">Aguardando</TH>
                <TH className="text-right">Executando</TH>
                <TH className="text-right">Agendados</TH>
                <TH className="text-right">Falhas</TH>
              </tr>
            </THead>
            <TBody>
              {queues.map((q) => (
                <TR key={q.name}>
                  <TD>
                    <span className="whitespace-nowrap font-medium">{q.label}</span>
                    <span className="block font-mono text-[11px] text-subtle">{q.name}</span>
                  </TD>
                  <TD className="text-right tabular-nums">{formatNumber(q.waiting)}</TD>
                  <TD className="text-right tabular-nums">{formatNumber(q.active)}</TD>
                  <TD className="text-right tabular-nums">{formatNumber(q.delayed)}</TD>
                  <TD className={cn('text-right tabular-nums', q.failed > 0 && 'text-danger')}>
                    {formatNumber(q.failed)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectionsCard({ connections }: { connections: SystemStatusDTO['connections'] }) {
  const entries = Object.entries(connections.byStatus).sort((a, b) => b[1] - a[1]);
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Conexões</CardTitle>
          <CardDescription>
            {connections.total} instância(s) cadastrada(s).{' '}
            <Link href="/conexoes" className="text-accent hover:underline">
              Abrir Conexões
            </Link>
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {entries.length === 0 ? (
          <p className="text-sm text-subtle">Nenhuma instância cadastrada.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {entries.map(([s, n]) => (
              <Badge
                key={s}
                tone={
                  s === 'CONNECTED'
                    ? 'success'
                    : ['ATTENTION', 'NEEDS_REPAIR'].includes(s)
                      ? 'danger'
                      : s === 'DISCONNECTED'
                        ? 'warning'
                        : 'neutral'
                }
              >
                {ACCOUNT_STATUS_LABEL[s as AccountStatusValue] ?? s}: {n}
              </Badge>
            ))}
          </div>
        )}
        {connections.attention.length === 0 ? (
          entries.length > 0 && (
            <p className="flex items-center gap-1.5 text-sm text-muted">
              <Check className="h-4 w-4 text-success" aria-hidden /> Nenhuma instância ativa com
              problema.
            </p>
          )
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {connections.attention.map((a) => (
              <li key={a.id} className="p-3">
                <div className="flex items-center justify-between gap-3">
                  <Link
                    href={`/conexoes/${a.id}`}
                    className="text-sm font-medium hover:text-accent"
                  >
                    {a.name}
                  </Link>
                  <Badge tone={a.status === 'DISCONNECTED' ? 'warning' : 'danger'}>
                    {ACCOUNT_STATUS_LABEL[a.status as AccountStatusValue] ?? a.status}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {(a.reason && STATUS_REASON_LABEL[a.reason]) ||
                    a.lastError ||
                    'Sem detalhes registrados.'}
                </p>
                {a.lastCheckAt && (
                  <p className="mt-0.5 text-[11px] text-subtle">
                    Última verificação {timeAgo(a.lastCheckAt)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ErrorsCard({ errors }: { errors: SystemStatusDTO['errors24h'] }) {
  const items = [
    ['Erros registrados', errors.systemEvents],
    ['Importações com falha', errors.importsFailed],
    ['Ferramentas com falha', errors.toolJobsFailed],
    ['Envios de campanha com falha', errors.campaignSendsFailed],
    ['Respostas com falha', errors.repliesFailed],
    ['Backups com falha', errors.backupsFailed],
  ] as const;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Erros nas últimas 24 horas</CardTitle>
          <CardDescription>Contados a partir dos registros do sistema.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map(([label, n]) => (
            <div key={label} className="rounded-lg border border-border bg-surface-2/40 p-3">
              <dt className="text-xs text-muted">{label}</dt>
              <dd
                className={cn(
                  'mt-1 text-xl font-semibold tabular-nums',
                  n > 0 ? 'text-danger' : 'text-fg',
                )}
              >
                {formatNumber(n)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function NotificationsCard({ counts }: { counts: SystemStatusDTO['notifications'] }) {
  const list = useNotifications();
  const resolve = useResolveNotification();
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Notificações abertas</CardTitle>
          <CardDescription>
            {counts.open === 0
              ? 'Nenhum problema pendente.'
              : `${counts.open} aberta(s)${[
                  [counts.critical, 'crítica(s)'],
                  [counts.error, 'erro(s)'],
                  [counts.warning, 'aviso(s)'],
                ]
                  .filter(([n]) => (n as number) > 0)
                  .map(([n, l]) => `${n} ${l}`)
                  .reduce(
                    (acc, x, i) => acc + (i ? ', ' : ': ') + x,
                    '',
                  )}. As automáticas se resolvem sozinhas quando o problema some.`}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {resolve.isError && (
          <Alert tone="danger" className="mb-3">
            {resolve.error.message}
          </Alert>
        )}
        {list.data && list.data.items.length > 0 ? (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto">
            {list.data.items.map((n) => (
              <li key={n.id} className="flex items-start gap-3 py-3">
                <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={SEVERITY[n.severity]?.tone ?? 'neutral'}>
                      {SEVERITY[n.severity]?.label ?? n.severity}
                    </Badge>
                    <p className="text-sm font-medium">{n.title}</p>
                  </div>
                  <p className="mt-1 text-xs text-muted">{n.message}</p>
                  <p className="mt-0.5 text-[11px] text-subtle">{formatDateTime(n.createdAt)}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => resolve.mutate(n.id)}
                  disabled={resolve.isPending}
                >
                  Resolver
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          !list.isPending && (
            <p className="flex items-center gap-1.5 text-sm text-muted">
              <Check className="h-4 w-4 text-success" aria-hidden /> Tudo em ordem.
            </p>
          )
        )}
      </CardContent>
    </Card>
  );
}

function BackupsCard({ backups }: { backups: SystemStatusDTO['backups'] }) {
  const request = useRequestBackup();
  const storageView = statusView[backups.storage.status];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Backups</CardTitle>
          <CardDescription>
            Banco de dados e arquivos, criptografados, em um bucket separado do principal.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => request.mutate()}
          loading={request.isPending}
          disabled={!backups.configured || backups.running}
          title={
            !backups.configured
              ? 'Configure o bucket de backup no worker'
              : backups.running
                ? 'Já existe um backup em andamento'
                : undefined
          }
        >
          <Archive className="h-3.5 w-3.5" aria-hidden /> Fazer backup agora
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {request.isError && <Alert tone="danger">{request.error.message}</Alert>}
        {!backups.configured && (
          <Alert tone="warning" title="Backups desativados">
            {backups.storage.error ?? 'Bucket de backup não configurado.'} Defina BACKUP_S3_* e
            BACKUP_ENCRYPTION_KEY no serviço multizap-worker (veja docs/DEPLOY.md).
          </Alert>
        )}
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Bucket de backup</dt>
            <dd className="mt-1 flex items-center gap-1.5">
              <StatusDot tone={storageView.tone} /> {storageView.label}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Automático</dt>
            <dd className="mt-1">
              {backups.hourLocal !== null
                ? `Diário às ${String(backups.hourLocal).padStart(2, '0')}:00`
                : '—'}
              {backups.retentionDays !== null && (
                <span className="block text-xs text-subtle">
                  Retenção de {backups.retentionDays} dias
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Próximo</dt>
            <dd className="mt-1">{formatDateTime(backups.nextAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Último concluído</dt>
            <dd className="mt-1">
              {backups.lastSuccessAt ? timeAgo(backups.lastSuccessAt) : 'nunca'}
            </dd>
          </div>
        </dl>
        {backups.items.length > 0 && (
          <Table>
            <THead>
              <tr>
                <TH>Início</TH>
                <TH>Origem</TH>
                <TH>Situação</TH>
                <TH className="text-right">Tamanho</TH>
                <TH className="text-right">Duração</TH>
              </tr>
            </THead>
            <TBody>
              {backups.items.map((b) => (
                <TR key={b.id}>
                  <TD className="whitespace-nowrap">{formatDateTime(b.createdAt)}</TD>
                  <TD>{b.trigger === 'manual' ? 'Manual' : 'Automático'}</TD>
                  <TD>
                    <Badge tone={BACKUP_STATUS[b.status].tone}>
                      {BACKUP_STATUS[b.status].label}
                    </Badge>
                    {b.error && (
                      <span className="mt-1 block max-w-xs text-xs text-danger">{b.error}</span>
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">{formatBytes(b.sizeBytes)}</TD>
                  <TD className="text-right tabular-nums">{duration(b)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <p className="text-xs text-subtle">
          A restauração é feita pelo administrador na linha de comando do worker (
          <code className="font-mono">node dist/restore.js</code>
          ), em um banco com as migrations aplicadas. O passo a passo está em docs/DEPLOY.md.
        </p>
      </CardContent>
    </Card>
  );
}

function CleanupCard({ cleanup }: { cleanup: SystemStatusDTO['cleanup'] }) {
  const rows = cleanup
    ? ([
        ['Resultados de ferramentas expirados', cleanup.toolJobsExpired],
        ['Uploads sem uso removidos', cleanup.orphanUploadsRemoved],
        ['Arquivos de importação expirados', cleanup.importFilesRemoved],
        ['Sessões encerradas removidas', cleanup.sessionsRemoved],
        ['Eventos antigos removidos', cleanup.eventsRemoved],
        ['Notificações antigas removidas', cleanup.notificationsRemoved],
      ] as const)
    : [];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Limpeza automática</CardTitle>
          <CardDescription>
            A cada 6 horas. Contatos, conversas, campanhas, criativos e auditoria nunca são
            removidos.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {!cleanup ? (
          <p className="flex items-center gap-1.5 text-sm text-subtle">
            <Sparkles className="h-4 w-4" aria-hidden /> Ainda não executada (roda 5 minutos após o
            worker iniciar).
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">Última execução {timeAgo(cleanup.at)}</p>
            <dl className="space-y-1.5 text-sm">
              {rows.map(([label, n]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-muted">{label}</dt>
                  <dd className="tabular-nums">{formatNumber(n)}</dd>
                </div>
              ))}
            </dl>
            {cleanup.errors.length > 0 && (
              <Alert
                tone="warning"
                className="mt-3"
                title={`${cleanup.errors.length} arquivo(s) não puderam ser removidos`}
              >
                {cleanup.errors.slice(0, 3).join('; ')}
              </Alert>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EventsCard() {
  const [level, setLevel] = useState('');
  const [page, setPage] = useState(1);
  const events = useSystemEvents({ level: level || undefined, page });
  const pages = events.data ? Math.max(1, Math.ceil(events.data.total / 15)) : 1;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Eventos do sistema</CardTitle>
          <CardDescription>
            Falhas e ações operacionais registradas pela API, worker e gateway (30 dias).
          </CardDescription>
        </div>
        <Select
          aria-label="Filtrar por nível"
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            setPage(1);
          }}
          className="h-8 w-36 text-xs"
        >
          <option value="">Todos os níveis</option>
          <option value="error">Erros</option>
          <option value="warn">Avisos</option>
          <option value="info">Informativos</option>
        </Select>
      </CardHeader>
      <CardContent>
        {events.isError && <Alert tone="danger">{events.error.message}</Alert>}
        {events.data && events.data.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-subtle">Nenhum evento registrado.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Quando</TH>
                <TH>Nível</TH>
                <TH>Origem</TH>
                <TH>Mensagem</TH>
              </tr>
            </THead>
            <TBody>
              {events.data?.items.map((e) => (
                <TR key={e.id}>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(e.createdAt)}</TD>
                  <TD>
                    <Badge tone={LEVEL[e.level]?.tone ?? 'neutral'}>
                      {LEVEL[e.level]?.label ?? e.level}
                    </Badge>
                  </TD>
                  <TD className="text-xs">{SOURCE_LABEL[e.source] ?? e.source}</TD>
                  <TD className="text-sm">{e.message}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted">
            <Button
              size="sm"
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Anterior
            </Button>
            Página {page} de {pages}
            <Button
              size="sm"
              variant="ghost"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Próxima
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
