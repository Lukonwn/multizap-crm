import { ACCOUNT_STATUS_LABEL, type AccountDTO } from '@multizap/shared';
import { Badge } from '@multizap/ui';
import { STATUS_TONE } from '@/lib/accounts';

/** Status da instância. Aparelho externo nunca é exibido como "conectado". */
export function AccountStatusBadge({
  account,
}: {
  account: Pick<AccountDTO, 'status' | 'connectionType'>;
}) {
  if (account.connectionType === 'EXTERNAL_DEVICE') {
    return account.status === 'DISABLED' ? (
      <Badge tone="neutral" dot>
        Desativada
      </Badge>
    ) : (
      <Badge tone="neutral" dot>
        Apenas cadastrado
      </Badge>
    );
  }
  return (
    <Badge tone={STATUS_TONE[account.status]} dot>
      {ACCOUNT_STATUS_LABEL[account.status]}
    </Badge>
  );
}
