'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Clock,
  ExternalLink,
  Link2,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import {
  CONNECTION_TYPE_LABEL,
  STATUS_REASON_LABEL,
  formatPhone,
  type AccountDTO,
} from '@multizap/shared';
import type { ProviderCapabilities } from '@multizap/integrations';
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
  cn,
} from '@multizap/ui';
import { ApiError } from '@/lib/api';
import { useAccount, useAccountAction, useAccountEvents } from '@/lib/accounts';
import { formatDateTime, timeAgo } from '@/lib/format';
import { CURRENT_PHASE } from '@/lib/modules';
import { AccountStatusBadge } from '@/components/connections/status-badge';
import { ConfirmNameModal } from '@/components/connections/confirm-name-modal';
import { PairingModal } from '@/components/connections/pairing-modal';

/** `phase`: fase em que o MultiZap passa a usar o recurso do canal. */
const CAPABILITY_LABELS: { key: keyof ProviderCapabilities; label: string; phase: number }[] = [
  { key: 'qrPairing', label: 'Pareamento por QR Code', phase: 2 },
  { key: 'pairingCode', label: 'Pareamento com número de telefone', phase: 2 },
  { key: 'receiveMessages', label: 'Recebimento de mensagens', phase: 7 },
  { key: 'sendMessage', label: 'Envio de mensagens individuais', phase: 6 },
  { key: 'messageStatus', label: 'Status de entrega e leitura', phase: 6 },
  { key: 'historySync', label: 'Histórico entregue ao vincular', phase: 7 },
];

const EVENT_TONE: Record<string, string> = {
  paired: 'bg-success',
  connected: 'bg-success',
  logged_out: 'bg-danger',
  forbidden: 'bg-danger',
  connection_replaced: 'bg-warning',
  disconnected: 'bg-warning',
  pairing_expired: 'bg-warning',
  pairing_failed: 'bg-danger',
  pairing_code_failed: 'bg-danger',
};

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-fg/90">{children}</dd>
    </div>
  );
}

function RenameModal({
  account,
  open,
  onOpenChange,
}: {
  account: AccountDTO;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const action = useAccountAction(account.id);
  const [name, setName] = useState(account.name);
  const fieldError = action.error instanceof ApiError ? action.error.fields?.name?.[0] : undefined;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Renomear instância"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            loading={action.isPending}
            onClick={() =>
              action.mutate(
                { path: '', method: 'PATCH', json: { name } },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      <Field label="Nome" htmlFor="rename" error={fieldError}>
        <Input id="rename" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

export default function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const detail = useAccount(id);
  const events = useAccountEvents(id);
  const action = useAccountAction(id);
  const [pairing, setPairing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState<null | 'remove' | 'delete'>(null);

  if (detail.isPending) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="space-y-4">
        <Link
          href="/conexoes"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4" /> Conexões
        </Link>
        <Alert tone="danger">{detail.error.message}</Alert>
      </div>
    );
  }

  const { account, capabilities } = detail.data;
  const isWeb = account.connectionType === 'WHATSAPP_WEB';
  const paired = !!account.integration?.pairedAt;
  const disabled = account.status === 'DISABLED';
  const reasonText = account.statusReason ? STATUS_REASON_LABEL[account.statusReason] : null;
  const run = (path: string) => action.mutate({ path });

  return (
    <>
      <Link
        href="/conexoes"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Conexões
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{account.name}</h1>
            <AccountStatusBadge account={account} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {CONNECTION_TYPE_LABEL[account.connectionType]} · {formatPhone(account.phoneE164)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setRenaming(true)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Renomear
          </Button>
          {isWeb && !disabled && (!paired || account.status === 'NEEDS_REPAIR') && (
            <Button size="sm" onClick={() => setPairing(true)}>
              <Link2 className="h-3.5 w-3.5" aria-hidden />{' '}
              {account.status === 'NEEDS_REPAIR' ? 'Parear novamente' : 'Conectar'}
            </Button>
          )}
          {isWeb &&
            !disabled &&
            paired &&
            ['DISCONNECTED', 'ATTENTION'].includes(account.status) && (
              <Button
                size="sm"
                loading={action.isPending && action.variables?.path === '/reconnect'}
                onClick={() => run('/reconnect')}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reconectar
              </Button>
            )}
        </div>
      </div>

      {action.isError && (
        <Alert tone="danger" className="mb-4">
          {action.error.message}
        </Alert>
      )}
      {reasonText && account.status !== 'CONNECTED' && (
        <Alert tone={account.status === 'NEEDS_REPAIR' ? 'danger' : 'warning'} className="mb-4">
          {reasonText}
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {isWeb ? (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Conexão</CardTitle>
                  <CardDescription>Sessão de dispositivo conectado.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <dl className="divide-y divide-border">
                  <InfoRow label="Número">{formatPhone(account.phoneE164)}</InfoRow>
                  <InfoRow label="Pareado em">
                    {formatDateTime(account.integration?.pairedAt)}
                  </InfoRow>
                  <InfoRow label="Última atividade">{timeAgo(account.lastActivityAt)}</InfoRow>
                  <InfoRow label="Última verificação">
                    {formatDateTime(account.integration?.lastCheckAt)}
                  </InfoRow>
                  <InfoRow label="Credenciais">
                    {account.integration?.hasCredentials ? (
                      <Badge tone="accent">Armazenadas (criptografadas)</Badge>
                    ) : (
                      <span className="text-subtle">Nenhuma</span>
                    )}
                  </InfoRow>
                  {account.integration?.lastError && account.status !== 'CONNECTED' && (
                    <InfoRow label="Último erro">
                      <code className="break-all text-xs text-warning">
                        {account.integration.lastError}
                      </code>
                    </InfoRow>
                  )}
                  <InfoRow label="Cadastrada em">{formatDateTime(account.createdAt)}</InfoRow>
                </dl>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Aparelho externo cadastrado</CardTitle>
                  <CardDescription>Este número está apenas registrado no MultiZap.</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 text-sm text-muted">
                <p>
                  O MultiZap não envia nem recebe mensagens por este aparelho e não sincroniza
                  conversas. Para atendê-lo, use o próprio celular ou o WhatsApp Web.
                </p>
                <Button variant="secondary" size="sm" asChild>
                  <a href="https://web.whatsapp.com/" target="_blank" rel="noopener noreferrer">
                    Abrir WhatsApp Web <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                </Button>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Histórico de eventos</CardTitle>
                <CardDescription>
                  Registro das conexões, desconexões e ações nesta instância.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {events.isPending && <Spinner />}
              {events.data?.length === 0 && (
                <p className="text-sm text-subtle">Nenhum evento registrado.</p>
              )}
              <ol className="relative space-y-4 border-l border-border pl-5">
                {events.data?.map((e) => (
                  <li key={e.id} className="relative">
                    <span
                      className={cn(
                        'absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-surface',
                        EVENT_TONE[e.type] ?? 'bg-subtle',
                      )}
                      aria-hidden
                    />
                    <p className="text-sm text-fg/90">{e.message ?? e.type}</p>
                    <p className="mt-0.5 text-xs text-subtle">{formatDateTime(e.createdAt)}</p>
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
                <CardTitle>Recursos disponíveis</CardTitle>
                <CardDescription>
                  {isWeb ? 'Dispositivo conectado (WhatsApp Web).' : 'Aparelho apenas cadastrado.'}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2.5">
                {CAPABILITY_LABELS.map((c) => {
                  const on = capabilities[c.key];
                  return (
                    <li key={c.key} className="flex items-center gap-2.5 text-sm">
                      {on ? (
                        <Check className="h-4 w-4 text-success" aria-label="Disponível" />
                      ) : (
                        <X className="h-4 w-4 text-subtle" aria-label="Indisponível" />
                      )}
                      <span className={on ? 'text-fg/90' : 'text-subtle'}>{c.label}</span>
                    </li>
                  );
                })}
              </ul>
              {isWeb && (
                <p className="mt-4 text-xs text-subtle">
                  Mensagens e envios ficam disponíveis nas fases 6 e 7.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="border-danger/25">
            <CardHeader>
              <div>
                <CardTitle>Ações administrativas</CardTitle>
                <CardDescription>
                  Exigem confirmação. Nada é removido automaticamente.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {disabled ? (
                <Button
                  variant="secondary"
                  className="w-full justify-start"
                  loading={action.isPending && action.variables?.path === '/enable'}
                  onClick={() => run('/enable')}
                >
                  <Power className="h-4 w-4" aria-hidden /> Reativar instância
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  className="w-full justify-start"
                  loading={action.isPending && action.variables?.path === '/disable'}
                  onClick={() => run('/disable')}
                >
                  <PowerOff className="h-4 w-4" aria-hidden /> Desativar (mantém credenciais)
                </Button>
              )}
              {isWeb && (paired || account.integration?.hasCredentials) && (
                <Button
                  variant="danger"
                  className="w-full justify-start"
                  onClick={() => setConfirm('remove')}
                >
                  <Unlink className="h-4 w-4" aria-hidden /> Remover conexão
                </Button>
              )}
              <Button
                variant="danger"
                className="w-full justify-start"
                onClick={() => setConfirm('delete')}
              >
                <Trash2 className="h-4 w-4" aria-hidden /> Excluir instância
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {pairing && <PairingModal account={account} open onOpenChange={setPairing} />}
      {renaming && <RenameModal account={account} open onOpenChange={setRenaming} />}
      <ConfirmNameModal
        open={confirm === 'remove'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Remover conexão"
        name={account.name}
        confirmLabel="Remover conexão"
        loading={action.isPending}
        error={confirm === 'remove' && action.isError ? action.error.message : null}
        description={
          <p>
            O dispositivo será desvinculado do WhatsApp e as credenciais salvas serão apagadas. Para
            usar esta instância novamente será necessário um novo pareamento. Os contatos e o
            histórico da instância são mantidos.
          </p>
        }
        onConfirm={(confirmName) =>
          action.mutate(
            { path: '/remove-connection', json: { confirmName } },
            { onSuccess: () => setConfirm(null) },
          )
        }
      />
      <ConfirmNameModal
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Excluir instância"
        name={account.name}
        confirmLabel="Excluir definitivamente"
        loading={action.isPending}
        error={confirm === 'delete' && action.isError ? action.error.message : null}
        description={
          <p>
            A instância, a conexão, os contatos, as conversas e todo o histórico vinculado a ela
            serão excluídos definitivamente. Esta ação não pode ser desfeita.
          </p>
        }
        onConfirm={(confirmName) =>
          action.mutate(
            { path: '', method: 'DELETE', json: { confirmName } },
            { onSuccess: () => router.replace('/conexoes') },
          )
        }
      />
    </>
  );
}
