'use client';
import Link from 'next/link';
import { AGENT_MODE_LABEL, AGENT_STATUS_LABEL } from '@multizap/shared';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
  StatusDot,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  type Tone,
} from '@multizap/ui';
import { formatDateTime, timeAgo } from '@/lib/format';
import { formatUsd, useAiHealth } from '@/lib/ai';
import { AgentStatusBadge } from '@/components/ai/agent-status';

const CATEGORY: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  OPENROUTER: 'OpenRouter',
  AGENT: 'Agente',
  KNOWLEDGE: 'Conhecimento',
  DELIVERY: 'Entrega',
};

export default function HealthPage() {
  const q = useAiHealth();
  const h = q.data;
  if (q.isLoading || !h)
    return q.error ? <Alert tone="danger">{(q.error as Error).message}</Alert> : <Spinner />;

  const issues: [string, number, string][] = [
    ['Fontes de conhecimento com erro', h.issues.sourcesWithError, '/ai/conhecimento'],
    ['Fontes presas em “processando”', h.issues.sourcesStuck, '/ai/conhecimento'],
    ['Entregas que falharam (7 dias)', h.issues.deliveriesFailed7d, '/ai/atendimentos'],
    ['Entregas bloqueadas (7 dias)', h.issues.deliveriesBlocked7d, '/ai/atendimentos'],
    ['Contatos que dizem ter pago', h.issues.paymentsClaimed, '/ai/atendimentos'],
    ['Conversas travadas por possível menor', h.issues.minorLocksOpen, '/ai/atendimentos'],
  ];

  return (
    <div className="space-y-6">
      {h.alerts.length ? (
        <div className="space-y-2">
          {h.alerts.map((a, i) => (
            <Alert key={i} tone={a.level === 'error' ? 'danger' : 'warning'}>
              {a.text}{' '}
              {a.href && (
                <Link className="underline" href={a.href}>
                  Resolver
                </Link>
              )}
            </Alert>
          ))}
        </div>
      ) : (
        <Alert tone="success">Tudo certo: nenhum alerta no momento.</Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Serviços</CardTitle>
            <CardDescription>Precisam estar no ar para a IA responder.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(
              [
                ['Worker (gera as respostas)', h.services.worker],
                ['Gateway (WhatsApp)', h.services.gateway],
              ] as const
            ).map(([label, up]) => (
              <p key={label} className="flex items-center gap-2 text-fg">
                <StatusDot tone={up ? 'success' : 'danger'} /> {label}:{' '}
                {up ? 'no ar' : 'sem resposta'}
              </p>
            ))}
            <div className="pt-2">
              <p className="flex items-center gap-2 text-fg">
                <StatusDot
                  tone={
                    h.key.configured
                      ? h.key.lastTestOk === false
                        ? 'warning'
                        : 'success'
                      : 'danger'
                  }
                />
                Chave da OpenRouter:{' '}
                {h.key.configured
                  ? h.key.lastTestOk === false
                    ? 'último teste falhou'
                    : 'configurada'
                  : 'não configurada'}
              </p>
              {h.key.limitUsd !== null && (
                <p className="mt-1 text-muted">
                  Créditos: usou {formatUsd(h.key.usageUsd)} de {formatUsd(h.key.limitUsd)} · restam{' '}
                  <span className="text-fg">{formatUsd(h.key.remainingUsd)}</span>
                </p>
              )}
              {h.key.lastTestAt && (
                <p className="mt-1 text-xs text-subtle">
                  Último teste: {formatDateTime(h.key.lastTestAt)}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Filas</CardTitle>
            <CardDescription>Trabalhos da IA esperando ou com falha.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Fila</TH>
                  <TH>Esperando</TH>
                  <TH>Em andamento</TH>
                  <TH>Com falha</TH>
                </TR>
              </THead>
              <TBody>
                {h.queues.map((qu) => (
                  <TR key={qu.name}>
                    <TD>{qu.label}</TD>
                    <TD>{qu.waiting + qu.delayed}</TD>
                    <TD>{qu.active}</TD>
                    <TD className={qu.failed ? 'text-danger' : undefined}>{qu.failed}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Agentes</CardTitle>
          </CardHeader>
          <CardContent>
            {!h.agents.length ? (
              <p className="text-sm text-muted">Nenhum agente criado.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Agente</TH>
                    <TH>Situação</TH>
                    <TH>Modo</TH>
                    <TH>Instâncias</TH>
                    <TH>Rascunhos</TH>
                    <TH>Último erro</TH>
                  </TR>
                </THead>
                <TBody>
                  {h.agents.map((a) => (
                    <TR key={a.id}>
                      <TD>
                        <Link className="text-fg hover:underline" href={`/ai/agentes/${a.id}`}>
                          {a.name}
                        </Link>
                      </TD>
                      <TD>
                        <AgentStatusBadge status={a.status} />
                      </TD>
                      <TD>{AGENT_MODE_LABEL[a.mode]}</TD>
                      <TD>{a.accounts}</TD>
                      <TD>
                        {a.pendingDrafts ? (
                          <Badge tone="warning">{a.pendingDrafts} p/ revisar</Badge>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD className="max-w-[260px] truncate text-xs text-muted">
                        {a.lastError ? `${a.lastError.message} (${timeAgo(a.lastError.at)})` : '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pendências</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {issues.map(([label, n, href]) => (
                <li key={label} className="flex items-center justify-between gap-3">
                  <span className="text-fg">{label}</span>
                  {n ? (
                    <Link href={href}>
                      <Badge tone={'warning' as Tone}>{n}</Badge>
                    </Link>
                  ) : (
                    <span className="text-muted">0</span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Eventos recentes</CardTitle>
            <CardDescription>Avisos e erros dos agentes.</CardDescription>
          </CardHeader>
          <CardContent>
            {!h.events.length ? (
              <p className="text-sm text-muted">Nenhum aviso ou erro registrado.</p>
            ) : (
              <ul className="max-h-80 space-y-2 overflow-y-auto text-sm">
                {h.events.map((e) => (
                  <li key={e.id} className="rounded-lg border border-border p-2">
                    <p className="flex flex-wrap items-center gap-2">
                      <Badge tone={e.level === 'error' ? 'danger' : 'warning'}>
                        {CATEGORY[e.category] ?? e.category}
                      </Badge>
                      {e.agentName && <span className="text-xs text-subtle">{e.agentName}</span>}
                      <span className="text-xs text-subtle">{timeAgo(e.createdAt)}</span>
                    </p>
                    <p className="mt-1 text-muted">{e.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-subtle">
        Atualiza sozinho a cada 15 segundos. Situação dos agentes:{' '}
        {Object.values(AGENT_STATUS_LABEL).join(', ')}.
      </p>
    </div>
  );
}
