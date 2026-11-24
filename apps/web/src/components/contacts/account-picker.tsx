'use client';
import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Select } from '@multizap/ui';
import { useAccounts } from '@/lib/accounts';

const STORAGE_KEY = 'mz:contacts-account';

/** Instância selecionada: ?conta=<id> na URL (fallback: última usada). */
export function useSelectedAccount() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const accounts = useAccounts();
  const fromUrl = params.get('conta');
  const items = accounts.data?.items ?? [];

  let selected = items.find((a) => a.id === fromUrl) ?? null;
  useEffect(() => {
    if (!accounts.data || selected) return;
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    const fallback = items.find((a) => a.id === remembered) ?? items[0];
    if (fallback) {
      const p = new URLSearchParams(params.toString());
      p.set('conta', fallback.id);
      router.replace(`${pathname}?${p.toString()}`);
    }
  }, [accounts.data, selected, items, params, pathname, router]);

  const select = (id: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
    const p = new URLSearchParams();
    p.set('conta', id);
    router.push(`${pathname}?${p.toString()}`);
  };

  selected = selected ?? null;
  return { accounts, items, selected, select };
}

export function AccountPicker({
  value,
  onChange,
  items,
}: {
  value: string | null;
  onChange: (id: string) => void;
  items: { id: string; name: string }[];
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="account-picker" className="whitespace-nowrap text-xs font-medium text-muted">
        Instância
      </label>
      <Select
        id="account-picker"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 min-w-52"
      >
        {items.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
