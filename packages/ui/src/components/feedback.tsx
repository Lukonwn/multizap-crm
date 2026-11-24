import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import { cn } from '../cn';

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn('h-5 w-5 animate-spin text-accent', className)}
      aria-label="Carregando"
    />
  );
}

const alertTones = {
  info: { cls: 'border-info/25 bg-info-soft text-info', icon: Info },
  success: { cls: 'border-success/25 bg-success-soft text-success', icon: CheckCircle2 },
  warning: { cls: 'border-warning/25 bg-warning-soft text-warning', icon: AlertTriangle },
  danger: { cls: 'border-danger/25 bg-danger-soft text-danger', icon: XCircle },
} as const;

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: keyof typeof alertTones;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const { cls, icon: Icon } = alertTones[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border p-3 text-sm', cls, className)}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn('text-fg/80', title && 'mt-0.5')}>{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}
    >
      {Icon && (
        <span className="mb-4 grid h-12 w-12 place-items-center rounded-xl border border-border bg-surface-2 text-muted">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      )}
      <p className="text-sm font-semibold text-fg">{title}</p>
      {description && <p className="mt-1.5 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatusDot({
  tone = 'neutral',
  pulse,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
  pulse?: boolean;
}) {
  const color = {
    neutral: 'bg-subtle',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    accent: 'bg-accent',
  }[tone];
  return (
    <span className="relative inline-flex h-2 w-2">
      {pulse && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            color,
          )}
        />
      )}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', color)} />
    </span>
  );
}
