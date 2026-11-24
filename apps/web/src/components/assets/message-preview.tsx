import { ExternalLink } from 'lucide-react';

/** Pré-visualização neutra de uma mensagem (balão de conversa). */
export function MessagePreview({
  text,
  imageUrl,
  link,
}: {
  text?: string | null;
  imageUrl?: string | null;
  link?: { url: string; title?: string; description?: string | null } | null;
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-soft p-4">
      <p className="mb-2 text-[11px] uppercase tracking-wider text-subtle">Pré-visualização</p>
      <div className="ml-auto max-w-sm rounded-2xl rounded-tr-sm bg-[#103529] p-2 text-sm text-fg shadow">
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" className="mb-2 max-h-64 w-full rounded-xl object-cover" />
        )}
        {link && (
          <div className="mb-2 rounded-lg border-l-2 border-accent bg-black/20 p-2">
            <p className="text-xs font-medium text-fg">{link.title ?? link.url}</p>
            {link.description && <p className="text-xs text-muted">{link.description}</p>}
            <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-accent">
              <ExternalLink className="h-3 w-3" /> {link.url}
            </p>
          </div>
        )}
        {text && <p className="whitespace-pre-wrap break-words px-1 pb-1">{text}</p>}
      </div>
    </div>
  );
}
