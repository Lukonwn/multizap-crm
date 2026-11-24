import * as React from 'react';
import { cn } from '@multizap/ui';

/** Área de texto com o mesmo visual dos campos do painel. */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, rows = 3, ...props }, ref) => (
  <textarea
    ref={ref}
    rows={rows}
    className={cn(
      'w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
