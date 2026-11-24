'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  RefreshCw,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  IMPORT_FIELD_LABEL,
  IMPORT_ROW_STATUS_LABEL,
  formatPhone,
  type ImportDTO,
  type ImportField,
  type ImportMappingInput,
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
  Label,
  Modal,
  PageHeader,
  Segmented,
  Select,
  Spinner,
  StatCard,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  cn,
} from '@multizap/ui';
import { api } from '@/lib/api';
import { contactKeys, uploadImport, useImport, useImportRows } from '@/lib/contacts';
import { formatNumber } from '@/lib/format';
import { AccountPicker, useSelectedAccount } from '@/components/contacts/account-picker';
import { TagPicker } from '@/components/contacts/tags';

const STEPS = ['Arquivo e instância', 'Mapeamento', 'Revisão', 'Importação'];
const COUNTRIES: [string, string][] = [
  ['BR', 'Brasil (+55)'],
  ['PT', 'Portugal (+351)'],
  ['US', 'Estados Unidos (+1)'],
  ['AR', 'Argentina (+54)'],
  ['PY', 'Paraguai (+595)'],
  ['UY', 'Uruguai (+598)'],
  ['CL', 'Chile (+56)'],
  ['CO', 'Colômbia (+57)'],
  ['MX', 'México (+52)'],
  ['ES', 'Espanha (+34)'],
  ['IT', 'Itália (+39)'],
  ['GB', 'Reino Unido (+44)'],
];
const ROW_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  VALID: 'success',
  IMPORTED: 'success',
  DUPLICATE: 'warning',
  INVALID: 'danger',
  OPTED_OUT: 'danger',
  SKIPPED: 'neutral',
};

function stepOf(imp: ImportDTO | undefined, remap: boolean): number {
  if (!imp) return 0;
  if (imp.status === 'UPLOADED' || (remap && imp.status === 'ANALYZED')) return 1;
  if (imp.status === 'ANALYZING' || imp.status === 'ANALYZED') return 2;
  return 3;
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2 text-xs">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={cn(
              'grid h-6 w-6 place-items-center rounded-full border text-[11px] font-semibold',
              i < current
                ? 'border-accent bg-accent text-[#04130d]'
                : i === current
                  ? 'border-accent text-accent'
                  : 'border-border text-subtle',
            )}
          >
            {i < current ? '✓' : i + 1}
          </span>
          <span className={i === current ? 'font-medium text-fg' : 'text-subtle'}>{s}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-8 bg-border" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-xs tabular-nums text-muted">
        {formatNumber(value)} de {formatNumber(max)} linhas · {pct}%
      </p>
    </div>
  );
}

// ─── Passo 1: arquivo ───────────────────────────────────────────────────────

function UploadStep({
  accountId,
  onUploaded,
}: {
  accountId: string;
  onUploaded: (imp: ImportDTO) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; importId?: string } | null>(null);
  const [drag, setDrag] = useState(false);

  const pick = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!/\.(csv|txt|xlsx)$/i.test(f.name)) {
      setError({ message: 'Formato não suportado. Envie um arquivo CSV, TXT ou XLSX.' });
      return;
    }
    setFile(f);
  };

  const send = async () => {
    if (!file) return;
    setProgress(0);
    setError(null);
    try {
      onUploaded(await uploadImport(accountId, file, setProgress));
    } catch (err) {
      const e = err as Error & { fields?: Record<string, string[]> };
      setError({ message: e.message, importId: e.fields?.importId?.[0] });
      setProgress(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Selecione o arquivo</CardTitle>
          <CardDescription>
            CSV, TXT ou XLSX. A importação só acontece depois da sua confirmação.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert tone="danger">
            {error.message}{' '}
            {error.importId && (
              <Link
                href={`/contatos/importar?conta=${accountId}&id=${error.importId}`}
                className="font-medium text-fg underline-offset-2 hover:underline"
              >
                Ver importação anterior
              </Link>
            )}
          </Alert>
        )}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pick(e.dataTransfer.files[0]);
          }}
          className={cn(
            'flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors',
            drag
              ? 'border-accent bg-accent-soft'
              : 'border-border-strong bg-bg-soft hover:border-accent/60',
          )}
        >
          <FileSpreadsheet className="h-8 w-8 text-accent" aria-hidden />
          {file ? (
            <>
              <p className="mt-3 text-sm font-medium text-fg">{file.name}</p>
              <p className="text-xs text-subtle">
                {(file.size / 1024 / 1024).toFixed(2)} MB · clique para trocar
              </p>
            </>
          ) : (
            <>
              <p className="mt-3 text-sm font-medium text-fg">
                Arraste o arquivo aqui ou clique para selecionar
              </p>
              <p className="text-xs text-subtle">
                Até 100 MB · arquivos grandes são processados em segundo plano
              </p>
            </>
          )}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,.xlsx"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        {progress !== null && <ProgressBar value={progress} max={100} />}
        <Button onClick={send} disabled={!file} loading={progress !== null}>
          <Upload className="h-4 w-4" aria-hidden /> Enviar e detectar colunas
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Passo 2: mapeamento ────────────────────────────────────────────────────

function MappingStep({
  accountId,
  imp,
  onAnalyzed,
  onCancel,
}: {
  accountId: string;
  imp: ImportDTO;
  onAnalyzed: () => void;
  onCancel: () => void;
}) {
  const initial = imp.mapping;
  const [hasHeader, setHasHeader] = useState(initial?.hasHeader ?? imp.hasHeader);
  const [columns, setColumns] = useState<Record<ImportField, number | null>>({
    phone: initial?.columns.phone ?? imp.suggested?.phone ?? 0,
    name: initial?.columns.name ?? imp.suggested?.name ?? null,
    tags: initial?.columns.tags ?? imp.suggested?.tags ?? null,
    notes: initial?.columns.notes ?? imp.suggested?.notes ?? null,
  });
  const [country, setCountry] = useState(initial?.defaultCountry ?? 'BR');
  const [consent, setConsent] = useState<'PENDING' | 'GRANTED'>(
    initial?.consent.status ?? 'PENDING',
  );
  const [source, setSource] = useState(
    initial?.consent.status === 'GRANTED' ? initial.consent.source : '',
  );
  const [tagIds, setTagIds] = useState<string[]>(initial?.applyTagIds ?? []);
  const [policy, setPolicy] = useState<'skip' | 'update'>(initial?.existingPolicy ?? 'skip');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const width = Math.max(0, ...imp.sample.map((r) => r.length));
  const labels = Array.from(
    { length: width },
    (_, i) => (hasHeader && imp.sample[0]?.[i]) || `Coluna ${i + 1}`,
  );
  const body = (hasHeader ? imp.sample.slice(1) : imp.sample).slice(0, 8);
  const fieldOf = (col: number) =>
    (Object.entries(columns) as [ImportField, number | null][]).find(([, c]) => c === col)?.[0];

  const setField = (field: ImportField, value: string) => {
    const col = value === '' ? null : Number(value);
    setColumns((prev) => {
      const next = { ...prev };
      // Cada coluna em um único campo; a coluna do telefone (obrigatório) não pode ser tomada.
      if (col !== null) {
        for (const k of Object.keys(next) as ImportField[]) {
          if (k === field || next[k] !== col) continue;
          if (k === 'phone') return prev;
          next[k] = null;
        }
      }
      next[field] = field === 'phone' ? (col ?? prev.phone) : col;
      return next;
    });
  };

  const analyze = async () => {
    setError(null);
    if (consent === 'GRANTED' && source.trim().length < 5) {
      setError('Descreva como o consentimento desta lista foi obtido (mínimo 5 caracteres).');
      return;
    }
    const mapping: ImportMappingInput = {
      hasHeader,
      columns: {
        phone: columns.phone ?? 0,
        name: columns.name,
        tags: columns.tags,
        notes: columns.notes,
      },
      defaultCountry: country,
      consent: consent === 'GRANTED' ? { status: 'GRANTED', source } : { status: 'PENDING' },
      applyTagIds: tagIds,
      existingPolicy: policy,
    };
    setLoading(true);
    try {
      await api(`/accounts/${accountId}/imports/${imp.id}/analyze`, {
        method: 'POST',
        json: { mapping },
      });
      onAnalyzed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Colunas detectadas · {imp.fileName}</CardTitle>
            <CardDescription>
              Associe as colunas do arquivo aos campos do contato. Prévia das primeiras linhas:
            </CardDescription>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={hasHeader}
              onChange={(e) => setHasHeader(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Primeira linha é cabeçalho
          </label>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(Object.keys(IMPORT_FIELD_LABEL) as ImportField[]).map((f) => (
              <Field
                key={f}
                label={`${IMPORT_FIELD_LABEL[f]}${f === 'phone' ? ' *' : ''}`}
                htmlFor={`map-${f}`}
              >
                <Select
                  id={`map-${f}`}
                  value={columns[f] ?? ''}
                  onChange={(e) => setField(f, e.target.value)}
                >
                  {f !== 'phone' && <option value="">Não importar</option>}
                  {labels.map((l, i) => (
                    <option key={i} value={i}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-surface-2/60">
                <tr>
                  {labels.map((l, i) => {
                    const f = fieldOf(i);
                    return (
                      <th
                        key={i}
                        className={cn(
                          'px-3 py-2 text-left font-medium',
                          f ? 'text-fg' : 'text-subtle',
                        )}
                      >
                        <span className="block truncate">{l}</span>
                        {f && (
                          <Badge tone="accent" className="mt-1">
                            {IMPORT_FIELD_LABEL[f]}
                          </Badge>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {body.map((r, ri) => (
                  <tr key={ri}>
                    {labels.map((_, ci) => (
                      <td
                        key={ci}
                        className={cn(
                          'max-w-48 truncate px-3 py-2',
                          fieldOf(ci) ? 'text-fg/90' : 'text-subtle',
                        )}
                      >
                        {r[ci] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Opções da importação</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-5">
            <Field label="País padrão (números sem código do país)" htmlFor="country">
              <Select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
                {COUNTRIES.map(([c, l]) => (
                  <option key={c} value={c}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <div>
              <Label>Contatos que já existem nesta instância</Label>
              <Segmented<'skip' | 'update'>
                value={policy}
                onChange={setPolicy}
                options={[
                  { value: 'skip', label: 'Ignorar' },
                  { value: 'update', label: 'Atualizar dados' },
                ]}
              />
              <p className="mt-1.5 text-xs text-subtle">
                {policy === 'skip'
                  ? 'Contatos existentes não serão alterados.'
                  : 'Nome, observações e etiquetas serão atualizados. Consentimento revogado nunca é reativado.'}
              </p>
            </div>
            <div>
              <Label>Etiquetas aplicadas a todos os contatos importados</Label>
              <TagPicker accountId={accountId} value={tagIds} onChange={setTagIds} />
            </div>
          </div>
          <div className="space-y-3">
            <Label>Consentimento desta lista</Label>
            {(['PENDING', 'GRANTED'] as const).map((v) => (
              <label
                key={v}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-lg border p-3',
                  consent === v ? 'border-accent/60 bg-accent-soft' : 'border-border bg-bg-soft',
                )}
              >
                <input
                  type="radio"
                  name="consent"
                  checked={consent === v}
                  onChange={() => setConsent(v)}
                  className="mt-1 accent-[var(--color-accent)]"
                />
                <span>
                  <span className="block text-sm font-medium text-fg">
                    {v === 'PENDING' ? 'Pendente' : 'Contatos autorizaram o contato'}
                  </span>
                  <span className="block text-xs text-muted">
                    {v === 'PENDING'
                      ? 'Os contatos não entram em campanhas até o consentimento ser registrado.'
                      : 'Será registrado um evento de consentimento para cada contato, com a origem informada.'}
                  </span>
                </span>
              </label>
            ))}
            {consent === 'GRANTED' && (
              <Field label="Como o consentimento foi obtido?" htmlFor="consent-src">
                <Input
                  id="consent-src"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="Ex.: formulário de cadastro do site com aceite"
                />
              </Field>
            )}
          </div>
        </CardContent>
      </Card>

      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onCancel}>
          Cancelar importação
        </Button>
        <Button onClick={analyze} loading={loading}>
          Analisar arquivo
        </Button>
      </div>
    </div>
  );
}

// ─── Passo 3: revisão ───────────────────────────────────────────────────────

function ReviewStep({
  accountId,
  accountName,
  imp,
  onRemap,
  onCancel,
}: {
  accountId: string;
  accountName: string;
  imp: ImportDTO;
  onRemap: () => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>('');
  const [page, setPage] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const analyzing = imp.status === 'ANALYZING';
  const rows = useImportRows(accountId, imp.id, filter || undefined, page, !analyzing);

  const confirm = async () => {
    setLoading(true);
    setError(null);
    try {
      await api(`/accounts/${accountId}/imports/${imp.id}/confirm`, { method: 'POST' });
      setConfirming(false);
      await qc.invalidateQueries({ queryKey: contactKeys.import(accountId, imp.id) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (analyzing) {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Analisando {imp.fileName}</CardTitle>
            <CardDescription>
              Validando telefones e identificando duplicados. Você pode sair desta tela: a análise
              continua em segundo plano.
            </CardDescription>
          </div>
          <Spinner />
        </CardHeader>
        <CardContent>
          <p className="text-sm tabular-nums text-muted">
            {formatNumber(imp.processedRows)} linhas analisadas...
          </p>
        </CardContent>
      </Card>
    );
  }

  const tabs = [
    ['', 'Todas', imp.totalRows],
    ['VALID', 'Válidos', imp.validRows],
    ['DUPLICATE', 'Duplicados', imp.duplicateRows],
    ['INVALID', 'Inválidos', imp.invalidRows],
    ['OPTED_OUT', 'Descadastrados', imp.optedOutRows],
  ] as const;
  const pages = rows.data ? Math.max(1, Math.ceil(rows.data.total / 25)) : 1;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Linhas com conteúdo" value={formatNumber(imp.totalRows)} tone="neutral" />
        <StatCard
          label="Serão importados"
          value={formatNumber(imp.validRows)}
          tone="success"
          icon={CheckCircle2}
          hint={
            imp.existingRows && imp.mapping?.existingPolicy === 'update'
              ? `${formatNumber(imp.existingRows)} serão atualizados`
              : undefined
          }
        />
        <StatCard
          label="Duplicados"
          value={formatNumber(imp.duplicateRows)}
          tone="warning"
          hint={
            imp.existingRows
              ? `${formatNumber(imp.existingRows)} já existem na instância`
              : 'No próprio arquivo'
          }
        />
        <StatCard
          label="Formato inválido"
          value={formatNumber(imp.invalidRows)}
          tone="danger"
          icon={XCircle}
        />
        <StatCard
          label="Descadastrados"
          value={formatNumber(imp.optedOutRows)}
          tone="danger"
          hint="Nunca importados"
        />
      </div>
      <Alert tone="info">
        A validação é apenas estrutural (formato e DDD). Ela não indica se o número possui uma conta
        WhatsApp.
      </Alert>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Pré-visualização dos registros</CardTitle>
            <CardDescription>Situação de cada linha do arquivo.</CardDescription>
          </div>
          {imp.hasRejectedFile && (
            <Button variant="secondary" size="sm" asChild>
              <a href={`/api/accounts/${accountId}/imports/${imp.id}/rejected`} download>
                <Download className="h-3.5 w-3.5" aria-hidden /> Baixar rejeitados
              </a>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {tabs.map(([value, label, count]) => (
              <button
                key={value}
                onClick={() => {
                  setFilter(value);
                  setPage(1);
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs transition-colors',
                  filter === value ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {label} <span className="tabular-nums text-subtle">{formatNumber(count)}</span>
              </button>
            ))}
          </div>
          <Table>
            <THead>
              <tr>
                <TH>Linha</TH>
                <TH>Nome</TH>
                <TH>Telefone</TH>
                <TH>Situação</TH>
                <TH>Motivo</TH>
              </tr>
            </THead>
            <TBody>
              {rows.data?.items.map((r) => (
                <TR key={r.rowNumber}>
                  <TD className="tabular-nums text-subtle">{r.rowNumber}</TD>
                  <TD>{r.name ?? <span className="text-subtle">—</span>}</TD>
                  <TD className="tabular-nums">
                    {r.phoneE164 ? (
                      formatPhone(r.phoneE164)
                    ) : (
                      <span className="text-subtle">
                        {r.raw[imp.mapping?.columns.phone ?? 0] || '—'}
                      </span>
                    )}
                  </TD>
                  <TD>
                    <Badge tone={ROW_TONE[r.status] ?? 'neutral'}>
                      {IMPORT_ROW_STATUS_LABEL[r.status]}
                    </Badge>
                  </TD>
                  <TD className="text-muted">{r.reason ?? ''}</TD>
                </TR>
              ))}
              {rows.data?.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-subtle">
                    Nenhuma linha nesta categoria.
                  </td>
                </tr>
              )}
            </TBody>
          </Table>
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Anterior
              </Button>
              <span>
                {page} / {pages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                Próxima
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap justify-between gap-2">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant="secondary" onClick={onRemap}>
            Alterar mapeamento
          </Button>
        </div>
        <Button onClick={() => setConfirming(true)} disabled={imp.validRows === 0}>
          Importar {formatNumber(imp.validRows)} contato(s)
        </Button>
      </div>

      <Modal
        open={confirming}
        onOpenChange={setConfirming}
        title="Confirmar importação"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Voltar
            </Button>
            <Button loading={loading} onClick={confirm}>
              Confirmar e importar
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm text-muted">
          <p>
            <strong className="text-fg">{formatNumber(imp.validRows)}</strong> registro(s) serão
            importados para a instância <strong className="text-fg">{accountName}</strong>.
          </p>
          <p>
            {formatNumber(imp.duplicateRows + imp.invalidRows + imp.optedOutRows)} linha(s)
            rejeitada(s) não serão importadas.
            {imp.mapping?.consent.status === 'GRANTED'
              ? ' O consentimento será registrado com a origem informada.'
              : ' Os contatos ficarão com consentimento pendente.'}
          </p>
        </div>
      </Modal>
    </div>
  );
}

// ─── Passo 4: importação ────────────────────────────────────────────────────

function RunStep({ accountId, imp }: { accountId: string; imp: ImportDTO }) {
  const done = imp.status === 'COMPLETED';
  const qc = useQueryClient();
  useEffect(() => {
    if (!done) return;
    // A importação alterou a base: descarta listas em cache.
    void Promise.all([
      qc.invalidateQueries({ queryKey: ['contacts', accountId] }),
      qc.invalidateQueries({ queryKey: ['tags', accountId] }),
      qc.invalidateQueries({ queryKey: ['imports', accountId] }),
      qc.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);
  }, [done, accountId, qc]);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>
            {done
              ? 'Importação concluída'
              : imp.status === 'FAILED'
                ? 'Importação com falha'
                : 'Importando contatos'}
          </CardTitle>
          <CardDescription>{imp.fileName}</CardDescription>
        </div>
        {done ? (
          <CheckCircle2 className="h-6 w-6 text-success" aria-hidden />
        ) : imp.status === 'FAILED' ? (
          <XCircle className="h-6 w-6 text-danger" aria-hidden />
        ) : (
          <Spinner />
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {imp.status === 'FAILED' && (
          <Alert tone="danger">{imp.error ?? 'Falha no processamento.'}</Alert>
        )}
        {!done && imp.status !== 'FAILED' && (
          <>
            <ProgressBar value={imp.processedRows} max={imp.totalRows} />
            <p className="text-xs text-subtle">
              O processamento continua em segundo plano, mesmo se você sair desta tela.
            </p>
          </>
        )}
        {(done || imp.importedRows + imp.updatedRows > 0) && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Contatos criados"
              value={formatNumber(imp.importedRows)}
              tone="success"
            />
            <StatCard
              label="Contatos atualizados"
              value={formatNumber(imp.updatedRows)}
              tone="info"
            />
            <StatCard
              label="Ignorados no processamento"
              value={formatNumber(imp.skippedRows)}
              tone="neutral"
              hint="Descadastrados ou cadastrados durante a importação"
            />
          </div>
        )}
        {done && (
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href={`/contatos?conta=${accountId}`}>Ver contatos</Link>
            </Button>
            {imp.hasRejectedFile && (
              <Button variant="secondary" asChild>
                <a href={`/api/accounts/${accountId}/imports/${imp.id}/rejected`} download>
                  <Download className="h-4 w-4" aria-hidden /> Baixar rejeitados
                </a>
              </Button>
            )}
            <Button variant="ghost" asChild>
              <Link href={`/contatos/importar?conta=${accountId}`}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Nova importação
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ImportWizard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { accounts, items, selected, select } = useSelectedAccount();
  const accountId = selected?.id ?? null;
  const importId = params.get('id');
  const imp = useImport(accountId ?? '', accountId ? importId : null);
  const [remap, setRemap] = useState(false);
  const step = useMemo(() => stepOf(imp.data, remap), [imp.data, remap]);

  useEffect(() => setRemap(false), [importId]);

  const go = (id: string | null) => {
    const p = new URLSearchParams({ conta: accountId ?? '' });
    if (id) p.set('id', id);
    router.replace(`${pathname}?${p.toString()}`);
  };
  const refresh = () =>
    qc.invalidateQueries({ queryKey: contactKeys.import(accountId ?? '', importId ?? '') });
  const cancel = async () => {
    if (importId && window.confirm('Cancelar esta importação? Nenhum contato será importado.')) {
      await api(`/accounts/${accountId}/imports/${importId}/cancel`, { method: 'POST' }).catch(
        () => undefined,
      );
      go(null);
    }
  };

  if (accounts.isPending)
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );

  return (
    <>
      <Link
        href={`/contatos${accountId ? `?conta=${accountId}` : ''}`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Contatos
      </Link>
      <PageHeader
        title="Importar lista"
        description="Os contatos serão adicionados somente à instância de destino."
        actions={
          step === 0 ? (
            <AccountPicker value={accountId} onChange={select} items={items} />
          ) : (
            selected && <Badge tone="accent">Destino: {selected.name}</Badge>
          )
        }
      />
      <Stepper current={step} />
      {!accountId && (
        <Alert tone="info">Cadastre uma instância em Conexões para importar contatos.</Alert>
      )}
      {accountId && imp.isError && <Alert tone="danger">{imp.error.message}</Alert>}
      {accountId && importId && imp.isPending && <Spinner />}
      {accountId && imp.data?.status === 'CANCELLED' && (
        <Alert tone="warning" title="Importação cancelada">
          Nenhum contato foi importado.{' '}
          <button className="font-medium text-fg hover:underline" onClick={() => go(null)}>
            Iniciar nova importação
          </button>
        </Alert>
      )}
      {accountId && step === 0 && !importId && (
        <UploadStep accountId={accountId} onUploaded={(i) => go(i.id)} />
      )}
      {accountId && imp.data && step === 1 && (
        <MappingStep
          accountId={accountId}
          imp={imp.data}
          onAnalyzed={() => {
            setRemap(false);
            void refresh();
          }}
          onCancel={cancel}
        />
      )}
      {accountId && imp.data && step === 2 && (
        <ReviewStep
          accountId={accountId}
          accountName={selected?.name ?? ''}
          imp={imp.data}
          onRemap={() => setRemap(true)}
          onCancel={cancel}
        />
      )}
      {accountId && imp.data && step === 3 && imp.data.status !== 'CANCELLED' && (
        <RunStep accountId={accountId} imp={imp.data} />
      )}
    </>
  );
}

export default function ImportPage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      }
    >
      <ImportWizard />
    </Suspense>
  );
}
