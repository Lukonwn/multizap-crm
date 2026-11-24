import { CheckCircle2, Clock } from 'lucide-react';
import { Badge, Card, PageHeader } from '@multizap/ui';
import { moduleByKey } from '@/lib/modules';

/**
 * Tela de módulo ainda não implementado. Exibe claramente a fase prevista,
 * sem botões ou dados fictícios.
 */
export function ModulePending({ moduleKey }: { moduleKey: string }) {
  const m = moduleByKey(moduleKey);
  return (
    <>
      <PageHeader
        title={m.label}
        description={m.description}
        actions={
          <Badge tone="warning" dot>
            Disponível na Fase {m.phase}
          </Badge>
        }
      />
      <Card className="overflow-hidden">
        <div className="flex flex-col items-center px-6 py-14 text-center">
          <span className="mb-5 grid h-14 w-14 place-items-center rounded-2xl border border-border bg-surface-2">
            <m.icon className="h-6 w-6 text-accent" aria-hidden />
          </span>
          <p className="text-base font-semibold text-fg">Módulo em desenvolvimento</p>
          <p className="mt-1.5 max-w-md text-sm text-muted">
            Este módulo será entregue na <strong className="text-fg">Fase {m.phase}</strong> do
            plano. Nenhuma ação está disponível aqui ainda.
          </p>
          {m.upcoming.length > 0 && (
            <ul className="mt-8 grid w-full max-w-xl gap-2 text-left sm:grid-cols-2">
              {m.upcoming.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 rounded-lg border border-border bg-bg-soft px-3 py-2.5 text-sm text-muted"
                >
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border bg-bg-soft/60 px-6 py-3 text-xs text-subtle">
          <CheckCircle2 className="h-3.5 w-3.5 text-accent" aria-hidden />
          Fase 1 concluída: fundação, autenticação e design system.
        </div>
      </Card>
    </>
  );
}
