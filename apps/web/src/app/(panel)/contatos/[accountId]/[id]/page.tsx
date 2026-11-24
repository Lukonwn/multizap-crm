'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Ban, Pencil, RotateCcw, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { CONSENT_LABEL, ORIGIN_LABEL, formatPhone } from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
  cn,
} from '@multizap/ui';
import { CONSENT_TONE, useContact, useContactHistory, useContactsMutation } from '@/lib/contacts';
import { useAccount } from '@/lib/accounts';
import { formatDateTime } from '@/lib/format';
import { ContactFormModal } from '@/components/contacts/contact-form-modal';
import { ConsentModal, type ConsentMode } from '@/components/contacts/consent-modal';
import { TagChip } from '@/components/contacts/tags';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-fg/90">{children}</dd>
    </div>
  );
}

export default function ContactDetailPage({
  params,
}: {
  params: Promise<{ accountId: string; id: string }>;
}) {
  const { accountId, id } = use(params);
  const router = useRouter();
  const contact = useContact(accountId, id);
  const history = useContactHistory(accountId, id);
  const account = useAccount(accountId);
  const del = useContactsMutation(accountId);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<ConsentMode | null>(null);
  const back = `/contatos?conta=${accountId}`;

  if (contact.isPending)
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (contact.isError) {
    return (
      <div className="space-y-4">
        <Link
          href={back}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4" /> Contatos
        </Link>
        <Alert tone="danger">{contact.error.message}</Alert>
      </div>
    );
  }
  const c = contact.data;
  const optedOut = !!c.optedOutAt;

  return (
    <>
      <Link
        href={back}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Contatos
        {account.data && ` · ${account.data.account.name}`}
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{c.name ?? 'Sem nome'}</h1>
            {optedOut ? (
              <Badge tone="danger" dot>
                Descadastrado
              </Badge>
            ) : (
              <Badge tone={CONSENT_TONE[c.consentStatus]} dot>
                {CONSENT_LABEL[c.consentStatus]}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm tabular-nums text-muted">{formatPhone(c.phoneE164)}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          <Pencil className="h-3.5 w-3.5" aria-hidden /> Editar
        </Button>
      </div>

      {optedOut && (
        <Alert tone="danger" className="mb-4" title="Contato descadastrado">
          Este telefone está bloqueado nesta instância e nunca será incluído em campanhas.
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Dados do contato</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border">
                <Row label="Telefone">{formatPhone(c.phoneE164)}</Row>
                <Row label="Origem">
                  {ORIGIN_LABEL[c.origin]}
                  {c.originDetail && (
                    <span className="block text-xs text-subtle">{c.originDetail}</span>
                  )}
                </Row>
                <Row label="Consentimento">{CONSENT_LABEL[c.consentStatus]}</Row>
                <Row label="Data de autorização">{formatDateTime(c.consentAt)}</Row>
                {optedOut && <Row label="Descadastrado em">{formatDateTime(c.optedOutAt)}</Row>}
                <Row label="Etiquetas">
                  {c.tags.length ? (
                    <div className="flex flex-wrap justify-end gap-1">
                      {c.tags.map((t) => (
                        <TagChip key={t.id} tag={t} />
                      ))}
                    </div>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </Row>
                <Row label="Criado em">{formatDateTime(c.createdAt)}</Row>
              </dl>
              {c.notes && (
                <div className="mt-4 rounded-lg border border-border bg-bg-soft p-3">
                  <p className="mb-1 text-xs font-medium text-muted">Observações</p>
                  <p className="whitespace-pre-wrap text-sm text-fg/90">{c.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Histórico</CardTitle>
                <CardDescription>Consentimentos, descadastramentos e alterações.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {history.isPending && <Spinner />}
              <ol className="relative space-y-4 border-l border-border pl-5">
                {history.data?.map((h) => (
                  <li key={h.id} className="relative">
                    <span
                      className={cn(
                        'absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-surface',
                        h.title.includes('revogado') || h.title === 'Descadastrado'
                          ? 'bg-danger'
                          : h.kind === 'consent'
                            ? 'bg-success'
                            : 'bg-subtle',
                      )}
                      aria-hidden
                    />
                    <p className="text-sm text-fg/90">{h.title}</p>
                    {h.detail && <p className="text-xs text-muted">{h.detail}</p>}
                    <p className="mt-0.5 text-xs text-subtle">{formatDateTime(h.createdAt)}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Consentimento</CardTitle>
                <CardDescription>
                  Somente contatos autorizados e não descadastrados podem entrar em campanhas.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {optedOut ? (
                <Button
                  variant="secondary"
                  className="w-full justify-start"
                  onClick={() => setMode('resubscribe')}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden /> Reverter descadastramento
                </Button>
              ) : (
                <>
                  {c.consentStatus !== 'GRANTED' && (
                    <Button
                      variant="secondary"
                      className="w-full justify-start"
                      onClick={() => setMode('grant')}
                    >
                      <ShieldCheck className="h-4 w-4" aria-hidden /> Registrar consentimento
                    </Button>
                  )}
                  {c.consentStatus === 'GRANTED' && (
                    <Button
                      variant="secondary"
                      className="w-full justify-start"
                      onClick={() => setMode('revoke')}
                    >
                      <ShieldOff className="h-4 w-4" aria-hidden /> Revogar consentimento
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    className="w-full justify-start"
                    onClick={() => setMode('opt-out')}
                  >
                    <Ban className="h-4 w-4" aria-hidden /> Descadastrar
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
          <Card className="border-danger/25">
            <CardHeader>
              <CardTitle>Excluir</CardTitle>
            </CardHeader>
            <CardContent>
              {del.isError && (
                <Alert tone="danger" className="mb-3">
                  {del.error.message}
                </Alert>
              )}
              <p className="mb-3 text-xs text-subtle">
                Remove o contato desta instância. Um descadastramento continua valendo para este
                telefone.
              </p>
              <Button
                variant="danger"
                className="w-full justify-start"
                loading={del.isPending}
                onClick={() =>
                  window.confirm('Excluir este contato definitivamente?') &&
                  del.mutate(
                    { path: `/contacts/${c.id}`, method: 'DELETE' },
                    { onSuccess: () => router.replace(back) },
                  )
                }
              >
                <Trash2 className="h-4 w-4" aria-hidden /> Excluir contato
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {editing && (
        <ContactFormModal accountId={accountId} contact={c} open onOpenChange={setEditing} />
      )}
      <ConsentModal
        key={mode ?? 'none'}
        accountId={accountId}
        contactId={c.id}
        mode={mode}
        onClose={() => setMode(null)}
      />
    </>
  );
}
