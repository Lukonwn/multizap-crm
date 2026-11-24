'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Copy, LayoutTemplate, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import type { PersonaDTO } from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Segmented,
  Spinner,
} from '@multizap/ui';
import { useAiMutation, usePersonas } from '@/lib/ai';
import { ConfirmNameModal } from '@/components/ai/confirm-name-modal';

export default function PersonasPage() {
  const router = useRouter();
  const [tab, setTab] = useState<'false' | 'true'>('false');
  const list = usePersonas(tab);
  const dup = useAiMutation<{ persona: PersonaDTO }>();
  const del = useAiMutation();
  const [deleting, setDeleting] = useState<PersonaDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const duplicate = (p: PersonaDTO, asTemplate: boolean) => {
    setError(null);
    dup.mutate(
      { path: `/ai/personas/${p.id}/duplicate`, json: { asTemplate } },
      {
        onSuccess: (r) => router.push(`/ai/personas/${r.persona.id}`),
        onError: (e) => setError((e as Error).message),
      },
    );
  };

  const items = list.data?.items ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'false', label: 'Personas' },
            { value: 'true', label: 'Templates' },
          ]}
        />
        <Button asChild>
          <Link href={`/ai/personas/nova${tab === 'true' ? '?template=1' : ''}`}>
            <Plus className="h-4 w-4" /> {tab === 'true' ? 'Novo template' : 'Nova persona'}
          </Link>
        </Button>
      </div>
      <p className="text-sm text-muted">
        {tab === 'true'
          ? 'Templates são modelos reutilizáveis: use um para criar uma persona nova. Agentes usam personas, não templates.'
          : 'A persona define quem o agente é: identidade, tom de voz, regras e assuntos. Um agente usa uma persona.'}
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <Alert tone="danger">{(list.error as Error).message}</Alert>
      ) : !items.length ? (
        <Card>
          <EmptyState
            icon={tab === 'true' ? LayoutTemplate : UserRound}
            title={tab === 'true' ? 'Nenhum template ainda' : 'Nenhuma persona ainda'}
            description={
              tab === 'true'
                ? 'Salve uma persona como template para reaproveitá-la.'
                : 'Crie a primeira persona para poder montar um agente.'
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex h-full flex-col gap-3 pt-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-fg">{p.name}</p>
                    <p className="line-clamp-2 text-sm text-muted">
                      {p.identity ?? p.toneOfVoice ?? 'Sem descrição'}
                    </p>
                  </div>
                  {p.isTemplate ? (
                    <Badge tone="info">Template</Badge>
                  ) : (
                    <Badge tone={p.agentCount ? 'accent' : 'neutral'}>
                      {p.agentCount} agente(s)
                    </Badge>
                  )}
                </div>
                <div className="mt-auto flex flex-wrap gap-2">
                  {p.isTemplate ? (
                    <Button size="sm" onClick={() => duplicate(p, false)} loading={dup.isPending}>
                      Usar template
                    </Button>
                  ) : null}
                  <Button size="sm" variant="secondary" asChild>
                    <Link href={`/ai/personas/${p.id}`}>
                      <Pencil className="h-3.5 w-3.5" /> Editar
                    </Link>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => duplicate(p, p.isTemplate)}>
                    <Copy className="h-3.5 w-3.5" /> Duplicar
                  </Button>
                  {!p.isTemplate && (
                    <Button size="sm" variant="ghost" onClick={() => duplicate(p, true)}>
                      <LayoutTemplate className="h-3.5 w-3.5" /> Salvar como template
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Excluir ${p.name}`}
                    disabled={p.agentCount > 0}
                    title={p.agentCount > 0 ? 'Em uso por agentes' : undefined}
                    onClick={() => {
                      del.reset();
                      setDeleting(p);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {deleting && (
        <ConfirmNameModal
          open
          onOpenChange={(v) => !v && setDeleting(null)}
          title="Excluir persona"
          name={deleting.name}
          description="A persona e seu histórico de alterações serão removidos."
          loading={del.isPending}
          error={del.error ? (del.error as Error).message : null}
          onConfirm={(confirmName) =>
            del.mutate(
              { path: `/ai/personas/${deleting.id}`, method: 'DELETE', json: { confirmName } },
              {
                onSuccess: () => {
                  setDeleting(null);
                  void list.refetch();
                },
              },
            )
          }
        />
      )}
    </div>
  );
}
