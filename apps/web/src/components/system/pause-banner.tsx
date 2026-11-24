'use client';
import Link from 'next/link';
import { PauseCircle } from 'lucide-react';
import { useOperations } from '@/lib/system';

/** Faixa exibida em todo o painel enquanto as operações estiverem pausadas. */
export function PauseBanner() {
  const ops = useOperations();
  if (!ops.data?.paused) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/30 bg-warning-soft px-4 py-2 lg:px-8 text-sm text-warning"
    >
      <PauseCircle className="h-4 w-4 shrink-0" aria-hidden />
      <span className="font-medium">Operações pausadas.</span>
      <span className="text-fg/80">
        Envios de campanha, respostas e início de agendamentos estão suspensos
        {ops.data.reason ? ` (${ops.data.reason})` : ''}.
      </span>
      <Link
        href="/system-health"
        className="ml-auto text-xs font-medium underline-offset-2 hover:underline"
      >
        Gerenciar
      </Link>
    </div>
  );
}
