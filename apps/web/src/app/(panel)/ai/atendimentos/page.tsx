'use client';
import { useEffect, useState } from 'react';
import { Bot, Check, MessageSquare, Pause, Play, Trash2, UserRound } from 'lucide-react';
import { formatPhone, type AiConversationDTO, type AiConversationState } from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Select,
  Spinner,
  cn,
  type Tone,
} from '@multizap/ui';
import { useAccounts } from '@/lib/accounts';
import { formatDateTime, timeAgo } from '@/lib/format';
import { useMessages } from '@/lib/inbox';
import { useAiConversations, useAiDrafts, useAiMutation } from '@/lib/ai';
import { Textarea } from '@/components/ai/textarea';

const FILTERS = [
  { value: 'all', label: 'Todas' },
  { value: 'review', label: 'Aguardando revisão' },
  { value: 'serving', label: 'IA atendendo' },
  { value: 'paused', label: 'Pausadas' },
  { value: 'blocked', label: 'Precisam de atenção' },
];

const STATE: Record<AiConversationState, { label: string; tone: Tone }> = {
  review: { label: 'Revisar', tone: 'warning' },
  serving: { label: 'IA atendendo', tone: 'success' },
  paused: { label: 'Pausada', tone: 'neutral' },
  blocked: { label: 'Atenção', tone: 'danger' },
};

const title = (c: AiConversationDTO) =>
  c.title ?? (c.phoneE164 ? formatPhone(c.phoneE164) : 'Contato sem número identificado');

function Thread({ conversationId }: { conversationId: string }) {
  const messages = useMessages(conversationId);
  const items = messages.data?.items ?? [];
  if (messages.isLoading) return <Spinner />;
  return (
    <div className="max-h-[420px] space-y-2 overflow-y-auto rounded-lg border border-border bg-bg-soft p-3">
      {!items.length && <p className="text-sm text-muted">Sem mensagens.</p>}
      {items.map((m) => (
        <div
          key={m.id}
          className={cn('flex', m.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start')}
        >
          <div
            className={cn(
              'max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap',
              m.direction === 'OUTBOUND' ? 'bg-accent-soft text-fg' : 'bg-surface-2 text-fg',
            )}
          >
            {m.body ?? `(${m.type})`}
            <p className="mt-1 flex items-center gap-1.5 text-[10px] text-subtle">
              {formatDateTime(m.sentAt)}
              {m.byAi && <Badge tone="info">IA</Badge>}
              {m.fromCampaign && <Badge>Campanha</Badge>}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function DraftBox({ conversationId }: { conversationId: string }) {
  const drafts = useAiDrafts(conversationId);
  const approve = useAiMutation();
  const discard = useAiMutation();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const items = drafts.data ?? [];
  if (!items.length) return null;
  return (
    <div className="space-y-3">
      {items.map((d) => {
        const text = edits[d.id] ?? d.body;
        return (
          <Card key={d.id} className="border-warning/40">
            <CardContent className="space-y-3 pt-5">
              <p className="text-sm font-medium text-fg">
                Resposta sugerida por {d.agentName}
                <span className="ml-2 text-xs font-normal text-subtle">{timeAgo(d.createdAt)}</span>
              </p>
              {d.inboundText && (
                <p className="text-xs text-muted">Em resposta a: “{d.inboundText}”</p>
              )}
              <p className="text-xs text-subtle">
                {d.sources.length
                  ? `Baseada em: ${[...new Set(d.sources.map((x) => x.name))].join(', ')}`
                  : 'Sem base de conhecimento nesta resposta: confira os fatos antes de enviar.'}
              </p>
              <Textarea
                aria-label="Resposta sugerida"
                rows={4}
                value={text}
                maxLength={4000}
                onChange={(e) => setEdits((x) => ({ ...x, [d.id]: e.target.value }))}
              />
              {(approve.error || discard.error) && (
                <Alert tone="danger">{((approve.error ?? discard.error) as Error).message}</Alert>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  loading={approve.isPending && approve.variables?.path.includes(d.id)}
                  disabled={!text.trim()}
                  onClick={() =>
                    approve.mutate({
                      path: `/ai/drafts/${d.id}/approve`,
                      json: text !== d.body ? { text } : {},
                    })
                  }
                >
                  <Check className="h-4 w-4" />{' '}
                  {text !== d.body ? 'Enviar editada' : 'Aprovar e enviar'}
                </Button>
                <Button
                  variant="ghost"
                  loading={discard.isPending && discard.variables?.path.includes(d.id)}
                  onClick={() => discard.mutate({ path: `/ai/drafts/${d.id}/discard` })}
                >
                  <Trash2 className="h-4 w-4" /> Descartar
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function Detail({ c }: { c: AiConversationDTO }) {
  const act = useAiMutation();
  const s = STATE[c.state];
  const set = (json: { paused?: boolean; enabled?: boolean }) =>
    act.mutate({ path: `/ai/conversations/${c.id}/state`, method: 'PUT', json });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-fg">{title(c)}</p>
          <p className="text-xs text-subtle">
            {c.accountName}
            {c.phoneE164 ? ` · ${formatPhone(c.phoneE164)}` : ''}
          </p>
        </div>
        <Badge tone={s.tone} dot>
          {s.label}
        </Badge>
      </div>
      {c.reason && (
        <Alert tone={c.state === 'blocked' ? 'warning' : 'info'}>
          {c.reason}
          {c.state === 'paused' && c.pausedBy === 'human' && (
            <> A IA só volta a responder quando você retomar.</>
          )}
        </Alert>
      )}
      {act.error && <Alert tone="danger">{(act.error as Error).message}</Alert>}
      <div className="flex flex-wrap gap-2">
        {c.state === 'paused' ? (
          <Button size="sm" loading={act.isPending} onClick={() => set({ paused: false })}>
            <Play className="h-3.5 w-3.5" /> Retomar IA nesta conversa
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={act.isPending}
            onClick={() => set({ paused: true })}
          >
            <Pause className="h-3.5 w-3.5" /> Pausar IA nesta conversa
          </Button>
        )}
        {c.state === 'blocked' && /campanha/i.test(c.reason ?? '') && (
          <Button
            size="sm"
            variant="secondary"
            loading={act.isPending}
            onClick={() => set({ enabled: true })}
          >
            <Bot className="h-3.5 w-3.5" /> Liberar a IA mesmo assim
          </Button>
        )}
        {c.enabledOverride && (
          <Button size="sm" variant="ghost" onClick={() => set({ enabled: false })}>
            Desfazer liberação
          </Button>
        )}
      </div>
      <DraftBox conversationId={c.id} />
      <Thread conversationId={c.id} />
      <p className="text-xs text-subtle">
        Para escrever você mesmo, use a Central de mensagens: ao responder, a IA se afasta desta
        conversa automaticamente.
      </p>
    </div>
  );
}

export default function AttendancePage() {
  const accounts = useAccounts();
  const [filter, setFilter] = useState('all');
  const [accountId, setAccountId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useAiConversations(filter, accountId);
  const items = list.data ?? [];
  const current = items.find((c) => c.id === selected) ?? null;
  useEffect(() => {
    if (selected && list.data && !current) setSelected(null);
  }, [selected, list.data, current]);

  return (
    <div className="space-y-4">
      <Alert tone="info">
        Aqui ficam as conversas das instâncias com agente ativo. No modo{' '}
        <strong>Revisão humana</strong>, cada resposta da IA espera sua aprovação antes de ir para o
        contato.
      </Alert>
      <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
        <Select aria-label="Filtro" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Instância"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
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
      </div>
      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="h-fit">
          {list.isLoading ? (
            <div className="p-5">
              <Spinner />
            </div>
          ) : list.error ? (
            <div className="p-4">
              <Alert tone="danger">{(list.error as Error).message}</Alert>
            </div>
          ) : !items.length ? (
            <EmptyState
              icon={MessageSquare}
              title="Nenhuma conversa"
              description="Ative um agente em uma instância conectada. As conversas dela aparecem aqui."
            />
          ) : (
            <ul className="max-h-[640px] divide-y divide-border overflow-y-auto">
              {items.map((c) => {
                const st = STATE[c.state];
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(c.id)}
                      aria-current={c.id === selected}
                      className={cn(
                        'flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-surface-2',
                        c.id === selected && 'bg-surface-3',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-fg">
                          <UserRound className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                          <span className="truncate">{title(c)}</span>
                        </span>
                        <Badge tone={st.tone}>
                          {c.state === 'review' ? `${c.pendingDrafts} p/ revisar` : st.label}
                        </Badge>
                      </span>
                      <span className="truncate text-xs text-muted">
                        {c.lastMessagePreview ?? '—'}
                      </span>
                      <span className="text-[11px] text-subtle">
                        {c.accountName}
                        {c.lastMessageAt ? ` · ${timeAgo(c.lastMessageAt)}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card>
          <CardContent className="pt-5">
            {current ? (
              <Detail c={current} />
            ) : (
              <EmptyState
                icon={Bot}
                title="Escolha uma conversa"
                description="Veja o que a IA respondeu, aprove ou descarte rascunhos e pause a IA em uma conversa."
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
