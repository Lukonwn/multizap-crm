import { CheckCircle2, CircleDashed, Clock, PowerOff, TriangleAlert, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ACCOUNT_STATUS_LABEL, type AccountStatusValue } from '@multizap/shared';

/**
 * Distribuição de status das conexões (dado de ESTADO → cores de status
 * reservadas, sempre com ícone + rótulo + contagem; nunca apenas cor).
 * Barra segmentada com espaçamento de 2px; cada segmento tem tooltip.
 */
const SEGMENTS: { status: AccountStatusValue; color: string; icon: LucideIcon }[] = [
  { status: 'CONNECTED', color: 'var(--color-success)', icon: CheckCircle2 },
  { status: 'AWAITING_CONNECTION', color: 'var(--color-info)', icon: Clock },
  { status: 'DISCONNECTED', color: 'var(--color-warning)', icon: TriangleAlert },
  { status: 'ATTENTION', color: 'var(--color-warning)', icon: TriangleAlert },
  { status: 'NEEDS_REPAIR', color: 'var(--color-danger)', icon: XCircle },
  { status: 'NOT_CONFIGURED', color: 'var(--color-border-strong)', icon: CircleDashed },
  { status: 'DISABLED', color: 'var(--color-surface-3)', icon: PowerOff },
];

export function StatusDistribution({
  counts,
  total,
}: {
  counts: Partial<Record<AccountStatusValue, number>>;
  total: number;
}) {
  const present = SEGMENTS.filter((s) => (counts[s.status] ?? 0) > 0);
  if (total === 0)
    return <p className="text-sm text-subtle">Nenhum dispositivo conectado cadastrado.</p>;
  return (
    <div>
      <div
        className="flex h-2.5 gap-[2px] overflow-hidden rounded-full"
        role="img"
        aria-label="Distribuição de status das conexões"
      >
        {present.map((s) => {
          const n = counts[s.status] ?? 0;
          return (
            <div
              key={s.status}
              className="h-full rounded-[3px] transition-[flex-grow] duration-300 first:rounded-l-full last:rounded-r-full"
              style={{ flexGrow: n, background: s.color }}
              title={`${ACCOUNT_STATUS_LABEL[s.status]}: ${n}`}
            />
          );
        })}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {present.map((s) => (
          <li key={s.status} className="flex items-center gap-1.5 text-xs text-muted">
            <s.icon
              className="h-3.5 w-3.5"
              style={{
                color: s.color === 'var(--color-surface-3)' ? 'var(--color-subtle)' : s.color,
              }}
              aria-hidden
            />
            {ACCOUNT_STATUS_LABEL[s.status]}{' '}
            <span className="font-medium text-fg tabular-nums">{counts[s.status]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
