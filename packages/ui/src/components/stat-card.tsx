import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../cn';
import type { Tone } from './badge';

const iconTones: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-muted',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

/**
 * Card estatístico. `value` null indica dado indisponível — exibido como "—",
 * nunca como zero inventado.
 */
export function StatCard({
  label,
  value,
  icon: Icon,
  tone = 'accent',
  hint,
  className,
}: {
  label: string;
  value: number | string | null;
  icon?: LucideIcon;
  tone?: Tone;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'group rounded-card border border-border bg-surface p-4 shadow-card sm:p-5',
        'transition-colors hover:border-border-strong animate-slide-up',
        className,
      )}
    >
      <div className="flex min-h-8 items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted">{label}</p>
        {Icon && (
          <span
            className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', iconTones[tone])}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        )}
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums text-fg">
        {value === null ? <span className="text-subtle">—</span> : value}
      </p>
      {hint && <p className="mt-1 text-xs text-subtle">{hint}</p>}
    </div>
  );
}
