'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckCheck,
  Clock,
  ExternalLink,
  Info,
  MessagesSquare,
  Search,
  Send,
  XCircle,
} from 'lucide-react';
import {
  CONSENT_LABEL,
  CONVERSATION_STATUS_LABEL,
  MAX_MESSAGE_LENGTH,
  MESSAGE_TYPE_LABEL,
  ORIGIN_LABEL,
  formatPhone,
  type ConversationDTO,
  type ConversationFilter,
  type MessageDTO,
} from '@multizap/shared';
import { Alert, Badge, Button, EmptyState, Input, Select, Spinner, cn } from '@multizap/ui';
import { api } from '@/lib/api';
import { useAccounts } from '@/lib/accounts';
import { CONSENT_TONE, useContactsMutation } from '@/lib/contacts';
import { useConversation, useConversations, useMessages } from '@/lib/inbox';
import { formatDateTime } from '@/lib/format';
import { TagChip, TagPicker } from '@/components/contacts/tags';

const FILTERS: { value: ConversationFilter; label: string }[] = [
  { value: 'all', label: 'Todas' },
  { value: 'unread', label: 'Não lidas' },
  { value: 'pending', label: 'Pendentes' },
  { value: 'answered', label: 'Respondidas' },
  { value: 'closed', label: 'Finalizadas' },
];

const STATUS_TONE = {
  OPEN: 'neutral',
  PENDING: 'warning',
  ANSWERED: 'success',
  CLOSED: 'neutral',
} as const;

function displayName(c: Pick<ConversationDTO, 'contactName' | 'title' | 'phoneE164'>) {
  return (
    c.contactName ??
    c.title ??
    (c.phoneE164 ? formatPhone(c.phoneE164) : 'Contato sem número identificado')
  );
}

function shortTime(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/** Status informado pelo canal para mensagens enviadas (texto + ícone, nunca só cor). */
function OutStatus({ status }: { status: string }) {
  const map: Record<string, { icon: typeof Check; label: string; cls: string }> = {
    PENDING: { icon: Clock, label: 'Enviando', cls: 'text-subtle' },
    SENT: { icon: Check, label: 'Enviada', cls: 'text-subtle' },
    DELIVERED: { icon: CheckCheck, label: 'Entregue', cls: 'text-subtle' },
    READ: { icon: CheckCheck, label: 'Lida', cls: 'text-info' },
    FAILED: { icon: XCircle, label: 'Falhou', cls: 'text-danger' },
  };
  const m = map[status];
  if (!m) return null;
  return (
    <span className={cn('inline-flex items-center gap-0.5', m.cls)} title={m.label}>
      <m.icon className="h-3 w-3" aria-hidden />{' '}
      <span className="sr-only sm:not-sr-only">{m.label}</span>
    </span>
  );
}

function Bubble({ m }: { m: MessageDTO }) {
  const out = m.direction === 'OUTBOUND';
  const label = m.type !== 'text' ? MESSAGE_TYPE_LABEL[m.type] : null;
  return (
    <div className={cn('flex', out ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm',
          out ? 'rounded-tr-sm bg-[#103529] text-fg' : 'rounded-tl-sm bg-surface-2 text-fg',
        )}
      >
        {m.fromCampaign && (
          <p className="mb-1 text-[10px] uppercase tracking-wider text-accent">Campanha</p>
        )}
        {m.hasMedia && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/messages/${m.id}/media`}
            alt="Imagem da mensagem"
            className="mb-1.5 max-h-72 rounded-lg object-contain"
            loading="lazy"
          />
        )}
        {label && !m.hasMedia && <p className="text-xs italic text-muted">[{label}]</p>}
        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
        <p className="mt-1 flex items-center justify-end gap-2 text-[10px] text-subtle">
          {new Date(m.sentAt).toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
          {out && <OutStatus status={m.status} />}
        </p>
      </div>
    </div>
  );
}

function ContactPanel({ id }: { id: string }) {
  const conv = useConversation(id);
  const contact = conv.data?.contact;
  const m = useContactsMutation(contact?.accountId ?? '');
  const [notes, setNotes] = useState<string | null>(null);
  const [editingTags, setEditingTags] = useState(false);
  if (!conv.data) return <Spinner />;
  const c = conv.data.conversation;
  if (!contact) {
    return (
      <div className="space-y-3 text-sm">
        <p className="font-medium">{displayName(c)}</p>
        <Alert tone="info">
          Contato não identificado na base desta instância (o WhatsApp não informou o número).
        </Alert>
      </div>
    );
  }
  return (
    <div className="space-y-5 text-sm">
      <div>
        <p className="text-base font-semibold">{contact.name ?? 'Sem nome'}</p>
        <p className="tabular-nums text-muted">{formatPhone(contact.phoneE164)}</p>
        <p className="mt-1 text-xs text-subtle">Instância {c.accountName}</p>
      </div>
      <dl className="space-y-2">
        <div className="flex justify-between gap-2">
          <dt className="text-muted">Origem</dt>
          <dd>{ORIGIN_LABEL[contact.origin]}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted">Consentimento</dt>
          <dd>
            {contact.optedOutAt ? (
              <Badge tone="danger">Descadastrado</Badge>
            ) : (
              <Badge tone={CONSENT_TONE[contact.consentStatus]}>
                {CONSENT_LABEL[contact.consentStatus]}
              </Badge>
            )}
          </dd>
        </div>
        {contact.consentAt && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Autorizado em</dt>
            <dd>{formatDateTime(contact.consentAt)}</dd>
          </div>
        )}
      </dl>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-xs font-medium text-muted">Etiquetas</p>
          <button
            className="text-xs text-accent hover:underline"
            onClick={() => setEditingTags((v) => !v)}
          >
            {editingTags ? 'Concluir' : 'Editar'}
          </button>
        </div>
        {editingTags ? (
          <TagPicker
            accountId={contact.accountId}
            value={contact.tags.map((t) => t.id)}
            onChange={(tagIds) =>
              m.mutate(
                { path: `/contacts/${contact.id}`, method: 'PATCH', json: { tagIds } },
                { onSuccess: () => void conv.refetch() },
              )
            }
          />
        ) : contact.tags.length ? (
          <div className="flex flex-wrap gap-1">
            {contact.tags.map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-subtle">Sem etiquetas.</p>
        )}
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Observações</p>
        <textarea
          value={notes ?? contact.notes ?? ''}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          maxLength={2000}
          className="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm focus:border-accent focus:outline-none"
          aria-label="Observações do contato"
        />
        {notes !== null && notes !== (contact.notes ?? '') && (
          <Button
            size="sm"
            className="mt-2"
            loading={m.isPending}
            onClick={() =>
              m.mutate(
                { path: `/contacts/${contact.id}`, method: 'PATCH', json: { notes } },
                {
                  onSuccess: () => {
                    setNotes(null);
                    void conv.refetch();
                  },
                },
              )
            }
          >
            Salvar observações
          </Button>
        )}
      </div>
      <Link
        href={`/contatos/${contact.accountId}/${contact.id}`}
        className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
      >
        Abrir contato <ExternalLink className="h-3 w-3" />
      </Link>
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const qc = useQueryClient();
  const conv = useConversation(id);
  const messages = useMessages(id);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.data?.items.length ?? 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [count, id]);

  // Abrir a conversa zera o contador de não lidas (apenas no MultiZap).
  useEffect(() => {
    if (conv.data && conv.data.conversation.unreadCount > 0) {
      void api(`/conversations/${id}/read`, { method: 'POST' }).then(() =>
        qc.invalidateQueries({ queryKey: ['conversations'] }),
      );
    }
  }, [conv.data, id, qc]);

  if (!conv.data)
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  const c = conv.data.conversation;
  const reply = conv.data.reply;

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api(`/conversations/${id}/messages`, { method: 'POST', json: { text } });
      setText('');
      await Promise.all([
        messages.refetch(),
        conv.refetch(),
        qc.invalidateQueries({ queryKey: ['conversations'] }),
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const setStatus = async (status: 'CLOSED' | 'OPEN') => {
    await api(`/conversations/${id}/status`, { method: 'POST', json: { status } });
    await Promise.all([conv.refetch(), qc.invalidateQueries({ queryKey: ['conversations'] })]);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{displayName(c)}</p>
          <p className="text-xs text-muted">
            {c.phoneE164 ? formatPhone(c.phoneE164) : 'Número não informado'} · {c.accountName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[c.status]}>{CONVERSATION_STATUS_LABEL[c.status]}</Badge>
          {c.status === 'CLOSED' ? (
            <Button variant="secondary" size="sm" onClick={() => setStatus('OPEN')}>
              <ArchiveRestore className="h-3.5 w-3.5" /> Reabrir
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setStatus('CLOSED')}>
              <Archive className="h-3.5 w-3.5" /> Finalizar
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto bg-bg-soft/50 px-5 py-4">
        {messages.isPending && <Spinner />}
        {messages.data?.hasMore && (
          <p className="text-center text-xs text-subtle">Mensagens mais antigas não exibidas.</p>
        )}
        {messages.data?.items.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        <div ref={endRef} />
      </div>
      <div className="border-t border-border p-3">
        {error && (
          <Alert tone="danger" className="mb-2">
            {error}
          </Alert>
        )}
        {!reply.allowed ? (
          <p className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-xs text-muted">
            <Info className="h-4 w-4 shrink-0" /> {reply.reason}
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder="Escreva uma resposta (Enter envia, Shift+Enter quebra linha)"
              className="flex-1 resize-none rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              aria-label="Resposta"
            />
            <Button
              onClick={send}
              loading={sending}
              disabled={!text.trim()}
              aria-label="Enviar resposta"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function InboxPage() {
  const accounts = useAccounts();
  const [accountId, setAccountId] = useState('');
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const convs = useConversations({ accountId: accountId || undefined, filter, q: q || undefined });
  const items = convs.data?.items ?? [];

  return (
    <div className="-mx-8 -my-8 grid h-[calc(100vh-4rem)] grid-cols-[340px_1fr] overflow-hidden xl:grid-cols-[340px_1fr_300px]">
      <aside className="flex min-h-0 flex-col border-r border-border bg-bg-soft">
        <div className="space-y-2 border-b border-border p-3">
          <Select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            aria-label="Instância"
            className="h-9"
          >
            <option value="">Todas as instâncias</option>
            {accounts.data?.items
              .filter((a) => a.connectionType === 'WHATSAPP_WEB')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
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
              aria-label="Pesquisar conversas"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'rounded-md px-2 py-1 text-xs',
                  filter === f.value ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {convs.isPending && (
            <li className="p-4">
              <Spinner />
            </li>
          )}
          {items.length === 0 && !convs.isPending && (
            <li className="px-4 py-10 text-center text-sm text-subtle">
              Nenhuma conversa{filter !== 'all' ? ' neste filtro' : ''}.
            </li>
          )}
          {items.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setSelected(c.id)}
                className={cn(
                  'flex w-full gap-3 border-b border-border/60 px-3 py-3 text-left transition-colors',
                  selected === c.id ? 'bg-accent-soft' : 'hover:bg-surface-2/60',
                )}
              >
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold text-muted"
                  aria-hidden
                >
                  {displayName(c)
                    .replace(/[^A-Za-zÀ-ú ]/g, '')
                    .split(' ')
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((p) => p[0])
                    .join('')
                    .toUpperCase() || '#'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        'truncate text-sm',
                        c.unreadCount ? 'font-semibold text-fg' : 'text-fg/90',
                      )}
                    >
                      {displayName(c)}
                    </span>
                    <span className="shrink-0 text-[11px] text-subtle">
                      {shortTime(c.lastMessageAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-muted">
                      {c.lastMessagePreview ?? ''}
                    </span>
                    {c.unreadCount > 0 && (
                      <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-[#04130d]">
                        {c.unreadCount}
                      </span>
                    )}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5">
                    <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-muted">
                      {c.accountName}
                    </span>
                    {c.status !== 'OPEN' && (
                      <span className="text-[10px] text-subtle">
                        {CONVERSATION_STATUS_LABEL[c.status]}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-subtle">
          Somente mensagens recebidas pelas sessões conectadas (e o histórico recente entregue pelo
          WhatsApp ao parear).
        </p>
      </aside>

      <section className="min-h-0 min-w-0">
        {selected ? (
          <Thread key={selected} id={selected} />
        ) : (
          <div className="grid h-full place-items-center">
            <EmptyState
              icon={MessagesSquare}
              title="Selecione uma conversa"
              description="As conversas das instâncias conectadas aparecem à esquerda."
            />
          </div>
        )}
      </section>

      <aside className="hidden min-h-0 overflow-y-auto border-l border-border bg-bg-soft p-5 xl:block">
        {selected ? (
          <ContactPanel key={selected} id={selected} />
        ) : (
          <p className="text-sm text-subtle">Os dados do contato aparecem aqui.</p>
        )}
      </aside>
    </div>
  );
}
