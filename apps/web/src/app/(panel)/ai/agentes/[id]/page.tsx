'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, FlaskConical, Rocket, RotateCcw, Trash2 } from 'lucide-react';
import {
  ACCOUNT_STATUS_LABEL,
  AGENT_MODES,
  AGENT_MODE_LABEL,
  formatPhone,
  type AgentDTO,
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
  Select,
  Spinner,
} from '@multizap/ui';
import { ApiError } from '@/lib/api';
import { STATUS_TONE, useAccounts } from '@/lib/accounts';
import { formatDateTime } from '@/lib/format';
import { useAgent, useAgentVersions, useAiMutation, usePersonas } from '@/lib/ai';
import { AgentStatusBadge } from '@/components/ai/agent-status';
import { ConfirmNameModal } from '@/components/ai/confirm-name-modal';
import { ModelPicker } from '@/components/ai/model-picker';
import { Textarea } from '@/components/ai/textarea';

interface Draft {
  name: string;
  personaId: string;
  model: string;
  temperature: string;
  maxTokens: string;
  instructions: string;
  memoryEnabled: boolean;
  mode: AgentDTO['mode'];
}

const toDraft = (a: AgentDTO): Draft => ({
  name: a.name,
  personaId: a.personaId,
  model: a.model,
  temperature: a.temperature === null ? '' : String(a.temperature),
  maxTokens: String(a.maxTokens),
  instructions: a.instructions ?? '',
  memoryEnabled: a.memoryEnabled,
  mode: a.mode,
});

function GeneralCard({ agent }: { agent: AgentDTO }) {
  const personas = usePersonas('false');
  const save = useAiMutation();
  const [d, setD] = useState<Draft>(() => toDraft(agent));
  const [saved, setSaved] = useState(false);
  useEffect(() => setD(toDraft(agent)), [agent]);
  const fields = save.error instanceof ApiError ? (save.error.fields ?? {}) : {};
  const set = (p: Partial<Draft>) => {
    setSaved(false);
    setD((x) => ({ ...x, ...p }));
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          {
            path: `/ai/agents/${agent.id}`,
            method: 'PATCH',
            json: {
              name: d.name,
              personaId: d.personaId,
              model: d.model,
              temperature: d.temperature === '' ? null : Number(d.temperature),
              maxTokens: Number(d.maxTokens),
              instructions: d.instructions,
              memoryEnabled: d.memoryEnabled,
              mode: d.mode,
            },
          },
          { onSuccess: () => setSaved(true) },
        );
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Geral</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome" htmlFor="ag-name" error={fields.name?.[0]}>
            <Input id="ag-name" value={d.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Persona" htmlFor="ag-persona" error={fields.personaId?.[0]}>
            <Select
              id="ag-persona"
              value={d.personaId}
              onChange={(e) => set({ personaId: e.target.value })}
            >
              {personas.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Modo de resposta"
            htmlFor="ag-mode"
            hint={
              d.mode === 'AUTO'
                ? 'As respostas serão enviadas sem revisão. Use apenas depois de testar bastante.'
                : 'Cada resposta vira um rascunho para você aprovar antes do envio.'
            }
          >
            <Select
              id="ag-mode"
              value={d.mode}
              onChange={(e) => set({ mode: e.target.value as Draft['mode'] })}
            >
              {AGENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {AGENT_MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={d.memoryEnabled}
              onChange={(e) => set({ memoryEnabled: e.target.checked })}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Lembrar das conversas com cada contato
          </label>
          {d.mode === 'AUTO' && (
            <div className="sm:col-span-2">
              <Alert tone="warning" title="Modo automático">
                O agente responderá sozinho às mensagens recebidas. Respostas automáticas em excesso
                podem levar o WhatsApp a restringir o número.
              </Alert>
            </div>
          )}
          <div className="sm:col-span-2">
            <Field
              label="Instruções do agente"
              htmlFor="ag-instructions"
              hint="Somam-se às instruções da persona. Ex.: objetivo do atendimento, horários, quando chamar um humano."
              error={fields.instructions?.[0]}
            >
              <Textarea
                id="ag-instructions"
                rows={5}
                value={d.instructions}
                onChange={(e) => set({ instructions: e.target.value })}
              />
            </Field>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Modelo</CardTitle>
          <CardDescription>O modelo de IA usado nas respostas, pela OpenRouter.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <ModelPicker value={d.model} onChange={(m) => set({ model: m.id })} />
            {fields.model?.[0] && <p className="mt-1.5 text-xs text-danger">{fields.model[0]}</p>}
          </div>
          <Field
            label="Temperatura (opcional)"
            htmlFor="ag-temp"
            hint="0 = respostas mais previsíveis; valores maiores = mais variadas. Vazio usa o padrão do modelo."
            error={fields.temperature?.[0]}
          >
            <Input
              id="ag-temp"
              type="number"
              step="0.1"
              min={0}
              max={2}
              value={d.temperature}
              onChange={(e) => set({ temperature: e.target.value })}
            />
          </Field>
          <Field
            label="Limite de tokens por resposta"
            htmlFor="ag-max"
            error={fields.maxTokens?.[0]}
          >
            <Input
              id="ag-max"
              type="number"
              min={32}
              max={8000}
              value={d.maxTokens}
              onChange={(e) => set({ maxTokens: e.target.value })}
            />
          </Field>
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={save.isPending}>
          Salvar rascunho
        </Button>
        {saved && <span className="text-sm text-success">Rascunho salvo.</span>}
        {save.error && !Object.keys(fields).length && (
          <span className="text-sm text-danger">{(save.error as Error).message}</span>
        )}
      </div>
    </form>
  );
}

function AccountsCard({ agent }: { agent: AgentDTO }) {
  const accounts = useAccounts();
  const save = useAiMutation();
  const [selected, setSelected] = useState<string[]>(() => agent.accounts.map((a) => a.id));
  useEffect(() => setSelected(agent.accounts.map((a) => a.id)), [agent]);
  const web = (accounts.data?.items ?? []).filter((a) => a.connectionType === 'WHATSAPP_WEB');
  const linked = new Map(agent.accounts.map((a) => [a.id, a]));
  const dirty = selected.length !== agent.accounts.length || selected.some((id) => !linked.has(id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Instâncias</CardTitle>
        <CardDescription>
          Onde o agente vai atender quando estiver ativo. Só instâncias de aparelho conectado.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {accounts.isLoading ? (
          <Spinner />
        ) : !web.length ? (
          <p className="text-sm text-muted">Nenhuma instância de aparelho conectado cadastrada.</p>
        ) : (
          <ul className="space-y-2">
            {web.map((acc) => {
              const other = linked.get(acc.id)?.activeAgent;
              return (
                <li key={acc.id}>
                  <label className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--color-accent)]"
                      checked={selected.includes(acc.id)}
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked ? [...s, acc.id] : s.filter((x) => x !== acc.id),
                        )
                      }
                    />
                    <span className="font-medium text-fg">{acc.name}</span>
                    {acc.phoneE164 && (
                      <span className="text-xs text-subtle">{formatPhone(acc.phoneE164)}</span>
                    )}
                    <Badge tone={STATUS_TONE[acc.status]}>{ACCOUNT_STATUS_LABEL[acc.status]}</Badge>
                    {other && other.id !== agent.id && (
                      <Badge tone="warning">Atendida por {other.name}</Badge>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {save.error && <Alert tone="danger">{(save.error as Error).message}</Alert>}
        <Button
          variant="secondary"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() =>
            save.mutate({
              path: `/ai/agents/${agent.id}/accounts`,
              method: 'PUT',
              json: { accountIds: selected },
            })
          }
        >
          Salvar instâncias
        </Button>
      </CardContent>
    </Card>
  );
}

function PublishCard({ agent }: { agent: AgentDTO }) {
  const versions = useAgentVersions(agent.id);
  const publish = useAiMutation();
  const restore = useAiMutation<{ restoredFrom: number }>();
  const [note, setNote] = useState('');
  const [info, setInfo] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Publicação</CardTitle>
        <CardDescription>
          A versão publicada é a que atende. Editar o rascunho não muda nada até publicar de novo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {agent.publishedVersion ? (
            <>
              <span className="text-fg">Publicada: v{agent.publishedVersion.number}</span>
              {agent.hasUnpublishedChanges ? (
                <Badge tone="warning">Alterações não publicadas</Badge>
              ) : (
                <Badge tone="success">Em dia</Badge>
              )}
            </>
          ) : (
            <span className="text-muted">Ainda não publicado.</span>
          )}
        </div>
        <Field label="Nota da versão (opcional)" htmlFor="pub-note">
          <Input
            id="pub-note"
            value={note}
            maxLength={300}
            placeholder="Ex.: tom mais formal"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <Button
          loading={publish.isPending}
          disabled={!!agent.publishedVersion && !agent.hasUnpublishedChanges}
          onClick={() => {
            setInfo(null);
            publish.mutate(
              { path: `/ai/agents/${agent.id}/publish`, json: { note: note || undefined } },
              { onSuccess: () => setNote('') },
            );
          }}
        >
          <Rocket className="h-4 w-4" /> Publicar versão
        </Button>
        {publish.error && <Alert tone="danger">{(publish.error as Error).message}</Alert>}
        {info && <Alert tone="success">{info}</Alert>}
        {restore.error && <Alert tone="danger">{(restore.error as Error).message}</Alert>}
        <div>
          <p className="mb-2 text-xs font-medium text-muted">Versões</p>
          {versions.isLoading ? (
            <Spinner />
          ) : !versions.data?.length ? (
            <p className="text-sm text-muted">Nenhuma versão publicada.</p>
          ) : (
            <ul className="space-y-2">
              {versions.data.map((v) => (
                <li
                  key={v.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="text-fg">
                      v{v.number} {v.isPublished && <Badge tone="success">Publicada</Badge>}
                    </p>
                    <p className="text-xs text-subtle">
                      {formatDateTime(v.createdAt)} · {v.personaName} · {v.model}
                      {v.note ? ` · ${v.note}` : ''}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={restore.isPending && restore.variables?.path.includes(v.id)}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Trazer a v${v.number} para o rascunho? O rascunho atual será substituído; a versão publicada não muda.`,
                        )
                      )
                        return;
                      setInfo(null);
                      restore.mutate(
                        { path: `/ai/agents/${agent.id}/versions/${v.id}/restore` },
                        {
                          onSuccess: (r) =>
                            setInfo(
                              `Rascunho restaurado da v${r.restoredFrom}. Publique para usar.`,
                            ),
                        },
                      );
                    }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Restaurar
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const agent = useAgent(id);
  const del = useAiMutation();
  const [deleting, setDeleting] = useState(false);

  if (agent.isLoading) return <Spinner />;
  if (agent.error) return <Alert tone="danger">{(agent.error as Error).message}</Alert>;
  const a = agent.data!;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/ai/agentes">
              <ArrowLeft className="h-4 w-4" /> Agentes
            </Link>
          </Button>
          <h2 className="text-base font-semibold text-fg">{a.name}</h2>
          <AgentStatusBadge status={a.status} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" asChild>
            <Link href={`/ai/laboratorio?agente=${a.id}`}>
              <FlaskConical className="h-4 w-4" /> Testar no laboratório
            </Link>
          </Button>
          <Button
            variant="secondary"
            disabled
            title="O atendimento real chega na próxima etapa do MultiZap AI"
          >
            Ativar (disponível em breve)
          </Button>
          <Button
            variant="danger"
            disabled={a.status === 'ACTIVE'}
            onClick={() => {
              del.reset();
              setDeleting(true);
            }}
          >
            <Trash2 className="h-4 w-4" /> Excluir
          </Button>
        </div>
      </div>
      <Alert tone="info">
        Nesta etapa o agente pode ser configurado, publicado e testado no laboratório. O atendimento
        real no WhatsApp ainda não está ligado.
      </Alert>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <GeneralCard agent={a} />
        <div className="space-y-6">
          <PublishCard agent={a} />
          <AccountsCard agent={a} />
        </div>
      </div>
      <ConfirmNameModal
        open={deleting}
        onOpenChange={setDeleting}
        title="Excluir agente"
        name={a.name}
        description="O agente, suas versões e as sessões de teste serão removidos."
        loading={del.isPending}
        error={del.error ? (del.error as Error).message : null}
        onConfirm={(confirmName) =>
          del.mutate(
            { path: `/ai/agents/${a.id}`, method: 'DELETE', json: { confirmName } },
            { onSuccess: () => router.replace('/ai/agentes') },
          )
        }
      />
    </div>
  );
}
