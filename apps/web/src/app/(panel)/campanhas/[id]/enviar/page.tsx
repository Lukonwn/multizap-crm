'use client';
import { Suspense, use, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, MousePointerClick, Send, SkipForward } from 'lucide-react';
import { CAMPAIGN_STATUS_LABEL, RECIPIENT_STATUS_LABEL, formatPhone } from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
  StatCard,
} from '@multizap/ui';
import { api } from '@/lib/api';
import { RECIPIENT_TONE, useCampaign, useNextRecipient, useRecipients } from '@/lib/campaigns';
import { formatNumber, timeAgo } from '@/lib/format';
import { MessagePreview } from '@/components/assets/message-preview';

function Console({ id }: { id: string }) {
  const params = useSearchParams();
  const accountId = params.get('conta');
  const qc = useQueryClient();
  const campaign = useCampaign(id);
  const next = useNextRecipient(id, accountId);
  const recent = useRecipients(id, {
    accountId: accountId ?? undefined,
    status: 'SENDING,SENT,DELIVERED,READ,FAILED,SKIPPED',
    page: 1,
  });
  const [busy, setBusy] = useState<null | 'send' | 'skip'>(null);
  const [error, setError] = useState<string | null>(null);

  if (!accountId) return <Alert tone="danger">Instância não informada.</Alert>;
  if (campaign.isPending || next.isPending)
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (campaign.isError) return <Alert tone="danger">{campaign.error.message}</Alert>;
  const c = campaign.data.campaign;
  const child = c.accounts.find((a) => a.accountId === accountId);
  if (!child) return <Alert tone="danger">Esta instância não faz parte da campanha.</Alert>;

  const active = ['READY', 'RUNNING'].includes(c.status);
  const connected = child.accountStatus === 'CONNECTED';
  const blocked = !active
    ? `A campanha está ${CAMPAIGN_STATUS_LABEL[c.status].toLowerCase()}.`
    : !connected
      ? `A instância "${child.accountName}" não está conectada.`
      : null;
  const r = next.data?.recipient ?? null;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['campaign', id, 'next', accountId] }),
      qc.invalidateQueries({ queryKey: ['campaign', id, 'recipients'] }),
      qc.invalidateQueries({ queryKey: ['campaign', id] }),
    ]);

  const act = async (kind: 'send' | 'skip') => {
    if (!r) return;
    setBusy(kind);
    setError(null);
    try {
      await api(`/campaigns/${id}/recipients/${r.id}/${kind}`, {
        method: 'POST',
        json: kind === 'skip' ? {} : undefined,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const k = child.counters;
  return (
    <>
      <Link
        href={`/campanhas/${id}`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> {c.name}
      </Link>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Envio assistido</h1>
          <p className="mt-1 text-sm text-muted">
            Instância <strong className="text-fg">{child.accountName}</strong> · cada mensagem só é
            enviada quando você clicar em “Enviar”.
          </p>
        </div>
        <Badge tone={connected ? 'success' : 'warning'} dot>
          {connected ? 'Conectada' : 'Desconectada'}
        </Badge>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Aguardando" value={formatNumber(k.pending)} tone="neutral" />
        <StatCard
          label="Enviadas"
          value={formatNumber(k.sent + k.delivered + k.read + k.sending)}
          tone="accent"
          hint={`${formatNumber(k.delivered + k.read)} entregues · ${formatNumber(k.read)} lidas`}
        />
        <StatCard
          label="Falhas"
          value={formatNumber(k.failed)}
          tone={k.failed ? 'danger' : 'neutral'}
        />
        <StatCard label="Puladas" value={formatNumber(k.skipped)} tone="warning" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle>Próximo destinatário</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {blocked && <Alert tone="warning">{blocked}</Alert>}
            {error && <Alert tone="danger">{error}</Alert>}
            {(next.data?.autoSkipped ?? 0) > 0 && (
              <Alert tone="info">
                {next.data!.autoSkipped} contato(s) deixaram de ser elegíveis (descadastro ou
                consentimento) e foram pulados automaticamente.
              </Alert>
            )}
            {!r ? (
              <div className="flex flex-col items-center py-10 text-center">
                <CheckCircle2 className="h-10 w-10 text-success" aria-hidden />
                <p className="mt-3 text-base font-semibold">Fila concluída para esta instância</p>
                <p className="mt-1 text-sm text-muted">
                  Acompanhe as confirmações de entrega e leitura ao lado ou na página da campanha.
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between rounded-lg border border-border bg-bg-soft px-4 py-3">
                  <div>
                    <p className="text-base font-semibold">{r.name ?? 'Sem nome'}</p>
                    <p className="text-sm tabular-nums text-muted">{formatPhone(r.phoneE164)}</p>
                  </div>
                  <span className="text-xs text-subtle">
                    {formatNumber(next.data!.remaining)} na fila
                  </span>
                </div>
                <MessagePreview
                  text={r.message}
                  imageUrl={c.asset ? `/api/assets/${c.asset.id}/file` : null}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    size="lg"
                    onClick={() => act('send')}
                    loading={busy === 'send'}
                    disabled={!!blocked || busy !== null}
                  >
                    <Send className="h-4 w-4" aria-hidden /> Enviar para{' '}
                    {r.name?.split(' ')[0] ?? 'este contato'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={() => act('skip')}
                    loading={busy === 'skip'}
                    disabled={busy !== null}
                  >
                    <SkipForward className="h-4 w-4" aria-hidden /> Pular
                  </Button>
                  <span className="flex items-center gap-1.5 text-xs text-subtle">
                    <MousePointerClick className="h-3.5 w-3.5" /> Um clique por mensagem.
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Últimos envios</CardTitle>
          </CardHeader>
          <CardContent>
            {recent.data?.items.length === 0 && (
              <p className="text-sm text-subtle">Nenhum envio ainda.</p>
            )}
            <ul className="divide-y divide-border">
              {recent.data?.items.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{x.name ?? formatPhone(x.phoneE164)}</span>
                    {x.error ? (
                      <span className="block truncate text-xs text-danger" title={x.error}>
                        {x.error}
                      </span>
                    ) : (
                      <span className="text-xs text-subtle">{timeAgo(x.updatedAt)}</span>
                    )}
                  </span>
                  <Badge tone={RECIPIENT_TONE[x.status] ?? 'neutral'}>
                    {RECIPIENT_STATUS_LABEL[x.status] ?? x.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default function SendPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      }
    >
      <Console id={id} />
    </Suspense>
  );
}
