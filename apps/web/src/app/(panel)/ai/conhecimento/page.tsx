'use client';
import { useRef, useState } from 'react';
import {
  BookOpen,
  Eye,
  FileText,
  Link2,
  MessageCircleQuestion,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Type,
} from 'lucide-react';
import {
  KNOWLEDGE_KIND_LABEL,
  KNOWLEDGE_STATUS_LABEL,
  MAX_KNOWLEDGE_FILE_BYTES,
  type AiKnowledgeSourceDTO,
} from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
  Spinner,
  type Tone,
} from '@multizap/ui';
import { ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { uploadKnowledgeFile, useAiMutation, useKnowledge, useKnowledgeDetail } from '@/lib/ai';
import { ConfirmNameModal } from '@/components/ai/confirm-name-modal';
import { Textarea } from '@/components/ai/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { aiKeys } from '@/lib/ai';

const STATUS_TONE: Record<string, Tone> = {
  PENDING: 'neutral',
  PROCESSING: 'info',
  READY: 'success',
  ERROR: 'danger',
};
const KIND_ICON = { TEXT: Type, QA: MessageCircleQuestion, FILE: FileText, LINK: Link2 } as const;
const fmtSize = (n: number | null) =>
  n === null
    ? ''
    : n < 1024 * 1024
      ? `${Math.max(1, Math.round(n / 1024))} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

type AddKind = 'TEXT' | 'QA' | 'FILE' | 'LINK';

function AddModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const create = useAiMutation();
  const [kind, setKind] = useState<AddKind>('TEXT');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [question, setQuestion] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fields = create.error instanceof ApiError ? (create.error.fields ?? {}) : {};
  const err = (k: string) => fields[k]?.[0];

  const submit = async () => {
    if (kind === 'FILE') {
      if (!file) return;
      setUploading(true);
      setUploadError(null);
      try {
        await uploadKnowledgeFile(file, name);
        await qc.invalidateQueries({ queryKey: aiKeys.all });
        onClose();
      } catch (e) {
        setUploadError((e as Error).message);
      } finally {
        setUploading(false);
      }
      return;
    }
    const call =
      kind === 'TEXT'
        ? { path: '/ai/knowledge/text', json: { name, content } }
        : kind === 'QA'
          ? { path: '/ai/knowledge/qa', json: { question, answer: content, ...(name && { name }) } }
          : { path: '/ai/knowledge/link', json: { url, ...(name && { name }) } };
    create.mutate(call, { onSuccess: onClose });
  };

  const ready =
    kind === 'TEXT'
      ? name.trim().length >= 2 && content.trim().length >= 10
      : kind === 'QA'
        ? question.trim().length >= 3 && content.trim().length >= 2
        : kind === 'LINK'
          ? /^https?:\/\//i.test(url.trim())
          : !!file;

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="Adicionar conhecimento"
      description="O agente usa estas informações para responder. Só afirma o que estiver aqui."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={create.isPending || uploading} disabled={!ready} onClick={submit}>
            Adicionar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'TEXT', label: 'Texto' },
            { value: 'QA', label: 'Pergunta e resposta' },
            { value: 'FILE', label: 'Arquivo' },
            { value: 'LINK', label: 'Link' },
          ]}
        />
        {kind === 'TEXT' && (
          <>
            <Field label="Nome" htmlFor="kb-name" error={err('name')}>
              <Input id="kb-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field
              label="Texto"
              htmlFor="kb-content"
              error={err('content')}
              hint="Preços, produtos, horários, políticas de troca, prazos... Quanto mais claro, melhor."
            >
              <Textarea
                id="kb-content"
                rows={8}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </Field>
          </>
        )}
        {kind === 'QA' && (
          <>
            <Field label="Pergunta" htmlFor="kb-question" error={err('question')}>
              <Input
                id="kb-question"
                value={question}
                placeholder="Qual o prazo de entrega?"
                onChange={(e) => setQuestion(e.target.value)}
              />
            </Field>
            <Field label="Resposta" htmlFor="kb-answer" error={err('answer')}>
              <Textarea
                id="kb-answer"
                rows={5}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </Field>
          </>
        )}
        {kind === 'FILE' && (
          <>
            <Field
              label="Arquivo"
              htmlFor="kb-file"
              hint={`PDF, DOCX, TXT, MD ou CSV, até ${MAX_KNOWLEDGE_FILE_BYTES / 1024 / 1024} MB. PDFs escaneados (só imagem) não funcionam.`}
            >
              <input
                id="kb-file"
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.txt,.md,.csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface-2 file:px-3 file:py-2 file:text-sm file:text-fg"
              />
            </Field>
            <Field
              label="Nome (opcional)"
              htmlFor="kb-name-file"
              hint="Se vazio, usa o nome do arquivo."
            >
              <Input id="kb-name-file" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </>
        )}
        {kind === 'LINK' && (
          <>
            <Field
              label="Endereço da página"
              htmlFor="kb-url"
              error={err('url')}
              hint="Uma página pública (http ou https). O texto dela é lido uma vez; para atualizar, use Reprocessar."
            >
              <Input
                id="kb-url"
                type="url"
                value={url}
                placeholder="https://minhaloja.com.br/perguntas-frequentes"
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <Field
              label="Nome (opcional)"
              htmlFor="kb-name-link"
              hint="Se vazio, usa o título da página."
            >
              <Input id="kb-name-link" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </>
        )}
        {(create.error && !Object.keys(fields).length) || uploadError ? (
          <Alert tone="danger">{uploadError ?? (create.error as Error).message}</Alert>
        ) : null}
      </div>
    </Modal>
  );
}

function EditModal({ source, onClose }: { source: AiKnowledgeSourceDTO; onClose: () => void }) {
  const detail = useKnowledgeDetail(source.id);
  const save = useAiMutation();
  const [name, setName] = useState(source.name);
  const [question, setQuestion] = useState(source.question ?? '');
  const [content, setContent] = useState<string | null>(null);
  const body = content ?? detail.data?.source.content ?? '';
  const editable = source.kind === 'TEXT' || source.kind === 'QA';
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Editar: ${source.name}`}
      description={editable ? 'Ao salvar o conteúdo, a fonte é processada de novo.' : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  path: `/ai/knowledge/${source.id}`,
                  method: 'PATCH',
                  json: {
                    name,
                    ...(editable && content !== null && { content }),
                    ...(source.kind === 'QA' && question !== source.question && { question }),
                  },
                },
                { onSuccess: onClose },
              )
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nome" htmlFor="kbe-name">
          <Input id="kbe-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {source.kind === 'QA' && (
          <Field label="Pergunta" htmlFor="kbe-q">
            <Input id="kbe-q" value={question} onChange={(e) => setQuestion(e.target.value)} />
          </Field>
        )}
        {editable &&
          (detail.isLoading ? (
            <Spinner />
          ) : (
            <Field label={source.kind === 'QA' ? 'Resposta' : 'Texto'} htmlFor="kbe-c">
              <Textarea
                id="kbe-c"
                rows={8}
                value={body}
                onChange={(e) => setContent(e.target.value)}
              />
            </Field>
          ))}
        {save.error && <Alert tone="danger">{(save.error as Error).message}</Alert>}
      </div>
    </Modal>
  );
}

function ViewModal({ source, onClose }: { source: AiKnowledgeSourceDTO; onClose: () => void }) {
  const detail = useKnowledgeDetail(source.id);
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title={source.name}
      description={`${source.chunkCount} trecho(s) pesquisáveis`}
      footer={<Button onClick={onClose}>Fechar</Button>}
    >
      {detail.isLoading ? (
        <Spinner />
      ) : !detail.data?.chunks.length ? (
        <p className="text-sm text-muted">Nenhum trecho (a fonte ainda não foi processada).</p>
      ) : (
        <ul className="max-h-[420px] space-y-3 overflow-y-auto">
          {detail.data.chunks.map((c) => (
            <li key={c.id} className="rounded-lg border border-border bg-bg-soft p-3 text-sm">
              {c.title && <p className="mb-1 font-medium text-fg">{c.title}</p>}
              <p className="whitespace-pre-wrap text-muted">{c.content}</p>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export default function KnowledgePage() {
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const list = useKnowledge({ kind, status, q });
  const act = useAiMutation();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AiKnowledgeSourceDTO | null>(null);
  const [viewing, setViewing] = useState<AiKnowledgeSourceDTO | null>(null);
  const [deleting, setDeleting] = useState<AiKnowledgeSourceDTO | null>(null);
  const del = useAiMutation();
  const items = list.data?.items ?? [];
  const filtered = !!(kind || status || q);

  return (
    <div className="space-y-4">
      <Alert tone="info">
        A base de conhecimento é o que o agente consulta para responder sobre preços, produtos,
        prazos e políticas. Escolha, na tela de cada agente, quais fontes ele pode usar. O agente
        não inventa o que não estiver aqui: quando não achar, oferece um atendente.
      </Alert>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid flex-1 gap-3 sm:max-w-2xl sm:grid-cols-3">
          <Input
            aria-label="Pesquisar fontes"
            placeholder="Pesquisar pelo nome…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select aria-label="Tipo" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Todos os tipos</option>
            {Object.entries(KNOWLEDGE_KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
          <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todas as situações</option>
            {Object.entries(KNOWLEDGE_STATUS_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Adicionar conhecimento
        </Button>
      </div>
      {act.error && <Alert tone="danger">{(act.error as Error).message}</Alert>}
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <Alert tone="danger">{(list.error as Error).message}</Alert>
      ) : !items.length ? (
        <Card>
          <EmptyState
            icon={BookOpen}
            title={filtered ? 'Nenhuma fonte encontrada' : 'Nenhum conhecimento ainda'}
            description={
              filtered
                ? 'Ajuste os filtros.'
                : 'Adicione textos, perguntas e respostas, arquivos ou links com as informações da sua empresa.'
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3">
          {items.map((s) => {
            const Icon = KIND_ICON[s.kind];
            return (
              <Card key={s.id}>
                <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-muted">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-fg">{s.name}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-subtle">
                        <span>{KNOWLEDGE_KIND_LABEL[s.kind]}</span>
                        {s.fileName && <span>{s.fileName}</span>}
                        {s.sizeBytes !== null && <span>{fmtSize(s.sizeBytes)}</span>}
                        {s.status === 'READY' && <span>{s.chunkCount} trecho(s)</span>}
                        {s.processedAt && <span>processada {formatDateTime(s.processedAt)}</span>}
                      </p>
                      {(s.question || s.preview || s.url) && (
                        <p className="mt-1 line-clamp-2 text-sm text-muted">
                          {s.question ? `${s.question} — ` : ''}
                          {s.preview ?? s.url}
                        </p>
                      )}
                      {s.status === 'ERROR' && s.error && (
                        <p className="mt-1 text-sm text-danger">{s.error}</p>
                      )}
                      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
                        Usada por:
                        {s.agents.length ? (
                          s.agents.map((a) => (
                            <Badge key={a.id} tone="accent">
                              {a.name}
                            </Badge>
                          ))
                        ) : (
                          <span>nenhum agente ainda</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[s.status]} dot>
                      {KNOWLEDGE_STATUS_LABEL[s.status]}
                    </Badge>
                    {!s.enabled && <Badge>Desligada</Badge>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2.5">
                  <Button size="sm" variant="ghost" onClick={() => setViewing(s)}>
                    <Eye className="h-3.5 w-3.5" /> Ver trechos
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      act.mutate({
                        path: `/ai/knowledge/${s.id}`,
                        method: 'PATCH',
                        json: { enabled: !s.enabled },
                      })
                    }
                  >
                    {s.enabled ? 'Desligar' : 'Ligar'}
                  </Button>
                  {(s.status === 'READY' || s.status === 'ERROR') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        act.mutate({ path: `/ai/knowledge/${s.id}/reprocess`, method: 'POST' })
                      }
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Reprocessar
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Excluir ${s.name}`}
                    onClick={() => {
                      del.reset();
                      setDeleting(s);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {adding && <AddModal onClose={() => setAdding(false)} />}
      {editing && <EditModal source={editing} onClose={() => setEditing(null)} />}
      {viewing && <ViewModal source={viewing} onClose={() => setViewing(null)} />}
      {deleting && (
        <ConfirmNameModal
          open
          onOpenChange={(v) => !v && setDeleting(null)}
          title="Excluir conhecimento"
          name={deleting.name}
          description="A fonte, seus trechos e o arquivo guardado serão removidos, e os agentes deixam de usá-la."
          loading={del.isPending}
          error={del.error ? (del.error as Error).message : null}
          onConfirm={(confirmName) =>
            del.mutate(
              { path: `/ai/knowledge/${deleting.id}`, method: 'DELETE', json: { confirmName } },
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
