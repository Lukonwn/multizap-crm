import { FileAudio, FileText, FileVideo, Link2, MessageSquareText, Type } from 'lucide-react';
import type { AssetDTO } from '@multizap/shared';
import { cn } from '@multizap/ui';

/** Miniatura ou ícone representando o criativo. */
export function AssetThumb({ asset, className }: { asset: AssetDTO; className?: string }) {
  if (asset.hasThumbnail) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/assets/${asset.id}/thumbnail`}
        alt={asset.name}
        loading="lazy"
        className={cn('h-full w-full bg-surface-2 object-contain', className)}
      />
    );
  }
  const Icon =
    asset.kind === 'TEXT'
      ? Type
      : asset.kind === 'LINK'
        ? Link2
        : asset.kind === 'TEMPLATE'
          ? MessageSquareText
          : asset.mimeType?.startsWith('video/')
            ? FileVideo
            : asset.mimeType?.startsWith('audio/')
              ? FileAudio
              : FileText;
  const preview = asset.kind === 'LINK' ? asset.url : asset.textContent;
  return (
    <div className={cn('flex h-full w-full flex-col gap-2 bg-surface-2 p-3', className)}>
      <Icon className="h-5 w-5 shrink-0 text-accent" aria-hidden />
      {preview ? (
        <p className="line-clamp-4 break-words text-xs text-muted">{preview}</p>
      ) : (
        <p className="text-xs uppercase text-subtle">
          {asset.mimeType?.split('/')[1] ?? 'arquivo'}
        </p>
      )}
    </div>
  );
}
