'use client';
import { Suspense, use, useState } from 'react';
import Link from 'next/link';
import { notFound, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Play } from 'lucide-react';
import { JOB_STATUS_LABEL, TOOLS, TOOL_IDS, type ToolId, type ToolJobDTO } from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Label,
  PageHeader,
  Segmented,
  Select,
  Spinner,
} from '@multizap/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useToolJob, useToolJobs } from '@/lib/tools';
import { JobResult } from '@/components/tools/job-result';
import { ToolFileInput, type UploadState } from '@/components/tools/file-input';

const COUNTRIES: [string, string][] = [
  ['BR', 'Brasil (+55)'],
  ['PT', 'Portugal (+351)'],
  ['US', 'Estados Unidos (+1)'],
  ['AR', 'Argentina (+54)'],
  ['PY', 'Paraguai (+595)'],
  ['UY', 'Uruguai (+598)'],
  ['CL', 'Chile (+56)'],
  ['MX', 'México (+52)'],
  ['ES', 'Espanha (+34)'],
];
const USES_COUNTRY: ToolId[] = [
  'compare',
  'dedupe',
  'extract-phones',
  'group-ddd',
  'group-country',
  'sanitize',
];

function ToolRunner({ tool }: { tool: ToolId }) {
  const meta = TOOLS[tool];
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const jobId = params.get('job');
  const job = useToolJob(jobId);
  const recent = useToolJobs(tool);

  const [files, setFiles] = useState<(UploadState | null)[]>(
    meta.inputs === 2 ? [null, null] : [null],
  );
  const [outputFormat, setOutputFormat] = useState<'csv' | 'xlsx'>('csv');
  const [country, setCountry] = useState('BR');
  const [splitMode, setSplitMode] = useState<'rows' | 'parts'>('rows');
  const [splitSize, setSplitSize] = useState('1000');
  const [dedupeBy, setDedupeBy] = useState<'phone' | 'row'>('phone');
  const [unique, setUnique] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const setFile = (i: number) => (v: UploadState | null) => {
    setFiles((prev) => prev.map((f, j) => (j === i ? v : f)));
    if (v && tool === 'convert' && i === 0)
      setOutputFormat(v.upload.format === 'xlsx' ? 'csv' : 'xlsx');
  };
  const ready = files.every(Boolean);

  const buildParams = (): Record<string, unknown> => {
    const [a, b] = files as UploadState[];
    const base: Record<string, unknown> = { outputFormat };
    if (USES_COUNTRY.includes(tool)) base.defaultCountry = country;
    switch (tool) {
      case 'split':
        return { ...base, hasHeader: a!.hasHeader, mode: splitMode, size: Number(splitSize) };
      case 'compare':
        return {
          ...base,
          hasHeaderA: a!.hasHeader,
          phoneColumnA: a!.phoneColumn,
          hasHeaderB: b!.hasHeader,
          phoneColumnB: b!.phoneColumn,
        };
      case 'dedupe':
        return { ...base, by: dedupeBy, hasHeader: a!.hasHeader, phoneColumn: a!.phoneColumn };
      case 'extract-phones':
        return { ...base, hasHeader: a!.hasHeader, unique };
      case 'group-ddd':
      case 'group-country':
      case 'sanitize':
        return { ...base, hasHeader: a!.hasHeader, phoneColumn: a!.phoneColumn };
      default:
        return base;
    }
  };

  const run = async () => {
    setError(null);
    if (tool === 'split' && !(Number(splitSize) >= 1)) {
      setError('Informe um número válido.');
      return;
    }
    setRunning(true);
    try {
      const r = await api<{ job: ToolJobDTO }>('/tools/jobs', {
        method: 'POST',
        json: { tool, uploadIds: files.map((f) => f!.upload.id), params: buildParams() },
      });
      router.replace(`${pathname}?job=${r.job.id}`);
      void qc.invalidateQueries({ queryKey: ['tool-jobs'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Link
        href="/ferramentas"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Ferramentas
      </Link>
      <PageHeader title={meta.name} description={meta.description} />

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{meta.inputs === 2 ? 'Listas' : 'Arquivo'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {files.map((f, i) => (
                <ToolFileInput
                  key={i}
                  label={meta.inputs === 2 ? `Lista ${i === 0 ? 'A' : 'B'}` : 'Arquivo de entrada'}
                  value={f}
                  onChange={setFile(i)}
                  phoneColumn={meta.phoneColumn && !(tool === 'dedupe' && dedupeBy === 'row')}
                />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Opções</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-5 md:grid-cols-2">
              {tool === 'split' && (
                <>
                  <div>
                    <Label>Dividir</Label>
                    <Segmented<'rows' | 'parts'>
                      value={splitMode}
                      onChange={setSplitMode}
                      options={[
                        { value: 'rows', label: 'Por quantidade de linhas' },
                        { value: 'parts', label: 'Em N partes' },
                      ]}
                    />
                  </div>
                  <Field
                    label={splitMode === 'rows' ? 'Linhas por arquivo' : 'Número de partes'}
                    htmlFor="split-size"
                  >
                    <Input
                      id="split-size"
                      type="number"
                      min={1}
                      value={splitSize}
                      onChange={(e) => setSplitSize(e.target.value)}
                    />
                  </Field>
                </>
              )}
              {tool === 'dedupe' && (
                <div>
                  <Label>Considerar duplicado quando</Label>
                  <Segmented<'phone' | 'row'>
                    value={dedupeBy}
                    onChange={setDedupeBy}
                    options={[
                      { value: 'phone', label: 'O telefone se repete' },
                      { value: 'row', label: 'A linha inteira se repete' },
                    ]}
                  />
                  <p className="mt-1.5 text-xs text-subtle">
                    {dedupeBy === 'phone'
                      ? 'Formatos diferentes do mesmo número são reconhecidos (ex.: (11) 98765-4321 e +55 11 987654321).'
                      : 'Ignora maiúsculas e espaços nas extremidades.'}
                  </p>
                </div>
              )}
              {tool === 'extract-phones' && (
                <label className="flex items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={unique}
                    onChange={(e) => setUnique(e.target.checked)}
                    className="accent-[var(--color-accent)]"
                  />
                  Gravar cada telefone apenas uma vez
                </label>
              )}
              {USES_COUNTRY.includes(tool) && (
                <Field label="País padrão (números sem código do país)" htmlFor="country">
                  <Select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
                    {COUNTRIES.map(([c, l]) => (
                      <option key={c} value={c}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <div>
                <Label>Formato dos arquivos gerados</Label>
                <Segmented<'csv' | 'xlsx'>
                  value={outputFormat}
                  onChange={setOutputFormat}
                  options={[
                    { value: 'csv', label: 'CSV' },
                    { value: 'xlsx', label: 'XLSX' },
                  ]}
                />
              </div>
            </CardContent>
          </Card>

          {USES_COUNTRY.includes(tool) && (
            <Alert tone="info">
              A validação de telefones é estrutural (formato, país e DDD). Ela não indica se o
              número possui conta WhatsApp.
            </Alert>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex justify-end">
            <Button onClick={run} disabled={!ready} loading={running}>
              <Play className="h-4 w-4" aria-hidden /> Processar
            </Button>
          </div>

          {jobId && job.isPending && <Spinner />}
          {job.data && <JobResult job={job.data} />}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Processamentos recentes</CardTitle>
          </CardHeader>
          <CardContent>
            {recent.data?.length === 0 && (
              <p className="text-sm text-subtle">Nenhum processamento ainda.</p>
            )}
            <ul className="space-y-2">
              {recent.data?.map((j) => (
                <li key={j.id}>
                  <Link
                    href={`${pathname}?job=${j.id}`}
                    className={`block rounded-lg border px-3 py-2 text-sm transition-colors hover:border-border-strong ${j.id === jobId ? 'border-accent/50 bg-accent-soft' : 'border-border bg-bg-soft'}`}
                  >
                    <span className="block truncate text-fg/90">
                      {j.inputs.map((i) => i.name).join(' × ')}
                    </span>
                    <span className="mt-1 flex items-center justify-between text-xs text-subtle">
                      {formatDateTime(j.createdAt)}
                      <Badge
                        tone={
                          j.status === 'COMPLETED'
                            ? 'success'
                            : j.status === 'FAILED'
                              ? 'danger'
                              : 'info'
                        }
                      >
                        {JOB_STATUS_LABEL[j.status]}
                      </Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default function ToolPage({ params }: { params: Promise<{ tool: string }> }) {
  const { tool } = use(params);
  if (!(TOOL_IDS as readonly string[]).includes(tool)) notFound();
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      }
    >
      <ToolRunner tool={tool as ToolId} />
    </Suspense>
  );
}
