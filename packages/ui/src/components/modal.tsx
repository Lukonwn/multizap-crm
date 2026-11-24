'use client';
import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../cn';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm animate-fade-in" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2',
            'rounded-2xl border border-border bg-surface shadow-pop animate-scale-in focus:outline-none',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border p-5">
            <div>
              <Dialog.Title className="text-base font-semibold text-fg">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-sm text-muted">
                  {description}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              className="rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              aria-label="Fechar"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          {children && <div className="p-5">{children}</div>}
          {footer && (
            <div className="flex justify-end gap-2 border-t border-border p-4">{footer}</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
