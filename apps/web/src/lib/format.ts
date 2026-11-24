const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const num = new Intl.NumberFormat('pt-BR');

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'nunca';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'agora';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return dateTime.format(new Date(iso));
}

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

export function formatNumber(n: number): string {
  return num.format(n);
}
