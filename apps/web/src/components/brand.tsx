import { cn } from '@multizap/ui';

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent to-emerald-700 text-[#04130d] shadow-[0_8px_24px_-8px_rgb(16_185_129/0.7)]',
        className,
      )}
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 18V6l5 6 3-4 3 4 5-6v12" />
      </svg>
    </span>
  );
}
