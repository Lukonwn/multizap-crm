'use client';
import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, FileUp } from 'lucide-react';
import { IMPORT_STATUS_LABEL } from '@multizap/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Spinner,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  type Tone,
} from '@multizap/ui';
import { useImports } from '@/lib/contacts';
import { formatDateTime, formatNumber } from '@/lib/format';
import { AccountPicker, useSelectedAccount } from '@/components/contacts/account-picker';

const TONE: Record<string, Tone> = {
  UPLOADED: 'neutral',
  ANALYZING: 'info',
  ANALYZED: 'warning',
  CONFIRMED: 'info',
  PROCESSING: 'info',
  COMPLETED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

function ImportsHistory() {
  const { accounts, items, selected, select } = useSelectedAccount();
  const accountId = selected?.id ?? null;
  const imports = useImports(accountId);
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
        title="Importações"
        description="Histórico de importações da instância."
        actions={<AccountPicker value={accountId} onChange={select} items={items} />}
      />
      {imports.data?.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileUp}
            title="Nenhuma importação"
            action={
              accountId && (
                <Button asChild>
                  <Link href={`/contatos/importar?conta=${accountId}`}>Importar lista</Link>
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Arquivo</TH>
              <TH>Situação</TH>
              <TH>Linhas</TH>
              <TH>Importados</TH>
              <TH>Rejeitados</TH>
              <TH>Enviado em</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {imports.data?.map((i) => (
              <TR key={i.id}>
                <TD>
                  <Link
                    href={`/contatos/importar?conta=${accountId}&id=${i.id}`}
                    className="font-medium text-fg hover:text-accent"
                  >
                    {i.fileName}
                  </Link>
                  <span className="block text-xs uppercase text-subtle">
                    {i.format} · {(i.fileSize / 1024).toFixed(0)} KB
                  </span>
                </TD>
                <TD>
                  <Badge tone={TONE[i.status] ?? 'neutral'} dot>
                    {IMPORT_STATUS_LABEL[i.status]}
                  </Badge>
                </TD>
                <TD className="tabular-nums">{formatNumber(i.totalRows)}</TD>
                <TD className="tabular-nums">
                  {formatNumber(i.importedRows)}
                  {i.updatedRows > 0 && (
                    <span className="text-xs text-subtle">
                      {' '}
                      (+{formatNumber(i.updatedRows)} atualizados)
                    </span>
                  )}
                </TD>
                <TD className="tabular-nums">
                  {formatNumber(i.duplicateRows + i.invalidRows + i.optedOutRows)}
                </TD>
                <TD className="text-muted">{formatDateTime(i.createdAt)}</TD>
                <TD>
                  {i.hasRejectedFile && (
                    <Button variant="ghost" size="sm" asChild>
                      <a
                        href={`/api/accounts/${accountId}/imports/${i.id}/rejected`}
                        download
                        aria-label="Baixar rejeitados"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </>
  );
}

export default function ImportsPage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      }
    >
      <ImportsHistory />
    </Suspense>
  );
}
