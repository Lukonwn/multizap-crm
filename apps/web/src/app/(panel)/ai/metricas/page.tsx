'use client';
import { useState } from 'react';
import {
  Bot,
  Clock,
  Coins,
  Gauge,
  MessageSquare,
  ShieldCheck,
  ThumbsUp,
  Wallet,
} from 'lucide-react';
import { DELIVERY_STATUS_LABEL, formatBRL } from '@multizap/shared';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  Spinner,
  StatCard,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@multizap/ui';
import { useAccounts } from '@/lib/accounts';
import { formatNumber } from '@/lib/format';
import { formatUsd, useAgents, useAnalytics } from '@/lib/ai';
import { LineChart } from '@/components/reports/line-chart';

const pct = (v: number | null) => (v === null ? null : `${Math.round(v * 100)}%`);
const secs = (v: number | null) =>
  v === null ? null : v < 90 ? `${Math.round(v)} s` : `${Math.round(v / 60)} min`;
const PAUSE_LABEL: Record<string, string> = {
  human: 'Uma pessoa respondeu',
  admin: 'Pausada por você',
  minor: 'Possível menor de idade',
  campaign: 'Campanha recente',
  limit: 'Limite de respostas',
};

export default function MetricsPage() {
  const [days, setDays] = useState(30);
  const [agentId, setAgentId] = useState('');
  const [accountId, setAccountId] = useState('');
  const agents = useAgents();
  const accounts = useAccounts();
  const q = useAnalytics(days, agentId, accountId);
  const m = q.data;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3 lg:max-w-3xl">
        <Select aria-label="Período" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Últimos 7 dias</option>
          <option value={30}>Últimos 30 dias</option>
          <option value={90}>Últimos 90 dias</option>
        </Select>
        <Select aria-label="Agente" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Todos os agentes</option>
          {agents.data?.items.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
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

      {q.isLoading || !m ? (
        q.error ? (
          <Alert tone="danger">{(q.error as Error).message}</Alert>
        ) : (
          <Spinner />
        )
      ) : (
        <>
          <p className="text-xs text-subtle">
            Tudo calculado dos registros reais. Onde não há dado, aparece “—”, nunca um número
            inventado.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Conversas atendidas"
              icon={MessageSquare}
              value={formatNumber(m.totals.conversations)}
            />
            <StatCard
              label="Respostas da IA"
              icon={Bot}
              value={formatNumber(m.totals.replies)}
              hint={`${m.totals.autoSent} automáticas · ${m.totals.approved} aprovadas · ${m.totals.discarded} descartadas · ${m.totals.pending} pendentes`}
            />
            <StatCard
              label="Aprovação dos rascunhos"
              icon={ThumbsUp}
              value={pct(m.totals.approvalRate)}
              hint={
                m.totals.editedRate === null
                  ? undefined
                  : `${pct(m.totals.editedRate)} dos aprovados foram editados`
              }
            />
            <StatCard
              label="Resposta automática (mediana)"
              icon={Clock}
              value={secs(m.totals.responseSeconds.median)}
              hint={
                m.totals.responseSeconds.p90 === null
                  ? undefined
                  : `90% em até ${secs(m.totals.responseSeconds.p90)}`
              }
            />
            <StatCard
              label="Usaram a base de conhecimento"
              icon={ShieldCheck}
              value={pct(m.totals.knowledgeUseRate)}
            />
            <StatCard
              label="Custo do atendimento"
              icon={Coins}
              value={m.usage.live.calls ? formatUsd(m.usage.live.costUsd) : null}
              hint={
                m.costPerReply === null ? undefined : `${formatUsd(m.costPerReply)} por resposta`
              }
            />
            <StatCard
              label="Vendas confirmadas"
              icon={Wallet}
              value={
                m.deliveries.payments.confirmed
                  ? formatBRL(m.deliveries.payments.revenueCents)
                  : null
              }
              hint={`${m.deliveries.payments.confirmed} de ${m.deliveries.payments.created} pedidos pagos`}
            />
            <StatCard
              label="Conversão de pedidos"
              icon={Gauge}
              value={pct(m.deliveries.conversion)}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Por dia</CardTitle>
              <CardDescription>
                Respostas da IA, quantas saíram sozinhas e entregas enviadas.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LineChart
                dates={m.daily.map((d) => d.date)}
                series={[
                  {
                    key: 'replies',
                    label: 'Respostas',
                    color: '#3987e5',
                    values: m.daily.map((d) => d.replies),
                  },
                  {
                    key: 'auto',
                    label: 'Automáticas',
                    color: '#199e70',
                    values: m.daily.map((d) => d.autoSent),
                  },
                  {
                    key: 'deliveries',
                    label: 'Entregas enviadas',
                    color: '#d95926',
                    values: m.daily.map((d) => d.deliveries),
                  },
                ]}
              />
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Por agente</CardTitle>
              </CardHeader>
              <CardContent>
                {!m.perAgent.length ? (
                  <p className="text-sm text-muted">Sem atendimento no período.</p>
                ) : (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Agente</TH>
                        <TH>Respostas</TH>
                        <TH>Tokens</TH>
                        <TH>Custo</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {m.perAgent.map((a) => (
                        <TR key={a.agentId}>
                          <TD>{a.name}</TD>
                          <TD>{a.replies}</TD>
                          <TD>{formatNumber(a.promptTokens + a.completionTokens)}</TD>
                          <TD>{formatUsd(a.costUsd)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Consumo por uso</CardTitle>
                <CardDescription>Tokens e custo registrados pela OpenRouter.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <THead>
                    <TR>
                      <TH>Uso</TH>
                      <TH>Chamadas</TH>
                      <TH>Tokens</TH>
                      <TH>Custo</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {(
                      [
                        ['Atendimento real', m.usage.live],
                        ['Laboratório', m.usage.test],
                        ['Gerador de Persona', m.usage.generator],
                      ] as const
                    ).map(([label, u]) => (
                      <TR key={label}>
                        <TD>{label}</TD>
                        <TD>{u.calls}</TD>
                        <TD>{formatNumber(u.promptTokens + u.completionTokens)}</TD>
                        <TD>{u.calls ? formatUsd(u.costUsd) : '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Fontes mais usadas</CardTitle>
                <CardDescription>
                  Da base de conhecimento, nas respostas do período.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!m.topSources.length ? (
                  <p className="text-sm text-muted">Nenhuma fonte foi usada no período.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {m.topSources.map((s) => (
                      <li key={s.name} className="flex justify-between gap-3">
                        <span className="truncate text-fg">{s.name}</span>
                        <span className="text-muted">{s.uses}×</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Quando a IA parou</CardTitle>
                <CardDescription>Conversas pausadas no período, por motivo.</CardDescription>
              </CardHeader>
              <CardContent>
                {!Object.keys(m.totals.paused).length ? (
                  <p className="text-sm text-muted">Nenhuma pausa no período.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {Object.entries(m.totals.paused).map(([k, n]) => (
                      <li key={k} className="flex justify-between gap-3">
                        <span className="text-fg">{PAUSE_LABEL[k] ?? k}</span>
                        <span className="text-muted">{n}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Entregas</CardTitle>
              </CardHeader>
              <CardContent>
                {!Object.keys(m.deliveries.byStatus).length ? (
                  <p className="text-sm text-muted">Nenhuma entrega no período.</p>
                ) : (
                  <ul className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                    {Object.entries(m.deliveries.byStatus).map(([k, n]) => (
                      <li key={k}>
                        <span className="text-muted">{DELIVERY_STATUS_LABEL[k] ?? k}: </span>
                        <span className="text-fg">{n}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
