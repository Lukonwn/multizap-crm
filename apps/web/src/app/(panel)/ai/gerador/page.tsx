'use client';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  ImagePlus,
  Paperclip,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  EMOJI_LABEL,
  EMOJI_OPTIONS,
  FORMALITY_LABEL,
  FORMALITY_OPTIONS,
  GENERATOR_DOC_EXTENSIONS,
  GENERATOR_IMAGE_EXTENSIONS,
  GENERATOR_LIMITS,
  LENGTH_LABEL,
  LENGTH_OPTIONS,
  type AiGenerationDTO,
  type GeneratorPackage,
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
  Segmented,
  Select,
  Spinner,
  type Tone,
} from '@multizap/ui';
import { formatDateTime } from '@/lib/format';
import {
  createGeneration,
  formatUsd,
  useAgents,
  useAiMutation,
  useGeneration,
  useGenerations,
  usePersona,
} from '@/lib/ai';
import { ModelPicker } from '@/components/ai/model-picker';
import { SECTIONS, type TextKey } from '@/components/ai/persona-fields';
import { Textarea } from '@/components/ai/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { aiKeys } from '@/lib/ai';

const STATUS: Record<AiGenerationDTO['status'], { label: string; tone: Tone }> = {
  PENDING: { label: 'Na fila', tone: 'neutral' },
  PROCESSING: { label: 'Gerando', tone: 'info' },
  READY: { label: 'Pronto para revisar', tone: 'success' },
  ERROR: { label: 'Com erro', tone: 'danger' },
};

const mb = (n: number) => `${n / 1024 / 1024} MB`;

// ─── Novo pedido ───

function NewGeneration({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const agents = useAgents();
  const history = useGenerations();
  const [description, setDescription] = useState('');
  const [links, setLinks] = useState('');
  const [docs, setDocs] = useState<File[]>([]);
  const [images, setImages] = useState<File[]>([]);
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<'new' | 'improve'>('new');
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);

  const linkList = links
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const ready =
    description.trim().length >= 10 &&
    !!model &&
    linkList.length <= GENERATOR_LIMITS.maxLinks &&
    (mode === 'new' || !!agentId);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const g = await createGeneration({
        description: description.trim(),
        model,
        links: linkList,
        targetAgentId: mode === 'improve' ? agentId : undefined,
        docs,
        images,
      });
      await qc.invalidateQueries({ queryKey: aiKeys.generations });
      onOpen(g.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <Alert tone="info" title="Como funciona">
          Descreva o seu negócio e mande o que tiver (site, PDF, cardápio, imagens). Uma IA monta a
          persona, as instruções do agente e a base de conhecimento. Você revisa e edita tudo antes
          de criar, e o agente nasce como rascunho, em revisão humana e desativado.
        </Alert>
        <Card>
          <CardHeader>
            <CardTitle>Material</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              label="Descreva o negócio e como o agente deve ser"
              htmlFor="g-desc"
              hint="O que vende, para quem, o tom (formal, informal, gírias, o que for), regras, o que ele não pode dizer."
            >
              <Textarea
                id="g-desc"
                rows={8}
                value={description}
                maxLength={GENERATOR_LIMITS.maxDescriptionChars}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field
              label={`Links (um por linha, até ${GENERATOR_LIMITS.maxLinks})`}
              htmlFor="g-links"
              hint="Páginas públicas do seu site. O texto delas é lido uma vez."
            >
              <Textarea
                id="g-links"
                rows={3}
                value={links}
                placeholder="https://minhaloja.com.br/sobre"
                onChange={(e) => setLinks(e.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted">
                  Documentos ({GENERATOR_DOC_EXTENSIONS.join(', ').toUpperCase()})
                </p>
                <input
                  ref={docRef}
                  type="file"
                  multiple
                  hidden
                  aria-label="Documentos"
                  accept={GENERATOR_DOC_EXTENSIONS.map((e) => `.${e}`).join(',')}
                  onChange={(e) => {
                    setDocs(
                      [...docs, ...Array.from(e.target.files ?? [])].slice(
                        0,
                        GENERATOR_LIMITS.maxDocs,
                      ),
                    );
                    e.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => docRef.current?.click()}
                >
                  <Paperclip className="h-3.5 w-3.5" /> Anexar documento
                </Button>
                <p className="mt-1 text-xs text-subtle">
                  Até {GENERATOR_LIMITS.maxDocs}, {mb(GENERATOR_LIMITS.maxDocBytes)} cada.
                </p>
                <FileList files={docs} onRemove={(i) => setDocs(docs.filter((_, j) => j !== i))} />
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted">
                  Imagens ({GENERATOR_IMAGE_EXTENSIONS.join(', ').toUpperCase()})
                </p>
                <input
                  ref={imgRef}
                  type="file"
                  multiple
                  hidden
                  aria-label="Imagens"
                  accept={GENERATOR_IMAGE_EXTENSIONS.map((e) => `.${e}`).join(',')}
                  onChange={(e) => {
                    setImages(
                      [...images, ...Array.from(e.target.files ?? [])].slice(
                        0,
                        GENERATOR_LIMITS.maxImages,
                      ),
                    );
                    e.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => imgRef.current?.click()}
                >
                  <ImagePlus className="h-3.5 w-3.5" /> Anexar imagem
                </Button>
                <p className="mt-1 text-xs text-subtle">
                  Cardápio, catálogo, tabela de preços... Até {GENERATOR_LIMITS.maxImages},{' '}
                  {mb(GENERATOR_LIMITS.maxImageBytes)} cada. Exige um modelo que aceite imagem.
                </p>
                <FileList
                  files={images}
                  onRemove={(i) => setImages(images.filter((_, j) => j !== i))}
                />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Modelo e destino</CardTitle>
            <CardDescription>
              O modelo que vai gerar o pacote (pode ser diferente do que o agente usará).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ModelPicker
              label="Modelo do gerador"
              value={model}
              requireImages={images.length > 0}
              onChange={(m) => setModel(m.id)}
            />
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">O que fazer com o resultado</p>
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'new', label: 'Criar um agente novo' },
                  { value: 'improve', label: 'Melhorar um agente existente' },
                ]}
              />
            </div>
            {mode === 'improve' && (
              <Field label="Agente a melhorar" htmlFor="g-agent">
                <Select id="g-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  <option value="">Escolha…</option>
                  {agents.data?.items.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {error && <Alert tone="danger">{error}</Alert>}
            <Button loading={busy} disabled={!ready} onClick={submit}>
              <Sparkles className="h-4 w-4" /> Gerar pacote
            </Button>
            <p className="text-xs text-subtle">
              A persona sempre tem 18 anos ou mais, e as regras fixas dos agentes continuam valendo
              (não afirmar ser humano quando perguntado, não pedir senha ou cartão, encerrar a
              conversa com menor de idade). O uso do modelo gera custo na OpenRouter.
            </p>
          </CardContent>
        </Card>
      </div>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Gerações recentes</CardTitle>
        </CardHeader>
        <CardContent>
          {history.isLoading ? (
            <Spinner />
          ) : !history.data?.length ? (
            <p className="text-sm text-muted">Nenhuma ainda.</p>
          ) : (
            <ul className="space-y-2">
              {history.data.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(g.id)}
                    className="w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-surface-2"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="line-clamp-1 text-sm text-fg">{g.description}</span>
                      <Badge tone={STATUS[g.status].tone}>{STATUS[g.status].label}</Badge>
                    </span>
                    <span className="text-xs text-subtle">
                      {formatDateTime(g.createdAt)}
                      {g.appliedAt ? ' · aplicado' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FileList({ files, onRemove }: { files: File[]; onRemove: (i: number) => void }) {
  if (!files.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {files.map((f, i) => (
        <li
          key={`${f.name}-${i}`}
          className="flex items-center justify-between gap-2 text-xs text-muted"
        >
          <span className="truncate">{f.name}</span>
          <button type="button" aria-label={`Remover ${f.name}`} onClick={() => onRemove(i)}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

// ─── Geração aberta ───

function GenerationView({ id, onBack }: { id: string; onBack: () => void }) {
  const gen = useGeneration(id);
  const del = useAiMutation();
  const g = gen.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Gerador de Persona
        </Button>
        {g && g.status !== 'PROCESSING' && (
          <Button
            variant="ghost"
            size="sm"
            loading={del.isPending}
            onClick={() => {
              if (
                !window.confirm('Apagar esta geração? O pacote e o histórico dela serão removidos.')
              )
                return;
              del.mutate({ path: `/ai/generator/${id}`, method: 'DELETE' }, { onSuccess: onBack });
            }}
          >
            <Trash2 className="h-3.5 w-3.5" /> Apagar
          </Button>
        )}
      </div>
      {gen.isLoading || !g ? (
        <Spinner />
      ) : g.status === 'PENDING' || g.status === 'PROCESSING' ? (
        <Card>
          <CardContent className="flex items-center gap-4 pt-5">
            <Spinner />
            <div>
              <p className="font-medium text-fg">
                {g.status === 'PENDING' ? 'Na fila…' : 'Gerando o pacote…'}
              </p>
              <p className="text-sm text-muted">
                Isso costuma levar de 20 segundos a 2 minutos. Você pode sair desta tela: o
                resultado fica em &quot;Gerações recentes&quot;.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : g.status === 'ERROR' ? (
        <div className="space-y-3">
          <Alert tone="danger" title="Não foi possível gerar">
            {g.error}
          </Alert>
          <Button onClick={onBack}>Tentar de novo com outro pedido ou modelo</Button>
        </div>
      ) : (
        <Review key={g.id} gen={g} />
      )}
    </div>
  );
}

// ─── Revisão e aplicação ───

function Review({ gen }: { gen: AiGenerationDTO }) {
  const initial = useMemo(() => structuredClone(gen.result!) as GeneratorPackage, [gen.result]);
  const [pkg, setPkg] = useState<GeneratorPackage>(initial);
  const agents = useAgents();
  const [mode, setMode] = useState<'new' | 'improve'>(gen.targetAgentId ? 'improve' : 'new');
  const [agentId, setAgentId] = useState(gen.targetAgentId ?? '');
  const [agentName, setAgentName] = useState(initial.persona.name);
  const [agentModel, setAgentModel] = useState('');
  const [sections, setSections] = useState({ persona: true, instructions: true, knowledge: true });
  const apply = useAiMutation<{
    agentId: string;
    knowledgeCount: number;
    changes: string[];
    agentActive: boolean;
  }>();
  const target = agents.data?.items.find((a) => a.id === agentId) ?? null;
  const current = usePersona(mode === 'improve' && target ? target.personaId : null);

  const setP = (patch: Partial<GeneratorPackage['persona']>) =>
    setPkg((x) => ({ ...x, persona: { ...x.persona, ...patch } }));
  const lines = (v: string) =>
    v
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const applied = apply.data;

  const ready =
    !gen.appliedAt &&
    !applied &&
    (mode === 'new' ? agentName.trim().length >= 2 && agentModel.length >= 3 : !!agentId);

  return (
    <div className="space-y-6">
      {gen.appliedAt && !applied && (
        <Alert tone="info">
          Este pacote já foi aplicado em {formatDateTime(gen.appliedAt)}. Para criar novos itens,
          gere outro.
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <Badge tone="success">Pronto para revisar</Badge>
        <span>
          {gen.model} · {gen.promptTokens + gen.completionTokens} tokens · {formatUsd(gen.costUsd)}
          {gen.costUsd !== null && !gen.costConfirmed ? ' (estimado)' : ''}
        </span>
      </div>
      {pkg.notes && (
        <Alert tone="warning" title="Observações do gerador">
          {pkg.notes}
        </Alert>
      )}
      {!!pkg.gaps.length && (
        <Card>
          <CardHeader>
            <CardTitle>O material não respondeu</CardTitle>
            <CardDescription>
              Perguntas importantes sem resposta no que você enviou. Depois de criar, cadastre essas
              respostas em Conhecimento.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
              {pkg.gaps.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Persona</CardTitle>
          <CardDescription>Revise e edite o que quiser antes de criar.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome" htmlFor="r-name">
              <Input
                id="r-name"
                value={pkg.persona.name}
                onChange={(e) => setP({ name: e.target.value })}
              />
            </Field>
            <Field label="Idade (18 ou mais)" htmlFor="r-age">
              <Input
                id="r-age"
                type="number"
                min={18}
                max={120}
                value={pkg.persona.age ?? ''}
                onChange={(e) => setP({ age: e.target.value ? Number(e.target.value) : null })}
              />
            </Field>
            <Field label="Formalidade" htmlFor="r-form">
              <Select
                id="r-form"
                value={pkg.persona.formality}
                onChange={(e) => setP({ formality: e.target.value as never })}
              >
                {FORMALITY_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {FORMALITY_LABEL[o]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Uso de emojis" htmlFor="r-emoji">
              <Select
                id="r-emoji"
                value={pkg.persona.emojiUsage}
                onChange={(e) => setP({ emojiUsage: e.target.value as never })}
              >
                {EMOJI_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {EMOJI_LABEL[o]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tamanho das respostas" htmlFor="r-len">
              <Select
                id="r-len"
                value={pkg.persona.responseLength}
                onChange={(e) => setP({ responseLength: e.target.value as never })}
              >
                {LENGTH_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {LENGTH_LABEL[o]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {SECTIONS.flatMap((s) => s.fields).map(([k, label]) => {
            const key = k as TextKey;
            const before = current.data?.[key] ?? null;
            const now = pkg.persona[key] ?? '';
            return (
              <Field key={k} label={label} htmlFor={`r-${k}`}>
                <Textarea
                  id={`r-${k}`}
                  rows={3}
                  value={now}
                  onChange={(e) => setP({ [key]: e.target.value } as never)}
                />
                {mode === 'improve' && before && before !== now && (
                  <p className="mt-1 text-xs text-subtle">Atual: {before}</p>
                )}
              </Field>
            );
          })}
          <Field label="Expressões características (uma por linha)" htmlFor="r-expr">
            <Textarea
              id="r-expr"
              rows={3}
              value={pkg.persona.expressions.join('\n')}
              onChange={(e) => setP({ expressions: lines(e.target.value) })}
            />
          </Field>
          <Field label="Mensagens iniciais (uma por linha)" htmlFor="r-open">
            <Textarea
              id="r-open"
              rows={3}
              value={pkg.persona.openingMessages.join('\n')}
              onChange={(e) => setP({ openingMessages: lines(e.target.value) })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Instruções do agente</CardTitle>
          {mode === 'improve' && target && (
            <CardDescription>
              Substituem as instruções atuais do agente (só valem depois de publicar).
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <Textarea
            aria-label="Instruções do agente"
            rows={8}
            value={pkg.agentInstructions}
            onChange={(e) => setPkg({ ...pkg, agentInstructions: e.target.value })}
          />
          {mode === 'improve' && target?.instructions && (
            <p className="mt-2 text-xs text-subtle">Atual: {target.instructions}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Conhecimento ({pkg.knowledge.texts.length + pkg.knowledge.qa.length} fontes)
          </CardTitle>
          <CardDescription>
            Cada item vira uma fonte na aba Conhecimento. Remova o que não quiser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {pkg.knowledge.texts.map((t, i) => (
            <div key={`t${i}`} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <Badge>Texto</Badge>
                <Input
                  aria-label={`Nome do texto ${i + 1}`}
                  value={t.name}
                  onChange={(e) =>
                    setPkg({
                      ...pkg,
                      knowledge: {
                        ...pkg.knowledge,
                        texts: pkg.knowledge.texts.map((x, j) =>
                          j === i ? { ...x, name: e.target.value } : x,
                        ),
                      },
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remover texto ${t.name}`}
                  onClick={() =>
                    setPkg({
                      ...pkg,
                      knowledge: {
                        ...pkg.knowledge,
                        texts: pkg.knowledge.texts.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  <Trash2 className="h-4 w-4 text-muted" />
                </button>
              </div>
              <Textarea
                aria-label={`Conteúdo do texto ${i + 1}`}
                rows={4}
                value={t.content}
                onChange={(e) =>
                  setPkg({
                    ...pkg,
                    knowledge: {
                      ...pkg.knowledge,
                      texts: pkg.knowledge.texts.map((x, j) =>
                        j === i ? { ...x, content: e.target.value } : x,
                      ),
                    },
                  })
                }
              />
            </div>
          ))}
          {pkg.knowledge.qa.map((q, i) => (
            <div key={`q${i}`} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <Badge tone="accent">Pergunta</Badge>
                <Input
                  aria-label={`Pergunta ${i + 1}`}
                  value={q.question}
                  onChange={(e) =>
                    setPkg({
                      ...pkg,
                      knowledge: {
                        ...pkg.knowledge,
                        qa: pkg.knowledge.qa.map((x, j) =>
                          j === i ? { ...x, question: e.target.value } : x,
                        ),
                      },
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remover pergunta ${q.question}`}
                  onClick={() =>
                    setPkg({
                      ...pkg,
                      knowledge: {
                        ...pkg.knowledge,
                        qa: pkg.knowledge.qa.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  <Trash2 className="h-4 w-4 text-muted" />
                </button>
              </div>
              <Textarea
                aria-label={`Resposta ${i + 1}`}
                rows={2}
                value={q.answer}
                onChange={(e) =>
                  setPkg({
                    ...pkg,
                    knowledge: {
                      ...pkg.knowledge,
                      qa: pkg.knowledge.qa.map((x, j) =>
                        j === i ? { ...x, answer: e.target.value } : x,
                      ),
                    },
                  })
                }
              />
            </div>
          ))}
          {!pkg.knowledge.texts.length && !pkg.knowledge.qa.length && (
            <p className="text-sm text-muted">Nenhuma fonte de conhecimento neste pacote.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Criar</CardTitle>
          <CardDescription>
            Nada é publicado nem ativado: tudo fica como rascunho para você testar no Laboratório.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'new', label: 'Criar um agente novo' },
              { value: 'improve', label: 'Melhorar um agente existente' },
            ]}
          />
          {mode === 'new' ? (
            <div className="space-y-4">
              <Field label="Nome do agente" htmlFor="r-agent-name">
                <Input
                  id="r-agent-name"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                />
              </Field>
              <ModelPicker
                label="Modelo do agente"
                value={agentModel}
                onChange={(m) => setAgentModel(m.id)}
              />
            </div>
          ) : (
            <div className="space-y-4">
              <Field label="Agente a melhorar" htmlFor="r-agent">
                <Select id="r-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  <option value="">Escolha…</option>
                  {agents.data?.items.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="space-y-2 text-sm text-fg">
                {(
                  [
                    ['persona', 'Atualizar a persona (só os campos preenchidos mudam)'],
                    ['instructions', 'Substituir as instruções do agente'],
                    ['knowledge', 'Adicionar as fontes de conhecimento e ligar ao agente'],
                  ] as const
                ).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={sections[k]}
                      onChange={(e) => setSections({ ...sections, [k]: e.target.checked })}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    {label}
                  </label>
                ))}
              </div>
              {target?.status === 'ACTIVE' && (
                <Alert tone="warning" title="Este agente está ativo">
                  O conhecimento adicionado passa a valer na hora. A persona e as instruções só
                  valem quando você publicar uma nova versão.
                </Alert>
              )}
              {current.data && current.data.agentCount > 1 && sections.persona && (
                <Alert tone="info">
                  A persona &quot;{current.data.name}&quot; é usada por {current.data.agentCount}{' '}
                  agentes. A mudança aparece nos outros quando você publicar uma nova versão deles.
                </Alert>
              )}
            </div>
          )}
          {apply.error && <Alert tone="danger">{(apply.error as Error).message}</Alert>}
          {applied && (
            <Alert tone="success" title="Pronto!">
              Foi criado/atualizado: {applied.changes.join(', ')}.{' '}
              {applied.agentActive
                ? 'Lembre-se: persona e instruções só valem depois de publicar.'
                : 'O agente está como rascunho: teste no Laboratório e publique quando quiser.'}
              <span className="mt-2 flex flex-wrap gap-3">
                <Link className="underline" href={`/ai/agentes/${applied.agentId}`}>
                  Abrir o agente
                </Link>
                <Link className="underline" href={`/ai/laboratorio?agente=${applied.agentId}`}>
                  Testar no laboratório
                </Link>
                <Link className="underline" href="/ai/conhecimento">
                  Ver o conhecimento
                </Link>
              </span>
            </Alert>
          )}
          <Button
            loading={apply.isPending}
            disabled={!ready}
            onClick={() =>
              apply.mutate({
                path: `/ai/generator/${gen.id}/apply`,
                json:
                  mode === 'new'
                    ? { package: pkg, mode, agentName: agentName.trim(), agentModel }
                    : { package: pkg, mode, agentId, sections },
              })
            }
          >
            {applied ? <CheckCircle2 className="h-4 w-4" /> : <Wand2 className="h-4 w-4" />}
            {mode === 'new' ? 'Criar tudo' : 'Aplicar melhorias'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function GeneratorPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  return openId ? (
    <GenerationView id={openId} onBack={() => setOpenId(null)} />
  ) : (
    <NewGeneration onOpen={setOpenId} />
  );
}
