'use client';
import Link from 'next/link';
import { ChevronRight, Link2, Smartphone, SmartphoneNfc } from 'lucide-react';
import { CONNECTION_TYPE_LABEL, formatPhone, type AccountDTO } from '@multizap/shared';
import { Button, Card } from '@multizap/ui';
import { timeAgo } from '@/lib/format';
import { AccountStatusBadge } from './status-badge';

export function AccountCard({
  account,
  onPair,
}: {
  account: AccountDTO;
  onPair: (a: AccountDTO) => void;
}) {
  const isWeb = account.connectionType === 'WHATSAPP_WEB';
  const canPair = isWeb && !account.integration?.pairedAt && account.status !== 'DISABLED';
  const needsRepair = isWeb && account.status === 'NEEDS_REPAIR';
  const Icon = isWeb ? SmartphoneNfc : Smartphone;

  return (
    <Card className="group flex flex-col p-5 transition-colors hover:border-border-strong animate-slide-up">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-surface-2 text-muted">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <Link
              href={`/conexoes/${account.id}`}
              className="block truncate text-sm font-semibold text-fg hover:text-accent"
            >
              {account.name}
            </Link>
            <p className="truncate text-xs text-muted">{formatPhone(account.phoneE164)}</p>
          </div>
        </div>
        <AccountStatusBadge account={account} />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-subtle">Tipo</dt>
          <dd className="mt-0.5 text-fg/90">{CONNECTION_TYPE_LABEL[account.connectionType]}</dd>
        </div>
        <div>
          <dt className="text-subtle">Última atividade</dt>
          <dd className="mt-0.5 text-fg/90">{isWeb ? timeAgo(account.lastActivityAt) : '—'}</dd>
        </div>
      </dl>

      <div className="mt-5 flex items-center gap-2 border-t border-border pt-4">
        {(canPair || needsRepair) && (
          <Button size="sm" onClick={() => onPair(account)}>
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            {needsRepair
              ? 'Parear novamente'
              : account.status === 'AWAITING_CONNECTION'
                ? 'Continuar pareamento'
                : 'Conectar'}
          </Button>
        )}
        <Button size="sm" variant="ghost" asChild className="ml-auto">
          <Link href={`/conexoes/${account.id}`}>
            Detalhes <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </Button>
      </div>
    </Card>
  );
}
