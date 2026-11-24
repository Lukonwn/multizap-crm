'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ImagePlus, MessageSquareText, ShieldCheck, Users, X } from 'lucide-react';
import {
  MAX_MESSAGE_LENGTH,
  SAMPLE_TEMPLATE_VALUES,
  TEMPLATE_VARIABLES,
  buildCampaignMessage,
  type AssetDTO,
  type CampaignDTO,
  type CampaignInput,
} from '@multizap/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Label,
  cn,
} from '@multizap/ui';
import { api, ApiError } from '@/lib/api';
import { useAccounts } from '@/lib/accounts';
import { useCampaignAction } from '@/lib/campaigns';
import { formatNumber } from '@/lib/format';
import { MessagePreview } from '../assets/message-preview';
import { TagPicker } from '../contacts/tags';
import { AssetPicker } from './asset-picker';

type Selection = Record<string, { tagIds: string[] }>;

function AudienceCount({ accountId, tagIds }: { accountId: string; tagIds: string[] }) {
  const q = useQuery({
    queryKey: ['audience', accountId, tagIds],
    queryFn: () =>
      api<{ eligible: number; total: number; excludedOptedOut: number; excludedNoConsent: number }>(
        '/campaigns/audience-preview',
        {
          method: 'POST',
          json: { accountId, tagIds },
        },
      ),
  });
  if (!q.data) return <span className="text-xs text-subtle">Calculando público...</span>;
  return (
    <p className="text-xs text-muted">
      <strong className="text-fg">{formatNumber(q.data.eligible)}</strong> elegível(is) de{' '}
      {formatNumber(q.data.total)}
      {(q.data.excludedNoConsent > 0 || q.data.excludedOptedOut > 0) && (
        <span className="text-subtle">
          {' '}
          · excluídos: {formatNumber(q.data.excludedNoConsent)} sem consentimento,{' '}
          {formatNumber(q.data.excludedOptedOut)} descadastrados
        </span>
      )}
    </p>
  );
}

export function CampaignBuilder({ campaign }: { campaign?: CampaignDTO }) {
  const router = useRouter();
  const accounts = useAccounts();
  const save = useCampaignAction();
  const [name, setName] = useState(campaign?.name ?? '');
  const [body, setBody] = useState(campaign?.body ?? '');
  const [linkUrl, setLinkUrl] = useState(campaign?.linkUrl ?? '');
  const [image, setImage] = useState<{ id: string; name: string; hasThumbnail: boolean } | null>(
    campaign?.asset ?? null,
  );
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(() =>
    Object.fromEntries((campaign?.accounts ?? []).map((a) => [a.accountId, { tagIds: a.tagIds }])),
  );
  const [picker, setPicker] = useState<null | 'image' | 'template'>(null);
  const [sample, setSample] = useState<{ name: string | null; phoneE164: string } | null>(null);

  const webAccounts = (accounts.data?.items ?? []).filter(
    (a) => a.connectionType === 'WHATSAPP_WEB',
  );
  const external = (accounts.data?.items ?? []).filter(
    (a) => a.connectionType === 'EXTERNAL_DEVICE',
  );
  const firstSelected = Object.keys(selection)[0];

  // Contato real (elegível) da primeira instância para a pré-visualização.
  useEffect(() => {
    if (!firstSelected) return setSample(null);
    void api<{ sample: { name: string | null; phoneE164: string } | null }>(
      '/campaigns/audience-preview',
      {
        method: 'POST',
        json: { accountId: firstSelected, tagIds: selection[firstSelected]?.tagIds ?? [] },
      },
    )
      .then((r) => setSample(r.sample))
      .catch(() => setSample(null));
  }, [firstSelected, selection]);

  const preview = useMemo(() => {
    const contact = sample ?? { name: SAMPLE_TEMPLATE_VALUES.nome, phoneE164: '+5511987654321' };
    return body ? buildCampaignMessage({ body, linkUrl: linkUrl || null }, contact) : '';
  }, [body, linkUrl, sample]);

  const toggle = (id: string) =>
    setSelection((s) => {
      const next = { ...s };
      if (next[id]) delete next[id];
      else next[id] = { tagIds: [] };
      return next;
    });

  const fields = save.error instanceof ApiError ? save.error.fields : undefined;

  const submit = async () => {
    const input: CampaignInput = {
      name,
      body,
      linkUrl: linkUrl || null,
      assetId: image?.id ?? null,
      templateId,
      accounts: Object.entries(selection).map(([accountId, v]) => ({
        accountId,
        tagIds: v.tagIds,
      })),
    };
    const r = await save
      .mutateAsync(
        campaign
          ? { path: `/campaigns/${campaign.id}`, method: 'PATCH', json: input }
          : { path: '/campaigns', json: input },
      )
      .catch(() => null);
    if (r?.campaign) router.push(`/campanhas/${r.campaign.id}`);
  };

  const useTemplate = (a: AssetDTO) => {
    setBody(a.textContent ?? '');
    setTemplateId(a.id);
    setPicker(null);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Mensagem</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Nome da campanha" htmlFor="c-name" error={fields?.name?.[0]}>
              <Input
                id="c-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
              />
            </Field>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <Label htmlFor="c-body" className="mb-0">
                  Texto
                </Label>
                <Button variant="ghost" size="sm" onClick={() => setPicker('template')}>
                  <MessageSquareText className="h-3.5 w-3.5" aria-hidden /> Usar modelo da
                  biblioteca
                </Button>
              </div>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {Object.entries(TEMPLATE_VARIABLES).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    title={label}
                    onClick={() => setBody((b) => `${b}{{${v}}}`)}
                    className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-accent hover:border-accent/50"
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
              <textarea
                id="c-body"
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setTemplateId(null);
                }}
                rows={7}
                maxLength={MAX_MESSAGE_LENGTH}
                className="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
              <div className="mt-1 flex justify-between text-xs">
                <span className="text-danger">{fields?.body?.[0]}</span>
                <span className="tabular-nums text-subtle">
                  {body.length}/{MAX_MESSAGE_LENGTH}
                </span>
              </div>
            </div>
            <Field
              label="Link (opcional)"
              htmlFor="c-link"
              error={fields?.linkUrl?.[0]}
              hint="Adicionado ao final da mensagem se não estiver no texto."
            >
              <Input
                id="c-link"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://..."
                inputMode="url"
              />
            </Field>
            <div>
              <Label>Imagem (opcional)</Label>
              {image ? (
                <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-soft p-2">
                  {image.hasThumbnail && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/assets/${image.id}/thumbnail`}
                      alt=""
                      className="h-12 w-12 rounded object-cover"
                    />
                  )}
                  <span className="flex-1 truncate text-sm">{image.name}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remover imagem"
                    onClick={() => setImage(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setPicker('image')}>
                  <ImagePlus className="h-4 w-4" aria-hidden /> Escolher da biblioteca
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Instâncias e público</CardTitle>
              <CardDescription>
                Cada instância usa somente a própria base de contatos. Entram apenas contatos
                autorizados e não descadastrados.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {fields?.accounts && <Alert tone="danger">{fields.accounts[0]}</Alert>}
            {webAccounts.length === 0 && (
              <Alert tone="info">Nenhuma instância de dispositivo conectado cadastrada.</Alert>
            )}
            {webAccounts.map((a) => {
              const on = !!selection[a.id];
              return (
                <div
                  key={a.id}
                  className={cn(
                    'rounded-lg border p-3 transition-colors',
                    on ? 'border-accent/50 bg-accent-soft/40' : 'border-border bg-bg-soft',
                  )}
                >
                  <label className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(a.id)}
                      className="accent-[var(--color-accent)]"
                    />
                    <span className="flex-1 text-sm font-medium text-fg">{a.name}</span>
                    {a.status !== 'CONNECTED' && (
                      <span className="text-xs text-warning">desconectada no momento</span>
                    )}
                  </label>
                  {on && (
                    <div className="mt-3 space-y-2 pl-7">
                      <p className="text-xs text-muted">
                        Filtrar por etiquetas (opcional; sem filtro = todos os elegíveis)
                      </p>
                      <TagPicker
                        accountId={a.id}
                        value={selection[a.id]!.tagIds}
                        onChange={(tagIds) => setSelection((s) => ({ ...s, [a.id]: { tagIds } }))}
                      />
                      <AudienceCount accountId={a.id} tagIds={selection[a.id]!.tagIds} />
                    </div>
                  )}
                </div>
              );
            })}
            {external.length > 0 && (
              <p className="text-xs text-subtle">
                Aparelhos apenas cadastrados ({external.map((e) => e.name).join(', ')}) não enviam
                mensagens e não aparecem aqui.
              </p>
            )}
          </CardContent>
        </Card>

        {save.isError && !fields && <Alert tone="danger">{save.error.message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => router.back()}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Salvar rascunho
          </Button>
        </div>
      </div>

      <div className="space-y-4 xl:sticky xl:top-24 xl:h-fit">
        <MessagePreview
          text={preview || 'A mensagem aparecerá aqui.'}
          imageUrl={image ? `/api/assets/${image.id}/file` : null}
        />
        <p className="text-xs text-subtle">
          {sample
            ? `Exemplo com um contato real da primeira instância (${sample.name ?? 'sem nome'}).`
            : 'Exemplo com dados fictícios.'}
        </p>
        <Alert tone="info">
          <span className="flex gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> Envio assistido: depois de salvar,
            você agenda ou prepara a fila, e cada mensagem só é enviada quando você confirmar.
          </span>
        </Alert>
        <p className="flex items-center gap-1.5 text-xs text-subtle">
          <Users className="h-3.5 w-3.5" /> {Object.keys(selection).length} instância(s)
          selecionada(s)
        </p>
      </div>

      {picker === 'image' && (
        <AssetPicker
          kinds={['IMAGE', 'BANNER']}
          title="Escolher imagem"
          onClose={() => setPicker(null)}
          onPick={(a) => {
            setImage({ id: a.id, name: a.name, hasThumbnail: a.hasThumbnail });
            setPicker(null);
          }}
        />
      )}
      {picker === 'template' && (
        <AssetPicker
          kinds={['TEMPLATE', 'TEXT']}
          title="Usar modelo ou texto"
          onClose={() => setPicker(null)}
          onPick={useTemplate}
        />
      )}
    </div>
  );
}
