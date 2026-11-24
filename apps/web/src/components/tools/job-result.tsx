'use client';
import { CheckCircle2, Download, FileArchive, FileSpreadsheet, XCircle } from 'lucide-react';
import { JOB_STATUS_LABEL, type ToolJobDTO } from '@multizap/shared';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
} from '@multizap/ui';
import { formatNumber } from '@/lib/format';
import { SUMMARY_LABELS } from '@/lib/tools';

/**
 * Distribuição (contagens por grupo): barras horizontais de série única,
 * rótulo + valor sempre visíveis em texto (identidade nunca só pela cor).
 */
function BarList({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <ul className="space-y-1.5">
      {entries.map(([label, value]) => (
        <li
          key={label}
          className="grid grid-cols-[minmax(120px,200px)_1fr_auto] items-center gap-3 text-xs"
          title={`${label}: ${formatNumber(value)}`}
        >
          <span className="truncate text-muted">{label}</span>
          <span className="h-2 rounded-r-[4px] bg-surface-3">
            <span
              className="block h-2 rounded-r-[4px] bg-accent"
              style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
            />
          </span>
          <span className="tabular-nums text-fg">{formatNumber(value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** O PostgreSQL (jsonb) não preserva a ordem das chaves: ordena pela ordem dos rótulos. */
const ORDER = Object.keys(SUMMARY_LABELS);
const byLabelOrder = ([a]: [string, unknown], [b]: [string, unknown]) =>
  (ORDER.indexOf(a) === -1 ? 999 : ORDER.indexOf(a)) -
  (ORDER.indexOf(b) === -1 ? 999 : ORDER.indexOf(b));

function SummaryView({ summary }: { summary: Record<string, unknown> }) {
  const scalars = Object.entries(summary)
    .sort(byLabelOrder)
    .filter(
      ([k, v]) =>
        (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') && k !== 'note',
    );
  const maps = Object.entries(summary)
    .sort(byLabelOrder)
    .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)) as [
    string,
    Record<string, number>,
  ][];
  const fmt = (v: unknown) =>
    typeof v === 'number'
      ? formatNumber(v)
      : typeof v === 'boolean'
        ? v
          ? 'Sim'
          : 'Não'
        : v === 'phone'
          ? 'Telefone'
          : v === 'row'
            ? 'Linha inteira'
            : String(v).toUpperCase();
  return (
    <div className="space-y-5">
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {scalars.map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border bg-bg-soft p-3">
            <dt className="text-xs text-muted">{SUMMARY_LABELS[k] ?? k}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-fg">{fmt(v)}</dd>
          </div>
        ))}
      </dl>
      {maps.map(([k, v]) =>
        Object.keys(v).length ? (
          <div key={k}>
            <p className="mb-2 text-xs font-medium text-muted">{SUMMARY_LABELS[k] ?? k}</p>
            <BarList data={v} />
          </div>
        ) : null,
      )}
      {typeof summary.note === 'string' && <Alert tone="info">{summary.note}</Alert>}
    </div>
  );
}

export function JobResult({ job }: { job: ToolJobDTO }) {
  const active = job.status === 'QUEUED' || job.status === 'RUNNING';
  return (
    <Card className="animate-slide-up">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            Resultado
            <Badge
              tone={
                job.status === 'COMPLETED' ? 'success' : job.status === 'FAILED' ? 'danger' : 'info'
              }
              dot
            >
              {JOB_STATUS_LABEL[job.status]}
            </Badge>
          </CardTitle>
          <CardDescription>{job.inputs.map((i) => i.name).join(' × ')}</CardDescription>
        </div>
        {active ? (
          <Spinner />
        ) : job.status === 'COMPLETED' ? (
          <CheckCircle2 className="h-5 w-5 text-success" />
        ) : (
          <XCircle className="h-5 w-5 text-danger" />
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {active && (
          <div>
            <div
              className="h-2 overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-valuenow={job.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500"
                style={{ width: `${Math.max(3, job.progress)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              {job.status === 'QUEUED' ? 'Aguardando na fila...' : `Processando · ${job.progress}%`}{' '}
              O processamento continua mesmo se você sair desta tela.
            </p>
          </div>
        )}
        {job.status === 'FAILED' && (
          <Alert tone="danger">{job.error ?? 'Falha no processamento.'}</Alert>
        )}
        {job.status === 'COMPLETED' && (
          <>
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Arquivos gerados</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {job.outputs.map((o, i) => (
                  <li key={o.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span className="flex min-w-0 items-center gap-2.5 text-sm">
                      {o.name.endsWith('.zip') ? (
                        <FileArchive className="h-4 w-4 shrink-0 text-accent" />
                      ) : (
                        <FileSpreadsheet className="h-4 w-4 shrink-0 text-subtle" />
                      )}
                      <span className="truncate text-fg/90">{o.name}</span>
                      {o.rows !== null && (
                        <span className="shrink-0 text-xs text-subtle">
                          {formatNumber(o.rows)} linha(s)
                        </span>
                      )}
                    </span>
                    <a
                      href={`/api/tools/jobs/${job.id}/outputs/${i}`}
                      download
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-accent hover:bg-accent-soft"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden /> Baixar
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <SummaryView summary={job.summary} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
