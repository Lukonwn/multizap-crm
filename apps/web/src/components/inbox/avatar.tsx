'use client';
import { useState } from 'react';
import { cn } from '@multizap/ui';

function initials(name: string): string {
  return (
    name
      .replace(/[^A-Za-zÀ-ú ]/g, '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join('')
      .toUpperCase() || '#'
  );
}

/** Foto de perfil da conversa (quando o WhatsApp a fornece) ou as iniciais do nome. */
export function Avatar({
  name,
  photoUrl,
  className,
}: {
  name: string;
  photoUrl: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        'grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-3 text-xs font-semibold text-muted',
        className,
      )}
      aria-hidden
    >
      {photoUrl && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
