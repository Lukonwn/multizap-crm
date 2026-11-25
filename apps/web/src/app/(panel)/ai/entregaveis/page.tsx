'use client';
import { useState } from 'react';
import { FileText, Gift, Link2, Pencil, Plus, Trash2, Type } from 'lucide-react';
import {
  DELIVERABLE_KIND_LABEL,
  DELIVERABLE_KINDS,
  formatBRL,
  type AiDeliverableDTO,
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
} from '@multizap/ui';
import { ApiError } from '@/lib/api';
import { useAssets } from '@/lib/assets';
import { useAiMutation, useDeliverables } from '@/lib/ai';
import { ConfirmNameModal } from '@/components/ai/confirm-name-modal';
import { Textarea } from '@/components/ai/textarea';

const ICON = { FILE: FileText, TEXT: Type, LINK: Link2 } as const;
const FILE_MIMES = /^(image\/|video\/|audio\/|application\/pdf)/;

interface Form {
  name: string;
  description: string;
  kind: AiDeliverableDTO['kind'];
  assetId: string;
  text: string;
  adultOnly: boolean;
  approval: 'AUTO' | 'MANUAL';
  requiresPayment: boolean;
  price: string;
  paymentInstructions: string;
  enabled: boolean;
}

const blank: Form = {
  name: '',
  description: '',
  kind: 'FILE',
  assetId: '',
  text: '',
  adultOnly: false,
  approval: 'MANUAL',
  requiresPayment: false,
  price: '',
  paymentInstructions: '',
  enabled: true,
};

const toForm = (d: AiDeliverableDTO): Form => ({
  name: d.name,
  description: d.description ?? '',
  kind: d.kind,
  assetId: d.assetId ?? '',
  text: d.text ?? '',
  adultOnly: d.adultOnly,
  approval: d.approval,
  requiresPayment: d.requiresPayment,
  price: d.priceCents ? (d.priceCents / 100).toFixed(2).replace('.', ',') : '',
  paymentInstructions: d.paymentInstructions ?? '',
  enabled: d.enabled,
});

/** "49,90" ou "49.90" → centavos. */
const toCents = (v: string) => {
  const n = Number(v.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

function ItemModal({ item, onClose }: { item: AiDeliverableDTO | null; onClose: () => void }) {
  const save = useAiMutation();
  const [f, setF] = useState<Form>(item ? toForm(item) : blank);
  const [q, setQ] = useState('');
  const assets = useAssets({ q: q || undefined, page: 1 });
  const fields = save.error instanceof ApiError ? (save.error.fields ?? {}) : {};
  const err = (k: string) => fields[k]?.[0];
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const files = (assets.data?.items ?? []).filter(
    (a) => a.hasFile && FILE_MIMES.test(a.mimeType ?? ''),
  );

  const submit = () => {
    const body = {
      name: f.name,
      description: f.description,
      kind: f.kind,
      assetId: f.kind === 'FILE' ? f.assetId || null : null,
      text: f.text,
      adultOnly: f.adultOnly,
      approval: f.approval,
      requiresPayment: f.requiresPayment,
      priceCents: f.requiresPayment ? toCents(f.price) : null,
      paymentInstructions: f.requiresPayment ? f.paymentInstructions : '',
      enabled: f.enabled,
    };
    save.mutate(
      item
        ? { path: `/ai/deliverables/${item.id}`, method: 'PATCH', json: body }
        : { path: '/ai/deliverables', json: body },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title={item ? `Editar: ${item.name}` : 'Novo entregável'}
      description="Um item que o agente pode entregar ao contato na conversa."
      className="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} disabled={f.name.trim().length < 2} onClick={submit}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        <Field label="Nome" htmlFor="d-name" error={err('name')}>
          <Input id="d-name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field
          label="Quando oferecer (descrição para o agente)"
          htmlFor="d-desc"
          hint="Ex.: guia em PDF com métodos de preparo; oferecer a quem perguntar como fazer café."
          error={err('description')}
        >
          <Textarea
            id="d-desc"
            rows={2}
            value={f.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
        {!item && (
          <Segmented
            value={f.kind}
            onChange={(kind) => set({ kind })}
            options={DELIVERABLE_KINDS.map((k) => ({ value: k, label: DELIVERABLE_KIND_LABEL[k] }))}
          />
        )}
        {f.kind === 'FILE' && (
          <div className="space-y-2">
            <Field
              label="Arquivo da biblioteca de criativos"
              htmlFor="d-asset-q"
              hint="Imagem, vídeo MP4, áudio MP3/OGG ou PDF. Envie novos em Criativos."
              error={err('assetId')}
            >
              <Input
                id="d-asset-q"
                placeholder="Pesquisar pelo nome…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </Field>
            <div
              role="listbox"
              aria-label="Arquivos"
              className="max-h-44 overflow-y-auto rounded-lg border border-border"
            >
              {assets.isLoading ? (
                <div className="p-3">
                  <Spinner />
                </div>
              ) : !files.length ? (
                <p className="p-3 text-sm text-muted">Nenhum arquivo encontrado.</p>
              ) : (
                files.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="option"
                    aria-selected={a.id === f.assetId}
                    onClick={() => set({ assetId: a.id })}
                    className={`flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-0 hover:bg-surface-2 ${a.id === f.assetId ? 'bg-accent-soft' : ''}`}
                  >
                    <span className="truncate text-fg">{a.name}</span>
                    <span className="text-xs text-subtle">{a.mimeType}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
        {f.kind !== 'FILE' ? (
          <Field
            label={f.kind === 'LINK' ? 'Link completo' : 'Texto a entregar'}
            htmlFor="d-text"
            error={err('text')}
          >
            {f.kind === 'LINK' ? (
              <Input
                id="d-text"
                type="url"
                value={f.text}
                placeholder="https://"
                onChange={(e) => set({ text: e.target.value })}
              />
            ) : (
              <Textarea
                id="d-text"
                rows={4}
                value={f.text}
                onChange={(e) => set({ text: e.target.value })}
              />
            )}
          </Field>
        ) : (
          <Field label="Legenda (opcional)" htmlFor="d-text" error={err('text')}>
            <Input id="d-text" value={f.text} onChange={(e) => set({ text: e.target.value })} />
          </Field>
        )}
        <Field
          label="Envio"
          htmlFor="d-approval"
          hint={
            f.approval === 'AUTO'
              ? 'Sai sozinho assim que as regras forem cumpridas.'
              : 'Fica esperando a sua aprovação em Atendimentos.'
          }
        >
          <Select
            id="d-approval"
            value={f.approval}
            onChange={(e) => set({ approval: e.target.value as Form['approval'] })}
          >
            <option value="MANUAL">Com a minha aprovação</option>
            <option value="AUTO">Automático</option>
          </Select>
        </Field>
        <label className="flex items-start gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={f.requiresPayment}
            onChange={(e) => set({ requiresPayment: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Item pago
            <span className="block text-xs text-subtle">
              Só é entregue depois que o pagamento for confirmado por você ou por um aviso assinado
              do seu sistema de pagamento. O agente nunca confirma pagamento.
            </span>
          </span>
        </label>
        {f.requiresPayment && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Preço (R$)" htmlFor="d-price" error={err('priceCents')}>
              <Input
                id="d-price"
                inputMode="decimal"
                placeholder="49,90"
                value={f.price}
                onChange={(e) => set({ price: e.target.value })}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field
                label="Como pagar (o agente repassa ao contato)"
                htmlFor="d-pay"
                error={err('paymentInstructions')}
                hint="Ex.: chave Pix e o nome do recebedor."
              >
                <Textarea
                  id="d-pay"
                  rows={2}
                  value={f.paymentInstructions}
                  onChange={(e) => set({ paymentInstructions: e.target.value })}
                />
              </Field>
            </div>
          </div>
        )}
        <label className="flex items-start gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={f.adultOnly}
            onChange={(e) => set({ adultOnly: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Conteúdo adulto
            <span className="block text-xs text-subtle">
              Só sai para uma conversa em que a pergunta de 18 anos está ligada no agente e foi
              confirmada, e nunca para conversa travada por sinal de menor. Não verifica idade.
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          Item ligado
        </label>
        {save.error && !Object.keys(fields).length && (
          <Alert tone="danger">{(save.error as Error).message}</Alert>
        )}
      </div>
    </Modal>
  );
}

export default function DeliverablesPage() {
  const list = useDeliverables();
  const [editing, setEditing] = useState<AiDeliverableDTO | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AiDeliverableDTO | null>(null);
  const del = useAiMutation();
  const items = list.data ?? [];

  return (
    <div className="space-y-4">
      <Alert tone="info">
        Entregáveis são os itens que o agente pode enviar ao contato: arquivos da biblioteca
        (imagem, vídeo, áudio, PDF), textos e links. Itens pagos só saem depois que o pagamento é
        confirmado por você ou por um aviso assinado do seu sistema de pagamento. Escolha, na tela
        de cada agente, quais itens ele pode oferecer.
      </Alert>
      <div className="flex justify-end">
        <Button onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Novo entregável
        </Button>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <Alert tone="danger">{(list.error as Error).message}</Alert>
      ) : !items.length ? (
        <Card>
          <EmptyState
            icon={Gift}
            title="Nenhum entregável ainda"
            description="Cadastre o primeiro item que o agente poderá entregar."
          />
        </Card>
      ) : (
        <div className="grid gap-3">
          {items.map((d) => {
            const Icon = ICON[d.kind];
            return (
              <Card key={d.id}>
                <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-muted">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-fg">{d.name}</p>
                      <p className="mt-0.5 text-xs text-subtle">
                        código <code>{d.code}</code> · {DELIVERABLE_KIND_LABEL[d.kind]}
                        {d.assetName ? ` · ${d.assetName}` : ''} · {d.deliveryCount} entrega(s)
                      </p>
                      {d.description && (
                        <p className="mt-1 line-clamp-2 text-sm text-muted">{d.description}</p>
                      )}
                      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
                        Usado por:
                        {d.agents.length ? (
                          d.agents.map((a) => (
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
                    {d.requiresPayment ? (
                      <Badge tone="warning">
                        Pago {d.priceCents ? formatBRL(d.priceCents) : ''}
                      </Badge>
                    ) : (
                      <Badge>Gratuito</Badge>
                    )}
                    <Badge tone={d.approval === 'AUTO' ? 'info' : 'neutral'}>
                      {d.approval === 'AUTO' ? 'Envio automático' : 'Com aprovação'}
                    </Badge>
                    {d.adultOnly && <Badge tone="danger">+18</Badge>}
                    {!d.enabled && <Badge>Desligado</Badge>}
                    {d.unavailable && <Badge tone="danger">Arquivo indisponível</Badge>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2.5">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(d)}>
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Excluir ${d.name}`}
                    onClick={() => {
                      del.reset();
                      setDeleting(d);
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
      {editing && (
        <ItemModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {deleting && (
        <ConfirmNameModal
          open
          onOpenChange={(v) => !v && setDeleting(null)}
          title="Excluir entregável"
          name={deleting.name}
          description="O item sai do catálogo e dos agentes. O histórico das entregas já feitas permanece."
          loading={del.isPending}
          error={del.error ? (del.error as Error).message : null}
          onConfirm={(confirmName) =>
            del.mutate(
              { path: `/ai/deliverables/${deleting.id}`, method: 'DELETE', json: { confirmName } },
              { onSuccess: () => setDeleting(null) },
            )
          }
        />
      )}
    </div>
  );
}
