'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Search, Smartphone } from 'lucide-react';
import { formatPhone } from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Modal,
  PageHeader,
  Spinner,
  StatCard,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@multizap/ui';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { toQueryString } from '@/lib/contacts';
import { AccountPicker, useSelectedAccount } from '@/components/contacts/account-picker';

interface DeviceContact {
  id: string;
  name: string | null;
  savedName: string | null;
  pushName: string | null;
  phoneE164: string | null;
  inCrm: boolean;
}
interface DeviceList {
  items: DeviceContact[];
  total: number;
  stats: { identities: number; withPhone: number; withSavedName: number };
}

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function AgendaView() {
  const qc = useQueryClient();
  const { accounts, items: accountList, selected, select } = useSelectedAccount();
  const accountId = selected?.id ?? null;
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setPage(1);
    setPicked(new Set());
  }, [accountId, q]);

  const list = useQuery({
    queryKey: ['device-contacts', accountId, q, page],
    queryFn: () =>
      api<DeviceList>(
        `/accounts/${accountId}/device-contacts?${toQueryString({ q: q || undefined, page })}`,
      ),
    enabled: !!accountId,
    refetchInterval: 20_000,
    placeholderData: (prev) => prev,
  });
  const importer = useMutation({
    mutationFn: () =>
      api<{ created: number; alreadyInCrm: number; withoutPhone: number }>(
        `/accounts/${accountId}/device-contacts/import`,
        { method: 'POST', json: { ids: [...picked] } },
      ),
    onSuccess: () => {
      setConfirm(false);
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: ['device-contacts'] });
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });

  const d = list.data;
  const selectable = (d?.items ?? []).filter((c) => c.phoneE164 && !c.inCrm);
  const allPicked = selectable.length > 0 && selectable.every((c) => picked.has(c.id));
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const pages = d ? Math.max(1, Math.ceil(d.total / 30)) : 1;

  return (
    <>
      <PageHeader
        title="Agenda do aparelho"
        description="Nomes e telefones que o WhatsApp entregou ao aparelho conectado. Nada vira contato sem você escolher."
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href={accountId ? `/contatos?conta=${accountId}` : '/contatos'}>
                <ArrowLeft className="h-4 w-4" aria-hidden /> Contatos
              </Link>
            </Button>
            <AccountPicker value={accountId} onChange={select} items={accountList} />
          </>
        }
      />
      {accounts.isPending && <Spinner />}
      {accountId && list.isError && <Alert tone="danger">{list.error.message}</Alert>}
      {d && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
            <StatCard label="Recebidos do WhatsApp" value={formatNumber(d.stats.identities)} />
            <StatCard label="Com telefone" value={formatNumber(d.stats.withPhone)} />
            <StatCard
              label="Com nome salvo na agenda"
              value={formatNumber(d.stats.withSavedName)}
            />
          </div>
          {d.stats.identities === 0 ? (
            <Alert tone="info" title="O WhatsApp ainda não enviou a agenda deste aparelho">
              A agenda e o histórico são entregues pelo WhatsApp ao vincular o aparelho. Se esta
              instância foi pareada antes desta função existir, remova a conexão (ação manual, em
              Conexões) e pareie de novo. Veja também System Health → Eventos do sistema: os itens
              &ldquo;Agenda (…)&rdquo; e &ldquo;Sincronização do WhatsApp&rdquo; mostram o que o
              WhatsApp entregou e se a sincronização da agenda está parada.
            </Alert>
          ) : (
            <Card>
              <CardContent className="space-y-3 pt-5">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-full sm:w-72">
                    <Search
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
                      aria-hidden
                    />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Pesquisar nome ou telefone"
                      className="h-9 pl-9"
                      aria-label="Pesquisar na agenda"
                    />
                  </div>
                  <Button
                    className="ml-auto"
                    disabled={picked.size === 0}
                    onClick={() => setConfirm(true)}
                  >
                    Importar selecionados ({picked.size})
                  </Button>
                </div>
                {importer.isSuccess && (
                  <Alert tone="success">
                    {importer.data.created} contato(s) importado(s) com consentimento pendente
                    {importer.data.alreadyInCrm
                      ? `; ${importer.data.alreadyInCrm} já estavam em Contatos`
                      : ''}
                    .
                  </Alert>
                )}
                <Table>
                  <THead>
                    <tr>
                      <TH className="w-10">
                        <input
                          type="checkbox"
                          aria-label="Selecionar todos desta página"
                          checked={allPicked}
                          disabled={selectable.length === 0}
                          onChange={() =>
                            setPicked((p) => {
                              const n = new Set(p);
                              for (const c of selectable) {
                                if (allPicked) n.delete(c.id);
                                else n.add(c.id);
                              }
                              return n;
                            })
                          }
                          className="accent-[var(--color-accent)]"
                        />
                      </TH>
                      <TH>Nome</TH>
                      <TH>Telefone</TH>
                      <TH>Situação</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {d.items.map((c) => (
                      <TR key={c.id}>
                        <TD>
                          <input
                            type="checkbox"
                            aria-label={`Selecionar ${c.name ?? c.phoneE164 ?? 'contato'}`}
                            checked={picked.has(c.id)}
                            disabled={!c.phoneE164 || c.inCrm}
                            onChange={() => toggle(c.id)}
                            className="accent-[var(--color-accent)]"
                          />
                        </TD>
                        <TD>
                          <span className="font-medium">{c.name ?? 'Sem nome'}</span>
                          {c.savedName && c.pushName && c.savedName !== c.pushName && (
                            <span className="block text-xs text-subtle">Perfil: {c.pushName}</span>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap">
                          {c.phoneE164 ? formatPhone(c.phoneE164) : '—'}
                        </TD>
                        <TD>
                          {c.inCrm ? (
                            <Badge tone="success">Já em Contatos</Badge>
                          ) : c.phoneE164 ? (
                            <Badge>Disponível</Badge>
                          ) : (
                            <Badge tone="warning">Sem telefone informado</Badge>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                {pages > 1 && (
                  <div className="flex items-center justify-end gap-2 text-xs text-muted">
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
          )}
        </div>
      )}
      <Modal
        open={confirm}
        onOpenChange={setConfirm}
        title={`Importar ${picked.size} contato(s) da agenda?`}
        description="Eles entram em Contatos com origem “Agenda do aparelho conectado” e consentimento PENDENTE."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancelar
            </Button>
            <Button loading={importer.isPending} onClick={() => importer.mutate()}>
              <Smartphone className="h-4 w-4" aria-hidden /> Importar
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Contatos pendentes <strong className="text-fg">não recebem campanhas</strong> até você
          registrar o consentimento de cada um. Quem já pediu descadastramento continua
          descadastrado. Telefones que já estão em Contatos não são alterados.
        </p>
        {importer.isError && (
          <Alert tone="danger" className="mt-3">
            {importer.error.message}
          </Alert>
        )}
      </Modal>
    </>
  );
}

export default function DeviceContactsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <AgendaView />
    </Suspense>
  );
}
