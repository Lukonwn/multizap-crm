'use client';
import { useState } from 'react';
import { Plus, Smartphone } from 'lucide-react';
import type { AccountDTO } from '@multizap/shared';
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '@multizap/ui';
import { useAccounts } from '@/lib/accounts';
import { AccountCard } from '@/components/connections/account-card';
import { CreateAccountModal } from '@/components/connections/create-account-modal';
import { PairingModal } from '@/components/connections/pairing-modal';

export default function ConnectionsPage() {
  const accounts = useAccounts();
  const [creating, setCreating] = useState(false);
  const [pairingFor, setPairingFor] = useState<Pick<AccountDTO, 'id' | 'name'> | null>(null);

  const items = accounts.data?.items ?? [];
  const limit = accounts.data?.limit ?? 10;
  const full = items.length >= limit;

  return (
    <>
      <PageHeader
        title="Conexões"
        description={
          accounts.data
            ? `${items.length} de ${limit} instâncias cadastradas. As sessões são preservadas entre reinícios do sistema.`
            : 'Instâncias WhatsApp com sessões persistentes.'
        }
        actions={
          <Button
            onClick={() => setCreating(true)}
            disabled={full || !accounts.data}
            title={full ? 'Limite de instâncias atingido' : undefined}
          >
            <Plus className="h-4 w-4" aria-hidden /> Nova instância
          </Button>
        }
      />

      {accounts.isPending && (
        <div className="grid place-items-center py-20">
          <Spinner />
        </div>
      )}
      {accounts.isError && <Alert tone="danger">{accounts.error.message}</Alert>}
      {full && (
        <Alert tone="info" className="mb-4">
          O limite de {limit} instâncias foi atingido. Exclua uma instância para cadastrar outra.
        </Alert>
      )}

      {accounts.data && items.length === 0 && (
        <Card>
          <EmptyState
            icon={Smartphone}
            title="Nenhuma instância cadastrada"
            description="Cadastre sua primeira conta WhatsApp. Você poderá conectá-la por QR Code ou pelo número de telefone."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" aria-hidden /> Nova instância
              </Button>
            }
          />
        </Card>
      )}

      {items.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {items.map((a) => (
            <AccountCard key={a.id} account={a} onPair={setPairingFor} />
          ))}
        </div>
      )}

      <CreateAccountModal
        open={creating}
        onOpenChange={setCreating}
        onCreated={(account) => {
          // Dispositivo conectado: segue direto para o pareamento.
          if (account.connectionType === 'WHATSAPP_WEB') setPairingFor(account);
        }}
      />
      {pairingFor && (
        <PairingModal
          key={pairingFor.id}
          account={pairingFor}
          open
          onOpenChange={(o) => !o && setPairingFor(null)}
        />
      )}
    </>
  );
}
