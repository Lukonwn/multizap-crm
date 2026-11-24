'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { formatPhone, type ContactDTO, type ConversationDTO } from '@multizap/shared';
import { Alert, Badge, Modal, Segmented, Select, Spinner, Input, Button } from '@multizap/ui';
import { api } from '@/lib/api';
import { toQueryString } from '@/lib/contacts';
import { useAccounts } from '@/lib/accounts';
import { Avatar } from './avatar';

interface DeviceItem {
  id: string;
  name: string | null;
  pushName: string | null;
  phoneE164: string | null;
  optedOut: boolean;
}
interface Row {
  key: string;
  name: string | null;
  phoneE164: string;
  optedOut: boolean;
}

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * "Nova conversa", como no WhatsApp Web: escolhe um contato da instância e abre a
 * conversa individual. Nada é enviado aqui; cada mensagem é escrita e enviada por você.
 */
export function NewChatModal({
  open,
  onOpenChange,
  initialAccountId,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialAccountId: string;
  onStarted: (conversation: ConversationDTO) => void;
}) {
  const accounts = useAccounts();
  const usable = (accounts.data?.items ?? []).filter((a) => a.connectionType === 'WHATSAPP_WEB');
  const [accountId, setAccountId] = useState(initialAccountId);
  const [source, setSource] = useState<'device' | 'crm'>('device');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [page, setPage] = useState(1);

  // Instância inicial: a filtrada na Central; senão, a primeira conectada.
  const defaultAccount = () =>
    initialAccountId || (usable.find((a) => a.status === 'CONNECTED') ?? usable[0])?.id || '';
  useEffect(() => {
    if (!open) return;
    setAccountId(defaultAccount());
    setSource('device');
    setSearch('');
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open && !accountId) setAccountId(defaultAccount());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId, accounts.data]);
  useEffect(() => setPage(1), [accountId, source, q]);

  const account = usable.find((a) => a.id === accountId);
  const connected = account?.status === 'CONNECTED';

  const list = useQuery({
    queryKey: ['new-chat', accountId, source, q, page],
    enabled: open && !!accountId,
    queryFn: async (): Promise<{ rows: Row[]; total: number; identities: number }> => {
      if (source === 'device') {
        const r = await api<{
          items: DeviceItem[];
          total: number;
          stats: { identities: number };
        }>(
          `/accounts/${accountId}/device-contacts?${toQueryString({ q: q || undefined, withPhone: 'true', page, pageSize: 50 })}`,
        );
        return {
          rows: r.items
            .filter((i) => i.phoneE164)
            .map((i) => ({
              key: i.id,
              name: i.name,
              phoneE164: i.phoneE164!,
              optedOut: i.optedOut,
            })),
          total: r.total,
          identities: r.stats.identities,
        };
      }
      const r = await api<{ items: ContactDTO[]; total: number }>(
        `/accounts/${accountId}/contacts?${toQueryString({ q: q || undefined, page, pageSize: 50 })}`,
      );
      return {
        rows: r.items.map((c) => ({
          key: c.id,
          name: c.name,
          phoneE164: c.phoneE164,
          optedOut: !!c.optedOutAt,
        })),
        total: r.total,
        identities: 0,
      };
    },
  });

  const start = useMutation({
    mutationFn: (phoneE164: string) =>
      api<{ conversation: ConversationDTO }>(`/accounts/${accountId}/conversations/start`, {
        method: 'POST',
        json: { phoneE164 },
      }),
    onSuccess: ({ conversation }) => {
      onOpenChange(false);
      onStarted(conversation);
    },
  });

  const rows = list.data?.rows ?? [];
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / 50)) : 1;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Nova conversa"
      description="Escolha um contato para conversar. Cada mensagem é escrita e enviada por você, uma a uma."
      className="w-[min(94vw,560px)]"
    >
      <div className="space-y-3 p-5">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs font-medium text-muted">
            Instância
            <Select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="mt-1 h-9"
              aria-label="Instância da conversa"
            >
              <option value="">Escolha...</option>
              {usable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.status === 'CONNECTED' ? '' : ' (desconectada)'}
                </option>
              ))}
            </Select>
          </label>
          <div className="text-xs font-medium text-muted">
            Contatos de
            <div className="mt-1">
              <Segmented
                value={source}
                onChange={setSource}
                options={[
                  { value: 'device', label: 'Celular' },
                  { value: 'crm', label: 'Contatos (CRM)' },
                ]}
              />
            </div>
          </div>
        </div>

        {accountId && !connected && (
          <Alert tone="warning">
            Esta instância não está conectada. Você pode abrir a conversa, mas só consegue enviar
            quando ela estiver conectada.
          </Alert>
        )}

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pesquisar nome ou telefone"
            className="h-9 pl-9"
            aria-label="Pesquisar contatos"
            autoFocus
          />
        </div>

        {start.isError && <Alert tone="danger">{start.error.message}</Alert>}
        {!accountId && (
          <p className="py-8 text-center text-sm text-subtle">Escolha uma instância.</p>
        )}
        {accountId && list.isPending && (
          <div className="grid place-items-center py-8">
            <Spinner />
          </div>
        )}
        {accountId && list.isError && <Alert tone="danger">{list.error.message}</Alert>}
        {accountId && list.data && rows.length === 0 && (
          <p className="py-8 text-center text-sm text-subtle">
            {source === 'device' && list.data.identities === 0
              ? 'O WhatsApp ainda não enviou a agenda deste aparelho. Se a instância foi pareada antes, remova a conexão e pareie de novo.'
              : 'Nenhum contato encontrado.'}
          </p>
        )}
        {rows.length > 0 && (
          <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {rows.map((r) => (
              <li key={r.key}>
                <button
                  type="button"
                  disabled={start.isPending}
                  onClick={() => start.mutate(r.phoneE164)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 disabled:opacity-60"
                >
                  <Avatar name={r.name ?? r.phoneE164} photoUrl={null} className="h-9 w-9" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">
                      {r.name ?? formatPhone(r.phoneE164)}
                    </span>
                    {r.name && (
                      <span className="block text-xs text-subtle">{formatPhone(r.phoneE164)}</span>
                    )}
                  </span>
                  {r.optedOut && <Badge tone="warning">Descadastrado</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 text-xs text-muted">
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
        <p className="text-xs text-subtle">
          Quem pediu descadastramento não recebe mensagens, a não ser que escreva de novo. A pausa
          geral das operações também bloqueia o envio.
        </p>
      </div>
    </Modal>
  );
}
