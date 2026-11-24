'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@multizap/ui';

const TABS = [
  { href: '/ai/agentes', label: 'Agentes' },
  { href: '/ai/personas', label: 'Personas' },
  { href: '/ai/atendimentos', label: 'Atendimentos' },
  { href: '/ai/laboratorio', label: 'Laboratório' },
  { href: '/ai/configuracoes', label: 'Configurações' },
];

/** Navegação entre as áreas do MultiZap AI, no mesmo estilo dos controles segmentados do painel. */
export function AiTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Áreas do MultiZap AI"
      className="mb-6 flex max-w-full overflow-x-auto rounded-lg border border-border bg-bg-soft p-1 sm:inline-flex"
    >
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              active ? 'bg-surface-3 text-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
