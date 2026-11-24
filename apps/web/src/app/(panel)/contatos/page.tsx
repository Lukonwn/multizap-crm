'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  Plus,
  Search,
  Tags,
  Upload,
  Users,
} from 'lucide-react';
import { CONSENT_LABEL, ORIGIN_LABEL, formatPhone, type ContactListQuery } from '@multizap/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@multizap/ui';
import { CONSENT_TONE, toQueryString, useContacts, useTags } from '@/lib/contacts';
import { formatDateTime, formatNumber } from '@/lib/format';
import { AccountPicker, useSelectedAccount } from '@/components/contacts/account-picker';
import { ContactFormModal } from '@/components/contacts/contact-form-modal';
import { TagChip, TagsModal } from '@/components/contacts/tags';

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function ContactsView() {
  const router = useRouter();
  const { accounts, items: accountList, selected, select } = useSelectedAccount();
  const accountId = selected?.id ?? null;
  const [search, setSearch] = useState('');
  const [consent, setConsent] = useState('');
  const [tagId, setTagId] = useState('');
  const [optedOut, setOptedOut] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const q = useDebounced(search);

  useEffect(() => setPage(1), [q, consent, tagId, optedOut, accountId]);

  const query: ContactListQuery = {
    q: q || undefined,
    consent: (consent || undefined) as ContactListQuery['consent'],
    tagId: tagId || undefined,
    optedOut: (optedOut || undefined) as ContactListQuery['optedOut'],
    page,
    pageSize: 50,
  };
  const contacts = useContacts(accountId, query);
  const tags = useTags(accountId);
  const totalPages = contacts.data
    ? Math.max(1, Math.ceil(contacts.data.total / contacts.data.pageSize))
    : 1;
  const exportUrl = (format: 'csv' | 'xlsx') =>
    `/api/accounts/${accountId}/contacts/export?${toQueryString({ ...query, page: undefined, pageSize: undefined, format })}`;

  if (accounts.isPending) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (accountList.length === 0) {
    return (
      <>
        <PageHeader title="Contatos" description="Bases de contatos independentes por instância." />
        <Card>
          <EmptyState
            icon={Users}
            title="Cadastre uma instância primeiro"
            description="Cada instância possui sua própria base de contatos."
            action={
              <Button asChild>
                <Link href="/conexoes">Ir para Conexões</Link>
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Contatos"
        description="Cada instância possui uma base independente. Contatos não são compartilhados entre instâncias."
        actions={<AccountPicker value={accountId} onChange={select} items={accountList} />}
      />

      {accountId && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Novo contato
            </Button>
            <Button variant="secondary" asChild>
              <Link href={`/contatos/importar?conta=${accountId}`}>
                <Upload className="h-4 w-4" aria-hidden /> Importar lista
              </Link>
            </Button>
            <Button variant="secondary" onClick={() => setTagsOpen(true)}>
              <Tags className="h-4 w-4" aria-hidden /> Etiquetas
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/contatos/importacoes?conta=${accountId}`}>
                  <History className="h-3.5 w-3.5" aria-hidden /> Importações
                </Link>
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <a href={exportUrl('csv')} download>
                  <Download className="h-3.5 w-3.5" aria-hidden /> CSV
                </a>
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <a href={exportUrl('xlsx')} download>
                  <Download className="h-3.5 w-3.5" aria-hidden /> XLSX
                </a>
              </Button>
            </div>
          </div>

          {notice && (
            <Alert tone="warning" className="mb-4">
              {notice}
            </Alert>
          )}

          <div className="mb-4 grid gap-2 md:grid-cols-[1fr_180px_180px_180px]">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Pesquisar por nome ou telefone"
                className="pl-9"
                aria-label="Pesquisar"
              />
            </div>
            <Select
              value={consent}
              onChange={(e) => setConsent(e.target.value)}
              aria-label="Consentimento"
            >
              <option value="">Consentimento</option>
              <option value="GRANTED">Autorizados</option>
              <option value="PENDING">Pendentes</option>
              <option value="REVOKED">Revogados</option>
            </Select>
            <Select value={tagId} onChange={(e) => setTagId(e.target.value)} aria-label="Etiqueta">
              <option value="">Etiquetas</option>
              {tags.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Select
              value={optedOut}
              onChange={(e) => setOptedOut(e.target.value)}
              aria-label="Descadastramento"
            >
              <option value="">Situação</option>
              <option value="false">Ativos</option>
              <option value="true">Descadastrados</option>
            </Select>
          </div>

          {contacts.isError && <Alert tone="danger">{contacts.error.message}</Alert>}
          {contacts.data && contacts.data.total === 0 && !q && !consent && !tagId && !optedOut ? (
            <Card>
              <EmptyState
                icon={Users}
                title="Nenhum contato nesta instância"
                description="Cadastre contatos manualmente ou importe uma lista CSV, TXT ou XLSX."
                action={
                  <div className="flex gap-2">
                    <Button onClick={() => setCreating(true)}>Novo contato</Button>
                    <Button variant="secondary" asChild>
                      <Link href={`/contatos/importar?conta=${accountId}`}>Importar lista</Link>
                    </Button>
                  </div>
                }
              />
            </Card>
          ) : (
            <>
              <Table>
                <THead>
                  <tr>
                    <TH>Nome</TH>
                    <TH>Telefone</TH>
                    <TH>Etiquetas</TH>
                    <TH>Consentimento</TH>
                    <TH>Origem</TH>
                    <TH>Criado em</TH>
                  </tr>
                </THead>
                <TBody>
                  {contacts.data?.items.map((c) => (
                    <TR
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/contatos/${accountId}/${c.id}`)}
                    >
                      <TD>
                        <Link
                          href={`/contatos/${accountId}/${c.id}`}
                          className="font-medium text-fg hover:text-accent"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {c.name ?? <span className="text-subtle">Sem nome</span>}
                        </Link>
                      </TD>
                      <TD className="tabular-nums text-muted">{formatPhone(c.phoneE164)}</TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          {c.tags.slice(0, 3).map((t) => (
                            <TagChip key={t.id} tag={t} />
                          ))}
                          {c.tags.length > 3 && (
                            <span className="text-xs text-subtle">+{c.tags.length - 3}</span>
                          )}
                        </div>
                      </TD>
                      <TD>
                        {c.optedOutAt ? (
                          <Badge tone="danger" dot>
                            Descadastrado
                          </Badge>
                        ) : (
                          <Badge tone={CONSENT_TONE[c.consentStatus]} dot>
                            {CONSENT_LABEL[c.consentStatus]}
                          </Badge>
                        )}
                      </TD>
                      <TD className="text-muted">{ORIGIN_LABEL[c.origin]}</TD>
                      <TD className="text-muted">{formatDateTime(c.createdAt)}</TD>
                    </TR>
                  ))}
                  {contacts.data?.items.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-sm text-subtle">
                        Nenhum contato encontrado com esses filtros.
                      </td>
                    </tr>
                  )}
                </TBody>
              </Table>
              {contacts.data && (
                <div className="mt-3 flex items-center justify-between text-xs text-muted">
                  <span>{formatNumber(contacts.data.total)} contato(s)</span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}
                      aria-label="Página anterior"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span>
                      Página {page} de {totalPages}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => p + 1)}
                      aria-label="Próxima página"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {creating && (
            <ContactFormModal
              accountId={accountId}
              open
              onOpenChange={setCreating}
              onSaved={(_c, warning) => setNotice(warning ?? null)}
            />
          )}
          {tagsOpen && <TagsModal accountId={accountId} open onOpenChange={setTagsOpen} />}
        </>
      )}
    </>
  );
}

export default function ContactsPage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-24">
          <Spinner />
        </div>
      }
    >
      <ContactsView />
    </Suspense>
  );
}
