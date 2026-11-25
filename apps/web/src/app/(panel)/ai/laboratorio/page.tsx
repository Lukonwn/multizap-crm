'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical, Plus, Send, Trash2 } from 'lucide-react';
import type { TestMessageDTO, TestSessionDTO } from '@multizap/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Segmented,
  Select,
  Spinner,
  cn,
} from '@multizap/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { aiKeys, formatUsd, useAgents, useAiMutation, useTestSession } from '@/lib/ai';
import { Textarea } from '@/components/ai/textarea';

interface SessionRow {
  id: string;
  source: 'draft' | 'published';
  createdAt: string;
  messages: number;
}

function Bubble({
  m,
  onSelect,
  active,
}: {
  m: TestMessageDTO;
  onSelect: () => void;
  active: boolean;
}) {
  const mine = m.role === 'user';
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'max-w-[85%] rounded-xl px-3 py-2 text-left text-sm whitespace-pre-wrap',
          mine && 'bg-accent-soft text-fg',
          m.role === 'assistant' && 'bg-surface-2 text-fg',
          m.role === 'error' && 'border border-danger/30 bg-danger-soft text-danger',
          active && 'ring-2 ring-accent/40',
        )}
      >
        {m.content}
      </button>
    </div>
  );
}

function DebugPanel({ m, session }: { m: TestMessageDTO | null; session: TestSessionDTO }) {
  const d = m?.debug;
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Detalhes técnicos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <dt className="text-muted">Sessão</dt>
          <dd className="text-fg">
            {session.source === 'draft' ? 'Rascunho' : `Publicada v${session.versionNumber ?? '?'}`}
          </dd>
          <dt className="text-muted">Tokens (total)</dt>
          <dd className="text-fg">
            {session.totals.promptTokens} + {session.totals.completionTokens}
          </dd>
          <dt className="text-muted">Custo (total)</dt>
          <dd className="text-fg">{formatUsd(session.totals.costUsd)}</dd>
        </dl>
        {!m ? (
          <p className="text-muted">Clique em uma resposta para ver os detalhes dela.</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-3">
              {d?.model && (
                <>
                  <dt className="text-muted">Modelo</dt>
                  <dd className="break-all text-fg">{d.model}</dd>
                </>
              )}
              {d?.promptTokens !== undefined && (
                <>
                  <dt className="text-muted">Tokens</dt>
                  <dd className="text-fg">
                    {d.promptTokens} entrada · {d.completionTokens ?? 0} saída
                  </dd>
                </>
              )}
              {d?.costUsd !== undefined && (
                <>
                  <dt className="text-muted">Custo</dt>
                  <dd className="text-fg">
                    {formatUsd(d.costUsd)} {d.costConfirmed === false && '(estimado)'}
                  </dd>
                </>
              )}
              {d?.latencyMs !== undefined && (
                <>
                  <dt className="text-muted">Tempo</dt>
                  <dd className="text-fg">{(d.latencyMs / 1000).toFixed(1)} s</dd>
                </>
              )}
              {d?.errorCode && (
                <>
                  <dt className="text-muted">Erro</dt>
                  <dd className="break-all text-danger">{d.errorCode}</dd>
                </>
              )}
            </dl>
            {d?.delivery && (
              <div className="border-t border-border pt-3">
                <p className="mb-1.5 text-xs font-medium text-muted">Simulação de entrega</p>
                <p className="text-sm text-fg">
                  O agente entregaria: <strong>{d.delivery.name}</strong> ({d.delivery.code})
                </p>
                <p className="text-xs text-muted">
                  {d.delivery.condition}; {d.delivery.approval}
                  {d.delivery.adultOnly ? '; só para adultos confirmados' : ''}.
                </p>
                <p className="mt-1 text-xs text-subtle">
                  Nada foi criado nem enviado: o laboratório só simula.
                </p>
              </div>
            )}
            {d?.knowledge !== undefined && (
              <div className="border-t border-border pt-3">
                <p className="mb-1.5 text-xs font-medium text-muted">Trechos da base usados</p>
                {d.knowledge.length ? (
                  <ul className="space-y-2">
                    {d.knowledge.map((k, i) => (
                      <li key={i} className="rounded-lg bg-bg-soft p-2 text-xs">
                        <p className="font-medium text-fg">{k.name}</p>
                        <p className="text-muted">{k.snippet}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">
                    Nenhum trecho da base correspondeu a esta pergunta.
                  </p>
                )}
              </div>
            )}
            {d?.systemPrompt && (
              <details>
                <summary className="cursor-pointer text-xs font-medium text-muted">
                  Instruções enviadas ao modelo
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-bg-soft p-2 text-xs whitespace-pre-wrap text-muted">
                  {d.systemPrompt}
                </pre>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Lab() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const agents = useAgents();
  const agentId = params.get('agente') ?? '';
  const agent = agents.data?.items.find((a) => a.id === agentId) ?? null;
  const [source, setSource] = useState<'draft' | 'published'>('draft');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const sessions = useQuery({
    queryKey: [...aiKeys.agent(agentId), 'sessions'],
    queryFn: () =>
      api<{ items: SessionRow[] }>(`/ai/agents/${agentId}/test-sessions`).then((r) => r.items),
    enabled: !!agentId,
  });
  const session = useTestSession(sessionId);
  const start = useAiMutation<{ session: TestSessionDTO }>();
  const send = useAiMutation();
  const discard = useAiMutation();

  useEffect(() => {
    setSessionId(null);
    setSelected(null);
  }, [agentId]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [session.data?.messages.length, send.isPending]);

  const pickAgent = (id: string) => {
    const p = new URLSearchParams(params.toString());
    if (id) p.set('agente', id);
    else p.delete('agente');
    router.replace(`${pathname}?${p.toString()}`);
  };

  const newSession = () =>
    start.mutate(
      { path: `/ai/agents/${agentId}/test-sessions`, json: { source } },
      { onSuccess: (r) => setSessionId(r.session.id) },
    );

  const submit = () => {
    const t = text.trim();
    if (!t || !sessionId) return;
    send.mutate(
      { path: `/ai/test-sessions/${sessionId}/messages`, json: { text: t } },
      { onSuccess: () => setText('') },
    );
  };

  const messages = session.data?.messages ?? [];
  const selectedMsg =
    messages.find((m) => m.id === selected) ??
    [...messages].reverse().find((m) => m.role !== 'user') ??
    null;

  return (
    <div className="space-y-4">
      <Alert tone="info" title="Simulação">
        Nada do que acontece aqui é enviado a contatos ou ao WhatsApp. O consumo de tokens é real e
        aparece nos detalhes.
      </Alert>
      <Card>
        <CardContent className="grid gap-4 pt-5 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
          <Field label="Agente" htmlFor="lab-agent">
            <Select id="lab-agent" value={agentId} onChange={(e) => pickAgent(e.target.value)}>
              <option value="">Escolha um agente…</option>
              {agents.data?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Testar</p>
            <Segmented
              value={source}
              onChange={setSource}
              options={[
                { value: 'draft', label: 'Rascunho' },
                { value: 'published', label: 'Versão publicada' },
              ]}
            />
          </div>
          <Button
            onClick={newSession}
            loading={start.isPending}
            disabled={!agent || (source === 'published' && !agent.publishedVersion)}
            title={
              agent && source === 'published' && !agent.publishedVersion
                ? 'Este agente ainda não tem versão publicada'
                : undefined
            }
          >
            <Plus className="h-4 w-4" /> Nova conversa de teste
          </Button>
        </CardContent>
      </Card>
      {start.error && <Alert tone="danger">{(start.error as Error).message}</Alert>}

      {!agentId ? (
        <Card>
          <EmptyState
            icon={FlaskConical}
            title="Escolha um agente para testar"
            description="Converse com o agente como se fosse um cliente e veja como ele responde antes de publicar."
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)_320px]">
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Conversas de teste</CardTitle>
            </CardHeader>
            <CardContent>
              {sessions.isLoading ? (
                <Spinner />
              ) : !sessions.data?.length ? (
                <p className="text-sm text-muted">Nenhuma ainda.</p>
              ) : (
                <ul className="space-y-1">
                  {sessions.data.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSessionId(s.id);
                          setSelected(null);
                        }}
                        className={cn(
                          'w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-surface-2',
                          s.id === sessionId && 'bg-surface-3',
                        )}
                      >
                        <span className="block text-fg">
                          {s.source === 'draft' ? 'Rascunho' : 'Publicada'} · {s.messages} msg
                        </span>
                        <span className="text-subtle">{formatDateTime(s.createdAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="flex min-h-[420px] flex-col">
            {!sessionId ? (
              <EmptyState
                icon={FlaskConical}
                title="Comece uma conversa de teste"
                description="Use o botão acima ou abra uma conversa anterior."
              />
            ) : session.isLoading ? (
              <div className="p-5">
                <Spinner />
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <p className="text-sm font-medium text-fg">
                    {session.data?.source === 'draft'
                      ? 'Testando o rascunho'
                      : `Testando a versão publicada v${session.data?.versionNumber ?? '?'}`}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Apagar conversa de teste"
                    loading={discard.isPending}
                    onClick={() =>
                      discard.mutate(
                        { path: `/ai/test-sessions/${sessionId}`, method: 'DELETE' },
                        {
                          onSuccess: () => {
                            setSessionId(null);
                            void sessions.refetch();
                          },
                        },
                      )
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex-1 space-y-2 overflow-y-auto p-4" aria-live="polite">
                  {!messages.length && (
                    <p className="text-center text-sm text-muted">
                      Escreva como se fosse um cliente.
                    </p>
                  )}
                  {messages.map((m) => (
                    <Bubble
                      key={m.id}
                      m={m}
                      active={m.id === selectedMsg?.id}
                      onSelect={() => setSelected(m.id)}
                    />
                  ))}
                  {send.isPending && (
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <Spinner className="h-4 w-4" /> O agente está respondendo…
                    </div>
                  )}
                  <div ref={endRef} />
                </div>
                {send.error && (
                  <Alert tone="danger" className="mx-4 mb-2">
                    {(send.error as Error).message}
                  </Alert>
                )}
                <form
                  className="flex gap-2 border-t border-border p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit();
                  }}
                >
                  <Textarea
                    aria-label="Mensagem de teste"
                    rows={2}
                    value={text}
                    maxLength={4000}
                    placeholder="Mensagem do cliente…"
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                  />
                  <Button type="submit" loading={send.isPending} disabled={!text.trim()}>
                    <Send className="h-4 w-4" />
                    <span className="sr-only">Enviar mensagem de teste</span>
                  </Button>
                </form>
              </>
            )}
          </Card>

          {session.data ? (
            <DebugPanel m={selectedMsg} session={session.data} />
          ) : (
            <div className="hidden xl:block" />
          )}
        </div>
      )}
    </div>
  );
}

export default function LabPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Lab />
    </Suspense>
  );
}
