'use client';
import { useState } from 'react';
import { AUDIT_ACTION_LABEL } from '@multizap/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@multizap/ui';
import { formatDateTime } from '@/lib/format';
import { useAuditLog } from '@/lib/system';

const GROUPS = [
  ['', 'Todas as ações'],
  ['auth.', 'Acesso e senha'],
  ['account.', 'Instâncias'],
  ['contact.', 'Contatos'],
  ['import.', 'Importações'],
  ['campaign.', 'Campanhas'],
  ['conversation.', 'Central de mensagens'],
  ['asset.', 'Criativos'],
  ['tool.', 'Ferramentas'],
  ['operations.', 'Pausa global'],
  ['backup.', 'Backups'],
] as const;

/** Detalhes resumidos (sem valores sensíveis, que nunca são gravados na auditoria). */
function summarize(details: unknown): string {
  if (!details || typeof details !== 'object') return '';
  return Object.entries(details as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
    .join(' · ');
}

export function AuditCard() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const audit = useAuditLog({ action: action || undefined, page });
  const pages = audit.data ? Math.max(1, Math.ceil(audit.data.total / 20)) : 1;
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Registro de auditoria</CardTitle>
          <CardDescription>
            Ações administrativas com data, autor e endereço de origem. Somente leitura.
          </CardDescription>
        </div>
        <Select
          aria-label="Filtrar ações"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
          className="h-8 w-48 text-xs"
        >
          {GROUPS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </CardHeader>
      <CardContent>
        {audit.isError && <Alert tone="danger">{audit.error.message}</Alert>}
        {audit.data && audit.data.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-subtle">Nenhum registro.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Quando</TH>
                <TH>Ação</TH>
                <TH>Autor</TH>
                <TH>Origem</TH>
                <TH>Detalhes</TH>
              </tr>
            </THead>
            <TBody>
              {audit.data?.items.map((a) => (
                <TR key={a.id}>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(a.createdAt)}</TD>
                  <TD>
                    <span className="text-sm">{AUDIT_ACTION_LABEL[a.action] ?? a.action}</span>
                    <span className="block font-mono text-[11px] text-subtle">{a.action}</span>
                  </TD>
                  <TD className="text-xs">{a.actorEmail ?? 'Sistema'}</TD>
                  <TD className="font-mono text-xs">{a.ip ?? '—'}</TD>
                  <TD className="max-w-xs truncate text-xs text-muted" title={summarize(a.details)}>
                    {summarize(a.details) || '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted">
            <Button
              size="sm"
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Anterior
            </Button>
            Página {page} de {pages}
            <Button
              size="sm"
              variant="ghost"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Próxima
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
