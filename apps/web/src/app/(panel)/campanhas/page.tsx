'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Megaphone, Plus } from 'lucide-react';
import { CAMPAIGN_STATUS_LABEL, type CampaignDTO } from '@multizap/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Segmented,
  Spinner,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  cn,
} from '@multizap/ui';
import { CAMPAIGN_TONE, useCampaigns } from '@/lib/campaigns';
import { formatDateTime, formatNumber } from '@/lib/format';

const TABS = [
  { value: '', label: 'Todas' },
  { value: 'DRAFT', label: 'Rascunhos' },
  { value: 'SCHEDULED', label: 'Agendadas' },
  { value: 'READY,RUNNING,PAUSED', label: 'Em andamento' },
  { value: 'COMPLETED,CANCELLED', label: 'Encerradas' },
];

function Progress({ c }: { c: CampaignDTO }) {
  const done =
    c.counters.sent +
    c.counters.delivered +
    c.counters.read +
    c.counters.failed +
    c.counters.skipped;
  const pct = c.counters.total ? Math.round((done / c.counters.total) * 100) : 0;
  if (!c.counters.total) return <span className="text-xs text-subtle">—</span>;
  return (
    <div className="w-40">
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[11px] tabular-nums text-subtle">
        {formatNumber(done)} / {formatNumber(c.counters.total)}
      </p>
    </div>
  );
}

function Calendar({ campaigns }: { campaigns: CampaignDTO[] }) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const days = useMemo(() => {
    const start = new Date(month);
    start.setDate(1 - start.getDay());
    return Array.from(
      { length: 42 },
      (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    );
  }, [month]);
  const byDay = (d: Date) =>
    campaigns.filter(
      (c) => c.scheduledAt && new Date(c.scheduledAt).toDateString() === d.toDateString(),
    );
  const today = new Date().toDateString();
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold capitalize">
          {month.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
        </p>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Mês anterior"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Próximo mês"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d) => (
          <div key={d} className="bg-surface-2 px-2 py-1.5 text-subtle">
            {d}
          </div>
        ))}
        {days.map((d) => (
          <div
            key={d.toISOString()}
            className={cn(
              'min-h-24 bg-surface p-1.5',
              d.getMonth() !== month.getMonth() && 'opacity-40',
            )}
          >
            <p
              className={cn(
                'mb-1 text-[11px] tabular-nums',
                d.toDateString() === today ? 'font-bold text-accent' : 'text-subtle',
              )}
            >
              {d.getDate()}
            </p>
            {byDay(d).map((c) => (
              <Link
                key={c.id}
                href={`/campanhas/${c.id}`}
                className="mb-1 block truncate rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-fg hover:bg-accent/25"
                title={`${c.name} · ${CAMPAIGN_STATUS_LABEL[c.status]}`}
              >
                {new Date(c.scheduledAt!).toLocaleTimeString('pt-BR', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                {c.name}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-subtle">
        No horário agendado a fila é montada; os envios continuam dependendo da sua confirmação.
      </p>
    </Card>
  );
}

export default function CampaignsPage() {
  const [tab, setTab] = useState('');
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const campaigns = useCampaigns(view === 'calendar' ? {} : { status: tab || undefined });

  return (
    <>
      <PageHeader
        title="Campanhas"
        description="Campanhas assistidas: o sistema prepara a fila e você confirma cada envio."
        actions={
          <>
            <Segmented<'list' | 'calendar'>
              value={view}
              onChange={setView}
              options={[
                { value: 'list', label: 'Lista' },
                { value: 'calendar', label: 'Calendário' },
              ]}
            />
            <Button asChild>
              <Link href="/campanhas/nova">
                <Plus className="h-4 w-4" aria-hidden /> Nova campanha
              </Link>
            </Button>
          </>
        }
      />
      {campaigns.isPending && (
        <div className="grid place-items-center py-20">
          <Spinner />
        </div>
      )}
      {view === 'calendar' && campaigns.data && <Calendar campaigns={campaigns.data} />}
      {view === 'list' && (
        <>
          <div className="mb-4 flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button
                key={t.value}
                onClick={() => setTab(t.value)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs',
                  tab === t.value ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {campaigns.data?.length === 0 ? (
            <Card>
              <EmptyState
                icon={Megaphone}
                title="Nenhuma campanha"
                description="Crie uma campanha para preparar envios assistidos às suas bases autorizadas."
                action={
                  <Button asChild>
                    <Link href="/campanhas/nova">Nova campanha</Link>
                  </Button>
                }
              />
            </Card>
          ) : (
            campaigns.data && (
              <Table>
                <THead>
                  <tr>
                    <TH>Campanha</TH>
                    <TH>Situação</TH>
                    <TH>Instâncias</TH>
                    <TH>Progresso</TH>
                    <TH>Agendada para</TH>
                  </tr>
                </THead>
                <TBody>
                  {campaigns.data.map((c) => (
                    <TR key={c.id}>
                      <TD>
                        <Link
                          href={`/campanhas/${c.id}`}
                          className="font-medium text-fg hover:text-accent"
                        >
                          {c.name}
                        </Link>
                      </TD>
                      <TD>
                        <Badge tone={CAMPAIGN_TONE[c.status]} dot>
                          {CAMPAIGN_STATUS_LABEL[c.status]}
                        </Badge>
                      </TD>
                      <TD className="text-muted">
                        {c.accounts.map((a) => a.accountName).join(', ')}
                      </TD>
                      <TD>
                        <Progress c={c} />
                      </TD>
                      <TD className="text-muted">
                        {c.scheduledAt ? formatDateTime(c.scheduledAt) : '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )
          )}
        </>
      )}
    </>
  );
}
