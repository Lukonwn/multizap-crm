'use client';
import { useEffect, useState } from 'react';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { PauseBanner } from '@/components/system/pause-banner';

const STORAGE_KEY = 'mz:sidebar-collapsed';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      /* armazenamento indisponível: mantém o padrão */
    }
  }, []);

  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(STORAGE_KEY, c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });

  return (
    <div className="flex min-h-screen">
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <PauseBanner />
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-8 py-8 animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}
