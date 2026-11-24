'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Download, Minus, Table2 } from 'lucide-react';
import {
  CAMPAIGN_STATUS_LABEL,
  type CampaignStatusValue,
  type ReportDTO,
  type ReportTotals,
} from '@multizap/shared';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  PageHeader,
  Select,
  Spinner,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  cn,
} from '@multizap/ui';
import { api } from '@/lib/api';
import { useAccounts } from '@/lib/accounts';
import { toQueryString } from '@/lib/contacts';
import { formatNumber } from '@/lib/format';
import { LineChart } from '@/components/reports/line-chart';

/** Paleta categórica (modo escuro) validada para o fundo dos cards (#111820). */
const SERIES = [
  { key: 'sent', label: 'Enviadas', color: '#3987e5' },
  { key: 'delivered', label: 'Entregues', color: '#d95926' },
  { key: 'read', label: 'Lidas', color: '#199e70' },
  { key: 'received', label: 'Respostas', color: '#c98500' },
] as const;

const day = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
const shift = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmt = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR');
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function Delta({ now, prev }: { now: number; prev: number }) {
  if (prev === 0 && now === 0) return <span className="text-xs text-subtle">sem variação</span>;
  if (prev === 0) return <span className="text-xs text-subtle">sem dados no período anterior</span>;
  const d = ((now - prev) / prev) * 100;
  const Icon = d > 0 ? ArrowUpRight : d < 0 ? ArrowDownRight : Minus;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs text-muted"
      title={`Período anterior: ${formatNumber(prev)}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden /> {d > 0 ? '+' : ''}
      {d.toFixed(0)}% vs. anterior ({formatNumber(prev)})
    </span>
  );
}

function Kpi({
  label,
  value,
  prev,
  hint,
}: {
  label: string;
  value: number | null;
  prev?: number;
  hint?: string;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-4 shadow-card">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {value === null ? '—' : formatNumber(value)}
      </p>
      <div className="mt-1 min-h-4">
        {prev !== undefined && value !== null ? (
          <Delta now={value} prev={prev} />
        ) : (
          hint && <span className="text-xs text-subtle">{hint}</span>
        )}
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const today = day(new Date());
  const accounts = useAccounts();
  const [preset, setPreset] = useState('30');
  const [from, setFrom] = useState(shift(today, -29));
  const [to, setTo] = useState(today);
  const [accountId, setAccountId] = useState('');
  const [showTable, setShowTable] = useState(false);

  const applyPreset = (p: string) => {
    setPreset(p);
    if (p === 'month') {
      setFrom(`${today.slice(0, 8)}01`);
      setTo(today);
    } else if (p !== 'custom') {
      setFrom(shift(today, -(Number(p) - 1)));
      setTo(today);
    }
  };

  const query = { from, to, accountId: accountId || undefined };
  const report = useQuery({
    queryKey: ['report', query],
    queryFn: () => api<ReportDTO>(`/reports/summary?${toQueryString(query)}`),
    enabled: from <= to,
    refetchInterval: 60_000,
  });
  const d = report.data;
  const t = d?.totals;
  const p = d?.previous;

  const series = useMemo(
    () => (d ? SERIES.map((s) => ({ ...s, values: d.series.map((pt) => pt[s.key]) })) : []),
    [d],
  );
  const hasMessages = d ? d.series.some((pt) => pt.sent || pt.received || pt.delivered) : false;
  const k = <K extends keyof ReportTotals>(key: K) => (t ? t[key] : null);

  return (
    <>
      <PageHeader
        title="Relatórios"
        description="Indicadores calculados a partir dos registros reais do MultiZap."
        actions={
          <>
            <a
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 text-sm hover:bg-surface-3"
              href={`/api/reports/export?${toQueryString({ ...query, format: 'csv' })}`}
              download
            >
              <Download className="h-4 w-4" aria-hidden /> CSV
            </a>
            <a
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 text-sm hover:bg-surface-3"
              href={`/api/reports/export?${toQueryString({ ...query, format: 'xlsx' })}`}
              download
            >
              <Download className="h-4 w-4" aria-hidden /> XLSX
            </a>
          </>
        }
      />

      <Card className="mb-6 flex flex-wrap items-end gap-3 p-4">
        <div className="flex flex-wrap gap-1">
          {[
            ['7', '7 dias'],
            ['30', '30 dias'],
            ['90', '90 dias'],
            ['month', 'Este mês'],
            ['custom', 'Personalizado'],
          ].map(([v, l]) => (
            <button
              key={v}
              onClick={() => applyPreset(v!)}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-xs',
                preset === v ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {l}
            </button>
          ))}
        </div>
        <label className="text-xs text-muted">
          De
          <Input
            type="date"
            value={from}
            max={to}
            onChange={(e) => {
              setPreset('custom');
              setFrom(e.target.value);
            }}
            className="mt-1 h-9 w-40"
          />
        </label>
        <label className="text-xs text-muted">
          Até
          <Input
            type="date"
            value={to}
            min={from}
            max={today}
            onChange={(e) => {
              setPreset('custom');
              setTo(e.target.value);
            }}
            className="mt-1 h-9 w-40"
          />
        </label>
        <label className="text-xs text-muted">
          Instância
          <Select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="mt-1 h-9 w-52"
          >
            <option value="">Todas</option>
            {accounts.data?.items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </label>
        {d && (
          <p className="ml-auto text-xs text-subtle">
            Comparando com {fmt(d.previousRange.from)} – {fmt(d.previousRange.to)} · fuso{' '}
            {d.timezone}
          </p>
        )}
      </Card>

      {report.isError && <Alert tone="danger">{report.error.message}</Alert>}
      {report.isPending && (
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      )}

      {d && t && p && (
        <div className="space-y-6">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Contatos</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <Kpi
                label="Contatos na base (hoje)"
                value={d.snapshot.contacts}
                hint="Situação atual"
              />
              <Kpi
                label="Autorizados (hoje)"
                value={d.snapshot.authorized}
                hint={`${pct(d.snapshot.authorized, d.snapshot.contacts)} da base`}
              />
              <Kpi
                label="Descadastrados (hoje)"
                value={d.snapshot.optedOut}
                hint={`${pct(d.snapshot.optedOut, d.snapshot.contacts)} da base`}
              />
              <Kpi
                label="Novos contatos no período"
                value={k('contactsCreated')}
                prev={p.contactsCreated}
              />
              <Kpi label="Descadastros no período" value={k('optOuts')} prev={p.optOuts} />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Campanhas e mensagens</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi
                label="Campanhas criadas"
                value={k('campaignsCreated')}
                prev={p.campaignsCreated}
              />
              <Kpi
                label="Campanhas concluídas"
                value={k('campaignsCompleted')}
                prev={p.campaignsCompleted}
              />
              <Kpi label="Mensagens enviadas" value={k('messagesSent')} prev={p.messagesSent} />
              <Kpi label="Entregues" value={k('messagesDelivered')} prev={p.messagesDelivered} />
              <Kpi label="Lidas" value={k('messagesRead')} prev={p.messagesRead} />
              <Kpi label="Falhas" value={k('messagesFailed')} prev={p.messagesFailed} />
              <Kpi
                label="Respostas recebidas"
                value={k('messagesReceived')}
                prev={p.messagesReceived}
              />
              <div className="rounded-card border border-border bg-surface p-4 shadow-card">
                <p className="text-xs font-medium text-muted">Taxas do período</p>
                <dl className="mt-2 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted">Entrega</dt>
                    <dd className="tabular-nums">{pct(t.messagesDelivered, t.messagesSent)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Leitura</dt>
                    <dd className="tabular-nums">{pct(t.messagesRead, t.messagesSent)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Falha</dt>
                    <dd className="tabular-nums">
                      {pct(t.messagesFailed, t.messagesSent + t.messagesFailed)}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </section>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Mensagens por dia</CardTitle>
                <CardDescription>
                  Entregues e lidas consideram as mensagens enviadas em cada dia. Respostas são
                  mensagens recebidas dos contatos.
                </CardDescription>
              </div>
              <button
                onClick={() => setShowTable((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                <Table2 className="h-3.5 w-3.5" /> {showTable ? 'Ver gráfico' : 'Ver tabela'}
              </button>
            </CardHeader>
            <CardContent>
              {!hasMessages ? (
                <p className="py-10 text-center text-sm text-subtle">
                  Nenhuma mensagem registrada neste período.
                </p>
              ) : showTable ? (
                <div className="max-h-96 overflow-y-auto">
                  <Table>
                    <THead>
                      <tr>
                        <TH>Data</TH>
                        {SERIES.map((s) => (
                          <TH key={s.key} className="text-right">
                            {s.label}
                          </TH>
                        ))}
                        <TH className="text-right">Falhas</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {d.series.map((pt) => (
                        <TR key={pt.date}>
                          <TD>{fmt(pt.date)}</TD>
                          {SERIES.map((s) => (
                            <TD key={s.key} className="text-right tabular-nums">
                              {formatNumber(pt[s.key])}
                            </TD>
                          ))}
                          <TD className="text-right tabular-nums">{formatNumber(pt.failed)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              ) : (
                <LineChart dates={d.series.map((pt) => pt.date)} series={series} />
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 2xl:grid-cols-2 [&>*]:min-w-0">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Por instância</CardTitle>
                  <CardDescription>Totais do período em cada instância.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <THead>
                    <tr>
                      <TH>Instância</TH>
                      <TH className="text-right">Novos contatos</TH>
                      <TH className="text-right">Enviadas</TH>
                      <TH className="text-right">Entregues</TH>
                      <TH className="text-right">Lidas</TH>
                      <TH className="text-right">Falhas</TH>
                      <TH className="text-right">Respostas</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {d.byAccount.map((a) => (
                      <TR key={a.accountId}>
                        <TD className="font-medium">{a.accountName}</TD>
                        <TD className="text-right tabular-nums">
                          {formatNumber(a.contactsCreated)}
                        </TD>
                        <TD className="text-right tabular-nums">{formatNumber(a.messagesSent)}</TD>
                        <TD className="text-right tabular-nums">
                          {formatNumber(a.messagesDelivered)}
                        </TD>
                        <TD className="text-right tabular-nums">{formatNumber(a.messagesRead)}</TD>
                        <TD className="text-right tabular-nums">
                          {formatNumber(a.messagesFailed)}
                        </TD>
                        <TD className="text-right tabular-nums">
                          {formatNumber(a.messagesReceived)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Campanhas com envios no período</CardTitle>
                  <CardDescription>
                    Respostas: o contato escreveu até 7 dias após receber a campanha.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {d.campaigns.length === 0 ? (
                  <p className="py-6 text-center text-sm text-subtle">
                    Nenhuma campanha com envios neste período.
                  </p>
                ) : (
                  <Table>
                    <THead>
                      <tr>
                        <TH>Campanha</TH>
                        <TH className="text-right">Enviadas</TH>
                        <TH className="text-right">Entrega</TH>
                        <TH className="text-right">Leitura</TH>
                        <TH className="text-right">Respostas</TH>
                        <TH className="text-right">Falhas</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {d.campaigns.map((c) => (
                        <TR key={c.id}>
                          <TD>
                            <Link
                              href={`/campanhas/${c.id}`}
                              className="font-medium hover:text-accent"
                            >
                              {c.name}
                            </Link>
                            <span className="block text-xs text-subtle">
                              {CAMPAIGN_STATUS_LABEL[c.status as CampaignStatusValue] ?? c.status} ·{' '}
                              {formatNumber(c.recipients)} destinatário(s)
                            </span>
                          </TD>
                          <TD className="text-right tabular-nums">{formatNumber(c.sent)}</TD>
                          <TD className="text-right tabular-nums">{pct(c.delivered, c.sent)}</TD>
                          <TD className="text-right tabular-nums">{pct(c.read, c.sent)}</TD>
                          <TD className="text-right tabular-nums">
                            {formatNumber(c.replied)}{' '}
                            <span className="text-xs text-subtle">({pct(c.replied, c.sent)})</span>
                          </TD>
                          <TD className="text-right tabular-nums">{formatNumber(c.failed)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
