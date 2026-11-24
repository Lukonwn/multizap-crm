'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatNumber } from '@/lib/format';

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

/**
 * Gráfico de linhas (uma escala, várias séries):
 *  - linhas de 2px, grade e eixos discretos;
 *  - legenda sempre presente (>= 2 séries) + rótulo direto no fim de cada linha;
 *  - hover: linha-guia vertical e tooltip com todos os valores do dia;
 *  - texto nunca usa a cor da série (só o marcador).
 */
export function LineChart({
  dates,
  series,
  height = 280,
}: {
  dates: string[];
  series: LineSeries[];
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setWidth(Math.max(320, Math.floor(e!.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { top: 16, right: 96, bottom: 28, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const niceMax = useMemo(() => {
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    return Math.ceil(max / step) * step;
  }, [max]);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(niceMax * t));
  const x = (i: number) =>
    pad.left + (dates.length <= 1 ? innerW / 2 : (i / (dates.length - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / niceMax) * innerH;
  const labelEvery = Math.max(1, Math.ceil(dates.length / Math.max(2, Math.floor(innerW / 80))));
  const fmtDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

  // Rótulos diretos no fim das linhas, afastados para não se sobreporem.
  const endLabels = useMemo(() => {
    const last = dates.length - 1;
    const items = series.map((s) => ({ s, y: y(s.values[last] ?? 0) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++)
      if (items[i]!.y - items[i - 1]!.y < 14) items[i]!.y = items[i - 1]!.y + 14;
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, dates.length, niceMax, width]);

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.min(dates.length - 1, Math.max(0, Math.round(rel * (dates.length - 1)))));
  };

  return (
    <div ref={ref} className="relative w-full">
      <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted" aria-label="Legenda">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} aria-hidden />{' '}
            {s.label}
          </li>
        ))}
      </ul>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Gráfico: ${series.map((s) => s.label).join(', ')}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={pad.left + innerW}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text
              x={pad.left - 8}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-[var(--color-subtle)] text-[10px] tabular-nums"
            >
              {formatNumber(t)}
            </text>
          </g>
        ))}
        {dates.map((d, i) =>
          i % labelEvery === 0 || i === dates.length - 1 ? (
            <text
              key={d}
              x={x(i)}
              y={height - 8}
              textAnchor="middle"
              className="fill-[var(--color-subtle)] text-[10px] tabular-nums"
            >
              {fmtDay(d)}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <path
            key={s.key}
            d={s.values
              .map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
              .join(' ')}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {endLabels.map(({ s, y: ly }) => (
          <g key={s.key}>
            <circle
              cx={x(dates.length - 1)}
              cy={y(s.values[dates.length - 1] ?? 0)}
              r={3}
              fill={s.color}
              stroke="var(--color-surface)"
              strokeWidth={2}
            />
            <text
              x={x(dates.length - 1) + 8}
              y={ly}
              dominantBaseline="middle"
              className="fill-[var(--color-muted)] text-[11px]"
            >
              {s.label}
            </text>
          </g>
        ))}
        {hover !== null && (
          <g pointerEvents="none">
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={pad.top}
              y2={pad.top + innerH}
              stroke="var(--color-border-strong)"
              strokeWidth={1}
            />
            {series.map((s) => (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(s.values[hover] ?? 0)}
                r={4}
                fill={s.color}
                stroke="var(--color-surface)"
                strokeWidth={2}
              />
            ))}
          </g>
        )}
        <rect
          x={pad.left}
          y={pad.top}
          width={innerW}
          height={innerH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-border bg-surface-2 p-2.5 text-xs shadow-pop"
          style={{ left: Math.min(x(hover) + 12, width - 180), top: 28 }}
        >
          <p className="mb-1.5 font-medium text-fg">
            {new Date(`${dates[hover]}T12:00:00Z`).toLocaleDateString('pt-BR', {
              weekday: 'short',
              day: '2-digit',
              month: '2-digit',
            })}
          </p>
          {series.map((s) => (
            <p key={s.key} className="flex items-center justify-between gap-4 text-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="tabular-nums text-fg">{formatNumber(s.values[hover] ?? 0)}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
