'use client';
import { LogOut } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { Button } from '@multizap/ui';
import { MODULES } from '@/lib/modules';
import { useAuth } from '../auth/auth-provider';
import { NotificationsBell } from './notifications-bell';

export function Topbar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const current = MODULES.find((m) =>
    m.href === '/' ? pathname === '/' : pathname.startsWith(m.href),
  );
  const initials = user.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-border bg-bg/80 px-8 backdrop-blur-md">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-subtle">MultiZap</span>
        <span className="text-border-strong">/</span>
        <span className="font-medium text-fg">{current?.label ?? ''}</span>
      </div>
      <div className="flex items-center gap-3">
        <NotificationsBell />
        <div className="hidden text-right sm:block">
          <p className="text-sm font-medium leading-tight text-fg">{user.name}</p>
          <p className="text-xs text-subtle">{user.email}</p>
        </div>
        <span
          className="grid h-9 w-9 place-items-center rounded-full border border-border bg-surface-2 text-xs font-semibold text-muted"
          aria-hidden
        >
          {initials}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void logout()}
          title="Sair"
          aria-label="Sair"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
