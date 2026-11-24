'use client';
import { createContext, useCallback, useContext, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import type { AdminProfile } from '@multizap/shared';
import { api, ApiError } from '@/lib/api';

interface AuthValue {
  user: AdminProfile;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}

export const ME_QUERY_KEY = ['auth', 'me'] as const;

export function useMe() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: () => api<{ user: AdminProfile }>('/auth/me').then((r) => r.user),
  });
}

export function AuthProvider({
  children,
  fallback,
  passwordChange,
}: {
  children: React.ReactNode;
  fallback: React.ReactNode;
  passwordChange: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const me = useMe();

  const unauthorized = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthorized) {
      const next = pathname && pathname !== '/' ? `?next=${encodeURIComponent(pathname)}` : '';
      router.replace(`/login${next}`);
    }
  }, [unauthorized, pathname, router]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      queryClient.clear();
      router.replace('/login');
    }
  }, [queryClient, router]);

  if (me.isPending || unauthorized) return <>{fallback}</>;
  if (me.isError) {
    return (
      <div className="grid min-h-screen place-items-center p-6 text-center">
        <div>
          <p className="text-sm font-semibold text-fg">Não foi possível conectar à API.</p>
          <p className="mt-1 text-sm text-muted">{me.error.message}</p>
          <button className="mt-4 text-sm text-accent hover:underline" onClick={() => me.refetch()}>
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }
  return (
    <AuthContext.Provider value={{ user: me.data, logout }}>
      {me.data.mustChangePassword ? passwordChange : children}
    </AuthContext.Provider>
  );
}
