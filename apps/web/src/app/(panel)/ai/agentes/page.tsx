'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, FlaskConical, Plus } from 'lucide-react';
import { AGENT_MODE_LABEL, type AgentDTO } from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@multizap/ui';
import { ApiError } from '@/lib/api';
import { useAgents, useAiMutation, useAiSettings, usePersonas } from '@/lib/ai';
import { AgentStatusBadge } from '@/components/ai/agent-status';
import { ModelPicker } from '@/components/ai/model-picker';

function NewAgentModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const personas = usePersonas('false');
  const create = useAiMutation<{ agent: AgentDTO }>();
  const [name, setName] = useState('');
  const [personaId, setPersonaId] = useState('');
  const [model, setModel] = useState('');
  const fields = create.error instanceof ApiError ? (create.error.fields ?? {}) : {};
  const noPersonas = personas.data && !personas.data.items.length;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Novo agente"
      description="O agente começa como rascunho. Nada é respondido no WhatsApp até ele ser publicado e ativado."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            loading={create.isPending}
            disabled={!name.trim() || !personaId || !model}
            onClick={() =>
              create.mutate(
                { path: '/ai/agents', json: { name, personaId, model } },
                { onSuccess: (r) => router.push(`/ai/agentes/${r.agent.id}`) },
              )
            }
          >
            Criar agente
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {noPersonas && (
          <Alert tone="warning">
            Crie uma persona antes.{' '}
            <Link className="underline" href="/ai/personas/nova">
              Nova persona
            </Link>
          </Alert>
        )}
        <Field label="Nome do agente" htmlFor="a-name" error={fields.name?.[0]}>
          <Input id="a-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Persona" htmlFor="a-persona" error={fields.personaId?.[0]}>
          <Select id="a-persona" value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
            <option value="">Escolha…</option>
            {personas.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <ModelPicker value={model} onChange={(m) => setModel(m.id)} />
        {create.error && !Object.keys(fields).length && (
          <Alert tone="danger">{(create.error as Error).message}</Alert>
        )}
      </div>
    </Modal>
  );
}

export default function AgentsPage() {
  const agents = useAgents();
  const settings = useAiSettings();
  const [creating, setCreating] = useState(false);
  const items = agents.data?.items ?? [];

  return (
    <div className="space-y-4">
      {settings.data && !settings.data.configured && (
        <Alert tone="warning" title="Chave da OpenRouter não configurada">
          Os agentes precisam dela para responder, inclusive no laboratório.{' '}
          <Link className="underline" href="/ai/configuracoes">
            Configurar
          </Link>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Cada instância pode ter um agente ativo. Um agente pode atender várias instâncias.
        </p>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Novo agente
        </Button>
      </div>
      {agents.isLoading ? (
        <Spinner />
      ) : agents.error ? (
        <Alert tone="danger">{(agents.error as Error).message}</Alert>
      ) : !items.length ? (
        <Card>
          <EmptyState
            icon={Bot}
            title="Nenhum agente ainda"
            description="Crie um agente, escolha a persona e o modelo e teste no laboratório antes de publicar."
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Agente</TH>
                <TH>Situação</TH>
                <TH className="hidden md:table-cell">Modelo</TH>
                <TH className="hidden md:table-cell">Instâncias</TH>
                <TH className="hidden lg:table-cell">Versão</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {items.map((a) => (
                <TR key={a.id}>
                  <TD>
                    <Link
                      href={`/ai/agentes/${a.id}`}
                      className="font-medium text-fg hover:underline"
                    >
                      {a.name}
                    </Link>
                    <p className="text-xs text-subtle">
                      {a.personaName} · {AGENT_MODE_LABEL[a.mode]}
                    </p>
                  </TD>
                  <TD>
                    <AgentStatusBadge status={a.status} />
                  </TD>
                  <TD className="hidden max-w-[220px] truncate text-xs text-muted md:table-cell">
                    {a.model}
                  </TD>
                  <TD className="hidden md:table-cell">{a.accounts.length}</TD>
                  <TD className="hidden lg:table-cell">
                    {a.publishedVersion ? `v${a.publishedVersion.number}` : '—'}
                    {a.hasUnpublishedChanges && a.publishedVersion && (
                      <Badge tone="warning" className="ml-2">
                        Alterações não publicadas
                      </Badge>
                    )}
                  </TD>
                  <TD className="text-right">
                    <Button size="sm" variant="ghost" asChild>
                      <Link href={`/ai/laboratorio?agente=${a.id}`}>
                        <FlaskConical className="h-3.5 w-3.5" /> Testar
                      </Link>
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {creating && <NewAgentModal open onOpenChange={setCreating} />}
    </div>
  );
}
