'use client';
import { useRef, useState } from 'react';
import { FileSpreadsheet, X } from 'lucide-react';
import type { ToolUploadDTO } from '@multizap/shared';
import { Alert, Label, Select, cn } from '@multizap/ui';
import { uploadToolFile } from '@/lib/tools';

export interface UploadState {
  upload: ToolUploadDTO;
  hasHeader: boolean;
  phoneColumn: number;
}

/** Seleção + envio de um arquivo, com prévia e escolha de cabeçalho/coluna de telefone. */
export function ToolFileInput({
  label,
  value,
  onChange,
  phoneColumn,
}: {
  label: string;
  value: UploadState | null;
  onChange: (v: UploadState | null) => void;
  phoneColumn: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    if (!/\.(csv|txt|xlsx)$/i.test(f.name)) {
      setError('Formato não suportado. Envie um arquivo CSV, TXT ou XLSX.');
      return;
    }
    setProgress(0);
    try {
      const upload = await uploadToolFile(f, setProgress);
      onChange({ upload, hasHeader: upload.hasHeader, phoneColumn: upload.suggestedPhoneColumn });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  };

  if (!value) {
    return (
      <div>
        <Label>{label}</Label>
        {error && (
          <Alert tone="danger" className="mb-2">
            {error}
          </Alert>
        )}
        <button
          type="button"
          onClick={() => ref.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void pick(e.dataTransfer.files[0]);
          }}
          disabled={progress !== null}
          className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-border-strong bg-bg-soft px-6 py-8 text-center transition-colors hover:border-accent/60"
        >
          <FileSpreadsheet className="h-7 w-7 text-accent" aria-hidden />
          <p className="mt-2 text-sm font-medium text-fg">
            {progress !== null
              ? `Enviando... ${progress}%`
              : 'Arraste o arquivo ou clique para selecionar'}
          </p>
          <p className="text-xs text-subtle">CSV, TXT ou XLSX</p>
        </button>
        <input
          ref={ref}
          type="file"
          accept=".csv,.txt,.xlsx"
          className="hidden"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      </div>
    );
  }

  const { upload } = value;
  const width = Math.max(0, ...upload.sample.map((r) => r.length));
  const labels = Array.from(
    { length: width },
    (_, i) => (value.hasHeader && upload.sample[0]?.[i]) || `Coluna ${i + 1}`,
  );
  const body = (value.hasHeader ? upload.sample.slice(1) : upload.sample).slice(0, 5);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="mb-0">{label}</Label>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="inline-flex items-center gap-1 text-xs text-subtle hover:text-fg"
        >
          <X className="h-3.5 w-3.5" aria-hidden /> Trocar arquivo
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-bg-soft px-3 py-2.5 text-sm">
        <span className="flex items-center gap-2 font-medium text-fg">
          <FileSpreadsheet className="h-4 w-4 text-accent" aria-hidden /> {upload.fileName}
        </span>
        <span className="text-xs text-subtle">{(upload.size / 1024).toFixed(0)} KB</span>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={value.hasHeader}
            onChange={(e) => onChange({ ...value, hasHeader: e.target.checked })}
            className="accent-[var(--color-accent)]"
          />
          Primeira linha é cabeçalho
        </label>
        {phoneColumn && (
          <label className="flex items-center gap-2 text-xs text-muted">
            Coluna do telefone
            <Select
              value={value.phoneColumn}
              onChange={(e) => onChange({ ...value, phoneColumn: Number(e.target.value) })}
              className="h-8 w-44 text-xs"
            >
              {labels.map((l, i) => (
                <option key={i} value={i}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="bg-surface-2/60">
            <tr>
              {labels.map((l, i) => (
                <th
                  key={i}
                  className={cn(
                    'px-3 py-2 text-left font-medium',
                    phoneColumn && i === value.phoneColumn ? 'text-accent' : 'text-subtle',
                  )}
                >
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {body.map((r, ri) => (
              <tr key={ri}>
                {labels.map((_, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      'max-w-48 truncate px-3 py-1.5',
                      phoneColumn && ci === value.phoneColumn ? 'text-fg' : 'text-muted',
                    )}
                  >
                    {r[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
