'use client';
import { LogOut, Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { Button } from '@multizap/ui';
import { MODULES } from '@/lib/modules';
import { useAuth } from '../auth/auth-provider';
import { NotificationsBell } from './notifications-bell';

export function Topbar({ onMenu, menuOpen }: { onMenu: () => void; menuOpen: boolean }) {
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
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur-md lg:px-8">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <button
          type="button"
          onClick={onMenu}
          className="-ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg lg:hidden"
          aria-label="Abrir menu"
          aria-expanded={menuOpen}
          aria-controls="menu-principal"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="hidden text-subtle sm:inline">MultiZap</span>
        <span className="hidden text-border-strong sm:inline">/</span>
        <span className="truncate font-medium text-fg">{current?.label ?? ''}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <NotificationsBell />
        <div className="hidden text-right sm:block">
          <p className="text-sm font-medium leading-tight text-fg">{user.name}</p>
          <p className="text-xs text-subtle">{user.email}</p>
        </div>
        <span
          className="hidden h-9 w-9 place-items-center rounded-full sm:grid border border-border bg-surface-2 text-xs font-semibold text-muted"
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
