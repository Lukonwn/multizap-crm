'use client';
import { useEffect, useState } from 'react';
import type { AiModelDTO } from '@multizap/shared';
import { Alert, Field, Input, Spinner, cn } from '@multizap/ui';
import { useAiModels, useAiSettings } from '@/lib/ai';

const price = (v: number | null) => (v === null ? '—' : `US$ ${v.toFixed(v < 1 ? 3 : 2)}`);

/**
 * Escolha do modelo da OpenRouter. Com a chave configurada, pesquisa na lista real de modelos;
 * sem ela, aceita o identificador digitado (ex.: openai/gpt-4o-mini).
 */
export function ModelPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (m: { id: string; supportsTemperature?: boolean }) => void;
}) {
  const settings = useAiSettings();
  const configured = !!settings.data?.configured;
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const models = useAiModels(debounced, configured);

  if (!configured)
    return (
      <Field
        label="Modelo"
        htmlFor="model-id"
        hint="Configure a chave da OpenRouter para pesquisar os modelos disponíveis. Por enquanto, digite o identificador."
      >
        <Input
          id="model-id"
          value={value}
          placeholder="openai/gpt-4o-mini"
          onChange={(e) => onChange({ id: e.target.value.trim() })}
        />
      </Field>
    );

  const items: AiModelDTO[] = models.data?.items.slice(0, 50) ?? [];
  return (
    <div>
      <Field
        label="Modelo"
        htmlFor="model-search"
        hint={value ? `Selecionado: ${value}` : undefined}
      >
        <Input
          id="model-search"
          value={q}
          placeholder="Pesquisar modelo (ex.: gpt, claude, llama)"
          onChange={(e) => setQ(e.target.value)}
        />
      </Field>
      <div
        className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-border"
        role="listbox"
        aria-label="Modelos"
      >
        {models.isLoading ? (
          <div className="p-3">
            <Spinner />
          </div>
        ) : models.error ? (
          <Alert tone="danger" className="m-2">
            {(models.error as Error).message}
          </Alert>
        ) : !items.length ? (
          <p className="p-3 text-sm text-muted">Nenhum modelo encontrado.</p>
        ) : (
          items.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === value}
              onClick={() => onChange({ id: m.id, supportsTemperature: m.supportsTemperature })}
              className={cn(
                'flex w-full flex-col items-start gap-0.5 border-b border-border px-3 py-2 text-left last:border-0 hover:bg-surface-2',
                m.id === value && 'bg-accent-soft',
              )}
            >
              <span className="text-sm text-fg">{m.name}</span>
              <span className="text-xs text-subtle">
                {m.id} · entrada {price(m.promptPerMillion)} / saída {price(m.completionPerMillion)}{' '}
                por 1M tokens
                {m.contextLength ? ` · contexto ${m.contextLength.toLocaleString('pt-BR')}` : ''}
              </span>
            </button>
          ))
        )}
      </div>
      {models.data && models.data.total > items.length && (
        <p className="mt-1 text-xs text-subtle">
          Mostrando {items.length} de {models.data.total}. Refine a pesquisa.
        </p>
      )}
    </div>
  );
}
