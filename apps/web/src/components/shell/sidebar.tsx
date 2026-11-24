'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import { cn } from '@multizap/ui';
import { CURRENT_PHASE, MODULES } from '@/lib/modules';
import { BrandMark } from '../brand';
import { useUnreadConversations } from '@/lib/inbox';

export function Sidebar({
  collapsed: collapsedPref,
  onToggle,
  mobileOpen,
  onClose,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** Telas pequenas: menu em gaveta sobre o conteúdo. */
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  // Na gaveta (celular) o menu aparece sempre completo.
  const collapsed = collapsedPref && !mobileOpen;
  const unread = useUnreadConversations();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        id="menu-principal"
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex h-screen w-64 shrink-0 flex-col border-r border-border bg-bg-soft transition-transform duration-200 ease-out',
          'lg:sticky lg:top-0 lg:z-auto lg:translate-x-0 lg:transition-[width]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'lg:w-[72px]' : 'lg:w-64',
        )}
      >
        <div
          className={cn(
            'flex h-16 items-center gap-3 border-b border-border px-4',
            collapsed && 'justify-center px-0',
          )}
        >
          <BrandMark />
          {!collapsed && (
            <div className="min-w-0 animate-fade-in">
              <p className="truncate text-sm font-semibold tracking-tight text-fg">MultiZap</p>
              <p className="text-[11px] text-subtle">CRM privado</p>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg lg:hidden"
            aria-label="Fechar menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3" aria-label="Menu principal">
          {MODULES.map((m) => {
            const active = isActive(m.href);
            const pending = m.phase > CURRENT_PHASE;
            return (
              <Link
                key={m.key}
                href={m.href}
                title={collapsed ? m.label : undefined}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors',
                  active ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                  collapsed && 'justify-center px-0',
                )}
              >
                {active && (
                  <span
                    className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent"
                    aria-hidden
                  />
                )}
                <m.icon
                  className={cn(
                    'h-[18px] w-[18px] shrink-0',
                    active ? 'text-accent' : 'text-subtle group-hover:text-muted',
                  )}
                  aria-hidden
                />
                {!collapsed && (
                  <>
                    <span className="truncate">{m.label}</span>
                    {pending && (
                      <span className="ml-auto rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-subtle">
                        F{m.phase}
                      </span>
                    )}
                    {!pending && m.key === 'inbox' && (unread.data ?? 0) > 0 && (
                      <span
                        className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-[#04130d]"
                        aria-label={`${unread.data} conversas não lidas`}
                      >
                        {unread.data! > 99 ? '99+' : unread.data}
                      </span>
                    )}
                  </>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="hidden border-t border-border p-3 lg:block">
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              'flex h-9 w-full items-center gap-3 rounded-lg px-3 text-xs text-subtle transition-colors hover:bg-surface-2 hover:text-fg',
              collapsed && 'justify-center px-0',
            )}
            aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" />
            ) : (
              <ChevronsLeft className="h-4 w-4" />
            )}
            {!collapsed && <span>Recolher menu</span>}
          </button>
        </div>
      </aside>
    </>
  );
}
