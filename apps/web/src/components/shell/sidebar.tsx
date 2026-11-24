'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '@multizap/ui';
import { CURRENT_PHASE, MODULES } from '@/lib/modules';
import { BrandMark } from '../brand';

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <aside
      className={cn(
        'sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-bg-soft transition-[width] duration-200 ease-out',
        collapsed ? 'w-[72px]' : 'w-64',
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
                </>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            'flex h-9 w-full items-center gap-3 rounded-lg px-3 text-xs text-subtle transition-colors hover:bg-surface-2 hover:text-fg',
            collapsed && 'justify-center px-0',
          )}
          aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          {!collapsed && <span>Recolher menu</span>}
        </button>
      </div>
    </aside>
  );
}
