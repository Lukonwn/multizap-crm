'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  CalendarClock,
  Copy,
  ListChecks,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Send,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  CAMPAIGN_STATUS_LABEL,
  RECIPIENT_STATUS_LABEL,
  SAMPLE_TEMPLATE_VALUES,
  buildCampaignMessage,
  formatPhone,
  type CampaignAccountDTO,
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
  Field,
  Input,
  Modal,
  Spinner,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  cn,
} from '@multizap/ui';
import {
  CAMPAIGN_TONE,
  RECIPIENT_TONE,
  useCampaign,
  useCampaignAction,
  useRecipients,
} from '@/lib/campaigns';
import { formatDateTime, formatNumber } from '@/lib/format';
import { MessagePreview } from '@/components/assets/message-preview';

const HISTORY_LABEL: Record<string, string> = {
  'campaign.created': 'Campanha criada',
  'campaign.updated': 'Rascunho alterado',
  'campaign.duplicated': 'Criada por duplicação',
  'campaign.scheduled': 'Agendada',
  'campaign.unscheduled': 'Agendamento removido',
  'campaign.prepare_requested': 'Preparação solicitada',
  'campaign.prepared': 'Fila preparada',
  'campaign.paused': 'Pausada',
  'campaign.resumed': 'Retomada',
  'campaign.cancelled': 'Cancelada',
};

/**
 * Barra segmentada por situação dos destinatários (dado de estado):
 * cada segmento tem rótulo e contagem em texto na legenda.
 */
function ChildProgress({ a }: { a: CampaignAccountDTO }) {
  const c = a.counters;
  const segs = [
    { key: 'read', label: 'Lidas', n: c.read, color: 'var(--color-success)' },
    {
      key: 'delivered',
      label: 'Entregues',
      n: c.delivered,
      color: 'color-mix(in oklab, var(--color-success) 60%, transparent)',
    },
    { key: 'sent', label: 'Enviadas', n: c.sent + c.sending, color: 'var(--color-accent)' },
    { key: 'failed', label: 'Falhas', n: c.failed, color: 'var(--color-danger)' },
    { key: 'skipped', label: 'Puladas', n: c.skipped, color: 'var(--color-warning)' },
    { key: 'pending', label: 'Aguardando', n: c.pending, color: 'var(--color-surface-3)' },
  ].filter((s) => s.n > 0);
  return (
    <div>
      <div className="flex h-2 gap-[2px] overflow-hidden rounded-full">
        {segs.map((s) => (
          <div
            key={s.key}
            style={{ flexGrow: s.n, background: s.color }}
            title={`${s.label}: ${s.n}`}
          />
        ))}
        {!segs.length && <div className="h-2 flex-1 bg-surface-3" />}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {segs.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} /> {s.label}{' '}
            <span className="tabular-nums text-fg">{formatNumber(s.n)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScheduleModal({ id, onClose }: { id: string; onClose: () => void }) {
  const act = useCampaignAction();
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 3_600_000);
    d.setMinutes(0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Agendar campanha"
      description="No horário escolhido o sistema monta a fila com os contatos elegíveis e avisa você. Os envios continuam dependendo da sua confirmação."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={act.isPending}
            onClick={() =>
              act.mutate(
                {
                  path: `/campaigns/${id}/schedule`,
                  json: { scheduledAt: new Date(when).toISOString() },
                },
                { onSuccess: onClose },
              )
            }
          >
            Agendar
          </Button>
        </>
      }
    >
      {act.isError && (
        <Alert tone="danger" className="mb-3">
          {act.error.message}
        </Alert>
      )}
      <Field label="Data e hora" htmlFor="sched">
        <Input
          id="sched"
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

export default function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const q = useCampaign(id);
  const act = useCampaignAction();
  const [scheduling, setScheduling] = useState(false);
  const [filter, setFilter] = useState<{ accountId?: string; status?: string }>({});
  const [page, setPage] = useState(1);
  const recipients = useRecipients(id, { ...filter, page });

  if (q.isPending)
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const { campaign: c, history } = q.data;
  const run = (path: string, confirmText?: string) =>
    (!confirmText || window.confirm(confirmText)) &&
    act.mutate({ path: `/campaigns/${id}${path}` });
  const active = ['READY', 'RUNNING'].includes(c.status);
  const pages = recipients.data ? Math.max(1, Math.ceil(recipients.data.total / 20)) : 1;

  return (
    <>
      <Link
        href="/campanhas"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Campanhas
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{c.name}</h1>
            <Badge tone={CAMPAIGN_TONE[c.status]} dot>
              {CAMPAIGN_STATUS_LABEL[c.status]}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            {c.scheduledAt
              ? `Agendada para ${formatDateTime(c.scheduledAt)}`
              : `Criada em ${formatDateTime(c.createdAt)}`}
            {c.startedAt && ` · iniciada ${formatDateTime(c.startedAt)}`}
            {c.completedAt && ` · concluída ${formatDateTime(c.completedAt)}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.status === 'DRAFT' && (
            <>
              <Button variant="secondary" size="sm" asChild>
                <Link href={`/campanhas/${id}/editar`}>
                  <Pencil className="h-3.5 w-3.5" /> Editar
                </Link>
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setScheduling(true)}>
                <CalendarClock className="h-3.5 w-3.5" /> Agendar
              </Button>
            </>
          )}
          {c.status === 'SCHEDULED' && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setScheduling(true)}>
                <CalendarClock className="h-3.5 w-3.5" /> Reagendar
              </Button>
              <Button variant="secondary" size="sm" onClick={() => run('/unschedule')}>
                Remover agendamento
              </Button>
            </>
          )}
          {['DRAFT', 'SCHEDULED'].includes(c.status) && (
            <Button size="sm" loading={act.isPending} onClick={() => run('/prepare')}>
              <ListChecks className="h-3.5 w-3.5" /> Preparar fila agora
            </Button>
          )}
          {active && (
            <Button variant="secondary" size="sm" onClick={() => run('/pause')}>
              <Pause className="h-3.5 w-3.5" /> Pausar
            </Button>
          )}
          {c.status === 'PAUSED' && (
            <Button size="sm" onClick={() => run('/resume')}>
              <Play className="h-3.5 w-3.5" /> Retomar
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              act.mutate(
                { path: `/campaigns/${id}/duplicate` },
                { onSuccess: (r) => r.campaign && router.push(`/campanhas/${r.campaign.id}`) },
              )
            }
          >
            <Copy className="h-3.5 w-3.5" /> Duplicar
          </Button>
          {!['COMPLETED', 'CANCELLED'].includes(c.status) && (
            <Button
              variant="danger"
              size="sm"
              onClick={() =>
                run(
                  '/cancel',
                  'Cancelar a campanha? Os destinatários ainda não enviados sairão da fila.',
                )
              }
            >
              <XCircle className="h-3.5 w-3.5" /> Cancelar
            </Button>
          )}
          {['DRAFT', 'CANCELLED'].includes(c.status) && (
            <Button
              variant="danger"
              size="sm"
              onClick={() =>
                window.confirm('Excluir esta campanha?') &&
                act.mutate(
                  { path: `/campaigns/${id}`, method: 'DELETE' },
                  { onSuccess: () => router.replace('/campanhas') },
                )
              }
            >
              <Trash2 className="h-3.5 w-3.5" /> Excluir
            </Button>
          )}
        </div>
      </div>

      {act.isError && (
        <Alert tone="danger" className="mb-4">
          {act.error.message}
        </Alert>
      )}
      {c.status === 'SCHEDULED' && c.scheduledAt && new Date(c.scheduledAt) <= new Date() && (
        <Alert tone="info" className="mb-4">
          Montando a fila de destinatários...
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_340px] [&>*]:min-w-0">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Instâncias</CardTitle>
                <CardDescription>
                  Cada instância tem fila, público e resultado próprios.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {c.accounts.map((a) => (
                <div key={a.id} className="rounded-lg border border-border bg-bg-soft p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{a.accountName}</span>
                      <Badge tone={CAMPAIGN_TONE[a.status]}>
                        {CAMPAIGN_STATUS_LABEL[a.status]}
                      </Badge>
                      {a.accountStatus !== 'CONNECTED' && (
                        <Badge tone="warning">Instância desconectada</Badge>
                      )}
                    </div>
                    {(active || c.status === 'COMPLETED') && a.counters.pending > 0 && (
                      <Button size="sm" asChild>
                        <Link href={`/campanhas/${id}/enviar?conta=${a.accountId}`}>
                          <Send className="h-3.5 w-3.5" /> Envio assistido (
                          {formatNumber(a.counters.pending)})
                        </Link>
                      </Button>
                    )}
                  </div>
                  <ChildProgress a={a} />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Destinatários</CardTitle>
                <CardDescription>Situação informada pelo WhatsApp para cada envio.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex flex-wrap gap-1">
                {[
                  ['', 'Todos'],
                  ['PENDING', 'Aguardando'],
                  ['SENT,DELIVERED,READ', 'Enviadas'],
                  ['FAILED', 'Falhas'],
                  ['SKIPPED', 'Puladas'],
                ].map(([v, l]) => (
                  <button
                    key={v}
                    onClick={() => {
                      setFilter((f) => ({ ...f, status: v || undefined }));
                      setPage(1);
                    }}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs',
                      (filter.status ?? '') === v
                        ? 'bg-surface-3 text-fg'
                        : 'text-muted hover:text-fg',
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
              {recipients.data && recipients.data.total === 0 ? (
                <p className="text-sm text-subtle">
                  {['DRAFT', 'SCHEDULED'].includes(c.status)
                    ? 'A fila ainda não foi preparada.'
                    : 'Nenhum destinatário nesta categoria.'}
                </p>
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>Contato</TH>
                      <TH>Instância</TH>
                      <TH>Situação</TH>
                      <TH>Detalhe</TH>
                      <TH />
                    </tr>
                  </THead>
                  <TBody>
                    {recipients.data?.items.map((r) => (
                      <TR key={r.id}>
                        <TD>
                          <span className="block">{r.name ?? 'Sem nome'}</span>
                          <span className="text-xs tabular-nums text-subtle">
                            {formatPhone(r.phoneE164)}
                          </span>
                        </TD>
                        <TD className="text-muted">
                          {c.accounts.find((a) => a.accountId === r.accountId)?.accountName}
                        </TD>
                        <TD>
                          <Badge tone={RECIPIENT_TONE[r.status] ?? 'neutral'}>
                            {RECIPIENT_STATUS_LABEL[r.status] ?? r.status}
                          </Badge>
                        </TD>
                        <TD
                          className="max-w-64 truncate text-xs text-muted"
                          title={r.error ?? undefined}
                        >
                          {r.error ?? (r.sentAt ? formatDateTime(r.sentAt) : '')}
                        </TD>
                        <TD>
                          {r.status === 'FAILED' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                act.mutate({ path: `/campaigns/${id}/recipients/${r.id}/retry` })
                              }
                            >
                              <RotateCcw className="h-3.5 w-3.5" /> Tentar de novo
                            </Button>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
              {pages > 1 && (
                <div className="mt-3 flex justify-end gap-2 text-xs text-muted">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    Anterior
                  </Button>
                  <span className="self-center">
                    {page} / {pages}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page >= pages}
                    onClick={() => setPage(page + 1)}
                  >
                    Próxima
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <div>
            <MessagePreview
              text={buildCampaignMessage(
                { body: c.body, linkUrl: c.linkUrl },
                { name: SAMPLE_TEMPLATE_VALUES.nome, phoneE164: '+5511987654321' },
              )}
              imageUrl={c.asset ? `/api/assets/${c.asset.id}/file` : null}
            />
            <p className="mt-2 text-xs text-subtle">
              Exemplo com dados fictícios; cada contato recebe os próprios dados.
            </p>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Histórico</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3 border-l border-border pl-4">
                {history.map((h) => (
                  <li key={h.id} className="relative text-sm">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-border-strong" />
                    <p className="text-fg/90">{HISTORY_LABEL[h.action] ?? h.action}</p>
                    <p className="text-xs text-subtle">{formatDateTime(h.createdAt)}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
      {scheduling && <ScheduleModal id={id} onClose={() => setScheduling(false)} />}
    </>
  );
}
