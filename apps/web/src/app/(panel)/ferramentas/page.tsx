'use client';
import Link from 'next/link';
import {
  ArrowLeftRight,
  ChevronRight,
  Download,
  Eraser,
  FileDown,
  FileUp,
  GitCompare,
  Globe2,
  MapPin,
  ScanSearch,
  Scissors,
  Sparkles,
  CopyMinus,
  type LucideIcon,
} from 'lucide-react';
import { JOB_STATUS_LABEL, TOOLS, type ToolId } from '@multizap/shared';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@multizap/ui';
import { formatDateTime } from '@/lib/format';
import { useToolJobs } from '@/lib/tools';

const ICONS: Record<ToolId, LucideIcon> = {
  convert: ArrowLeftRight,
  split: Scissors,
  compare: GitCompare,
  dedupe: CopyMinus,
  'extract-phones': ScanSearch,
  'group-ddd': MapPin,
  'group-country': Globe2,
  'remove-empty': Eraser,
  sanitize: Sparkles,
};

function ToolCard({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-4 rounded-card border border-border bg-surface p-5 shadow-card transition-colors hover:border-accent/40"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between text-sm font-semibold text-fg">
          {title}
          <ChevronRight
            className="h-4 w-4 text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
            aria-hidden
          />
        </span>
        <span className="mt-1 block text-xs text-muted">{description}</span>
      </span>
    </Link>
  );
}

export default function ToolsPage() {
  const jobs = useToolJobs();
  const listTools = (Object.values(TOOLS) as (typeof TOOLS)[ToolId][]).filter(
    (t) => t.group === 'lists',
  );
  return (
    <>
      <PageHeader
        title="Ferramentas"
        description="Processamento de listas independente das instâncias. Os arquivos são processados em segundo plano."
      />

      <Link
        href="/ferramentas/sanitize"
        className="group mb-6 flex flex-wrap items-center gap-5 rounded-card border border-accent/30 bg-gradient-to-r from-accent-soft to-surface p-6 shadow-card transition-colors hover:border-accent/60"
      >
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-accent text-[#04130d]">
          <Sparkles className="h-6 w-6" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold text-fg">Higienizador de listas</span>
          <span className="mt-1 block text-sm text-muted">{TOOLS.sanitize.description}</span>
        </span>
        <ChevronRight className="h-5 w-5 text-accent" aria-hidden />
      </Link>

      <h2 className="mb-3 text-sm font-semibold text-muted">Ferramentas de listas</h2>
      <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {listTools.map((t) => (
          <ToolCard
            key={t.id}
            href={`/ferramentas/${t.id}`}
            icon={ICONS[t.id]}
            title={t.name}
            description={t.description}
          />
        ))}
        <ToolCard
          href="/contatos/importar"
          icon={FileUp}
          title="Importador CSV/XLSX"
          description="Importa listas para a base de contatos de uma instância."
        />
        <ToolCard
          href="/contatos"
          icon={FileDown}
          title="Exportador"
          description="Exporta os contatos de uma instância em CSV ou XLSX (botões na tela de Contatos)."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Processamentos recentes</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.data?.length === 0 ? (
            <p className="text-sm text-subtle">Nenhum processamento ainda.</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Ferramenta</TH>
                  <TH>Arquivo(s)</TH>
                  <TH>Situação</TH>
                  <TH>Criado em</TH>
                  <TH />
                </tr>
              </THead>
              <TBody>
                {jobs.data?.map((j) => (
                  <TR key={j.id}>
                    <TD className="font-medium">{TOOLS[j.tool]?.name ?? j.tool}</TD>
                    <TD className="max-w-72 truncate text-muted">
                      {j.inputs.map((i) => i.name).join(' × ')}
                    </TD>
                    <TD>
                      <Badge
                        tone={
                          j.status === 'COMPLETED'
                            ? 'success'
                            : j.status === 'FAILED'
                              ? 'danger'
                              : 'info'
                        }
                        dot
                      >
                        {JOB_STATUS_LABEL[j.status]}
                        {j.status === 'RUNNING' && ` · ${j.progress}%`}
                      </Badge>
                    </TD>
                    <TD className="text-muted">{formatDateTime(j.createdAt)}</TD>
                    <TD>
                      <Link
                        href={`/ferramentas/${j.tool}?job=${j.id}`}
                        className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden /> Resultados
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
