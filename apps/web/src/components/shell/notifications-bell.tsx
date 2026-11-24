'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import { Button, Spinner, cn } from '@multizap/ui';
import { useMarkNotificationsRead, useNotifications } from '@/lib/dashboard';
import { timeAgo } from '@/lib/format';
import { SeverityBadge } from '../dashboard/severity';

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const notifications = useNotifications();
  const mark = useMarkNotificationsRead();
  const unread = notifications.data?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Notificações${unread ? ` (${unread} não lidas)` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-96 overflow-hidden rounded-xl border border-border bg-surface shadow-pop animate-slide-up">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold">Notificações</p>
            {unread > 0 && (
              <button
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                onClick={() => mark.mutate(undefined)}
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Marcar todas como lidas
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.isPending && (
              <div className="p-6">
                <Spinner />
              </div>
            )}
            {notifications.data?.items.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-subtle">
                Nenhuma notificação ativa.
              </p>
            )}
            {notifications.data?.items.map((n) => (
              <div
                key={n.id}
                className={cn(
                  'border-b border-border px-4 py-3 last:border-0',
                  !n.readAt && 'bg-surface-2/50',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <SeverityBadge severity={n.severity} />
                  <span className="text-[11px] text-subtle">{timeAgo(n.createdAt)}</span>
                </div>
                <p className="mt-1.5 text-sm font-medium text-fg">{n.title}</p>
                <p className="mt-0.5 text-xs text-muted">{n.message}</p>
                <div className="mt-2 flex gap-3 text-xs">
                  {n.accountId && (
                    <Link
                      href={`/conexoes/${n.accountId}`}
                      className="text-accent hover:underline"
                      onClick={() => setOpen(false)}
                    >
                      Ver instância
                    </Link>
                  )}
                  {!n.readAt && (
                    <button className="text-subtle hover:text-fg" onClick={() => mark.mutate(n.id)}>
                      Marcar como lida
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
