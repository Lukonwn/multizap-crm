'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, History } from 'lucide-react';
import {
  EMOJI_LABEL,
  EMOJI_OPTIONS,
  FORMALITY_LABEL,
  FORMALITY_OPTIONS,
  LENGTH_LABEL,
  LENGTH_OPTIONS,
  type PersonaDTO,
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
import { formatDateTime } from '@/lib/format';
import { useAiMutation, usePersona, usePersonaRevisions } from '@/lib/ai';
import { Textarea } from '@/components/ai/textarea';
import { SECTIONS, type TextKey } from '@/components/ai/persona-fields';

interface FormState {
  name: string;
  age: string;
  formality: string;
  emojiUsage: string;
  responseLength: string;
  expressions: string;
  openingMessages: string;
  text: Record<TextKey, string>;
}

const empty = (): FormState => ({
  name: '',
  age: '',
  formality: 'neutral',
  emojiUsage: 'low',
  responseLength: 'short',
  expressions: '',
  openingMessages: '',
  text: Object.fromEntries(SECTIONS.flatMap((s) => s.fields.map(([k]) => [k, '']))) as Record<
    TextKey,
    string
  >,
});

const fromPersona = (p: PersonaDTO): FormState => ({
  name: p.name,
  age: p.age ? String(p.age) : '',
  formality: p.formality,
  emojiUsage: p.emojiUsage,
  responseLength: p.responseLength,
  expressions: p.expressions.join('\n'),
  openingMessages: p.openingMessages.join('\n'),
  text: Object.fromEntries(
    SECTIONS.flatMap((s) => s.fields.map(([k]) => [k, p[k] ?? ''])),
  ) as Record<TextKey, string>,
});

const lines = (v: string) =>
  v
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function PersonaEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'nova';
  const router = useRouter();
  const search = useSearchParams();
  const asTemplate = search.get('template') === '1';
  const persona = usePersona(isNew ? null : id);
  const revisions = usePersonaRevisions(isNew ? null : id);
  const save = useAiMutation<{ persona: PersonaDTO }>();
  const [form, setForm] = useState<FormState>(empty);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (persona.data) setForm(fromPersona(persona.data));
  }, [persona.data]);

  if (!isNew && persona.isLoading) return <Spinner />;
  if (!isNew && persona.error)
    return <Alert tone="danger">{(persona.error as Error).message}</Alert>;

  const fieldErrors = save.error instanceof ApiError ? (save.error.fields ?? {}) : {};
  const err = (k: string) => fieldErrors[k]?.[0];
  const isTemplate = isNew ? asTemplate : !!persona.data?.isTemplate;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const body = {
      name: form.name,
      age: form.age ? Number(form.age) : null,
      formality: form.formality,
      emojiUsage: form.emojiUsage,
      responseLength: form.responseLength,
      expressions: lines(form.expressions),
      openingMessages: lines(form.openingMessages),
      ...form.text,
      ...(isNew && { isTemplate: asTemplate }),
    };
    save.mutate(
      isNew
        ? { path: '/ai/personas', json: body }
        : { path: `/ai/personas/${id}`, method: 'PATCH', json: body },
      {
        onSuccess: (r) => {
          setSaved(true);
          if (isNew) router.replace(`/ai/personas/${r.persona.id}?criada=1`);
        },
      },
    );
  };

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const setText = (k: TextKey, v: string) =>
    setForm((f) => ({ ...f, text: { ...f.text, [k]: v } }));

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/ai/personas">
              <ArrowLeft className="h-4 w-4" /> Personas
            </Link>
          </Button>
          <h2 className="text-base font-semibold text-fg">
            {isNew ? (isTemplate ? 'Novo template' : 'Nova persona') : (persona.data?.name ?? '')}
          </h2>
          {isTemplate && <Badge tone="info">Template</Badge>}
          {!isNew && !!persona.data?.agentCount && (
            <Badge tone="accent">Usada por {persona.data.agentCount} agente(s)</Badge>
          )}
        </div>
        <Button type="submit" loading={save.isPending}>
          {isNew ? 'Criar' : 'Salvar alterações'}
        </Button>
      </div>
      {!isNew && !!persona.data?.agentCount && (
        <Alert tone="info">
          Alterações na persona só chegam aos agentes publicados depois de uma nova publicação.
        </Alert>
      )}
      {save.error && !Object.keys(fieldErrors).length && (
        <Alert tone="danger">{(save.error as Error).message}</Alert>
      )}
      {(saved || search.get('criada') === '1') && !save.isPending && (
        <Alert tone="success">Persona salva.</Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Básico</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome" htmlFor="p-name" error={err('name')}>
                <Input
                  id="p-name"
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  required
                />
              </Field>
              <Field label="Idade (opcional)" htmlFor="p-age" error={err('age')}>
                <Input
                  id="p-age"
                  type="number"
                  min={18}
                  max={120}
                  value={form.age}
                  onChange={(e) => set({ age: e.target.value })}
                />
              </Field>
              <Field label="Formalidade" htmlFor="p-formality">
                <Select
                  id="p-formality"
                  value={form.formality}
                  onChange={(e) => set({ formality: e.target.value })}
                >
                  {FORMALITY_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {FORMALITY_LABEL[o]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Uso de emojis" htmlFor="p-emoji">
                <Select
                  id="p-emoji"
                  value={form.emojiUsage}
                  onChange={(e) => set({ emojiUsage: e.target.value })}
                >
                  {EMOJI_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {EMOJI_LABEL[o]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tamanho das respostas" htmlFor="p-length">
                <Select
                  id="p-length"
                  value={form.responseLength}
                  onChange={(e) => set({ responseLength: e.target.value })}
                >
                  {LENGTH_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {LENGTH_LABEL[o]}
                    </option>
                  ))}
                </Select>
              </Field>
            </CardContent>
          </Card>
          {SECTIONS.map((s) => (
            <Card key={s.title}>
              <CardHeader>
                <CardTitle>{s.title}</CardTitle>
                <CardDescription>{s.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {s.fields.map(([k, label, hint]) => (
                  <Field key={k} label={label} htmlFor={`p-${k}`} hint={hint} error={err(k)}>
                    <Textarea
                      id={`p-${k}`}
                      value={form.text[k]}
                      onChange={(e) => setText(k, e.target.value)}
                    />
                  </Field>
                ))}
              </CardContent>
            </Card>
          ))}
          <Card>
            <CardHeader>
              <CardTitle>Expressões e aberturas</CardTitle>
              <CardDescription>Um item por linha.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                label="Expressões características"
                htmlFor="p-expressions"
                error={err('expressions')}
              >
                <Textarea
                  id="p-expressions"
                  value={form.expressions}
                  onChange={(e) => set({ expressions: e.target.value })}
                />
              </Field>
              <Field
                label="Mensagens iniciais sugeridas"
                htmlFor="p-opening"
                error={err('openingMessages')}
              >
                <Textarea
                  id="p-opening"
                  value={form.openingMessages}
                  onChange={(e) => set({ openingMessages: e.target.value })}
                />
              </Field>
            </CardContent>
          </Card>
        </div>
        {!isNew && (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="h-4 w-4" /> Histórico
              </CardTitle>
            </CardHeader>
            <CardContent>
              {revisions.isLoading ? (
                <Spinner />
              ) : !revisions.data?.length ? (
                <p className="text-sm text-muted">Nenhuma alteração registrada.</p>
              ) : (
                <ul className="space-y-3">
                  {revisions.data.map((r) => (
                    <li key={r.id} className="text-sm">
                      <p className="text-fg">{r.summary}</p>
                      <p className="text-xs text-subtle">
                        {formatDateTime(r.createdAt)}
                        {r.changedBy ? ` · ${r.changedBy}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </form>
  );
}

export default function PersonaPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <PersonaEditor />
    </Suspense>
  );
}
