'use client';
import { KeyRound } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Spinner } from '@multizap/ui';
import { AuthProvider, useAuth } from '@/components/auth/auth-provider';
import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { AppShell } from '@/components/shell/app-shell';
import { BrandMark } from '@/components/brand';

function Splash() {
  return (
    <div className="grid min-h-screen place-items-center">
      <div className="flex flex-col items-center gap-4">
        <BrandMark />
        <Spinner />
      </div>
    </div>
  );
}

function ForcedPasswordChange() {
  const { logout } = useAuth();
  return (
    <div className="grid min-h-screen place-items-center p-6">
      <Card className="w-full max-w-md animate-slide-up">
        <CardHeader>
          <div>
            <span className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-warning-soft text-warning">
              <KeyRound className="h-5 w-5" aria-hidden />
            </span>
            <CardTitle className="text-base">Defina uma nova senha</CardTitle>
            <CardDescription>
              Por segurança, a senha inicial precisa ser trocada antes de continuar.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
          <button
            type="button"
            onClick={() => void logout()}
            className="mt-4 text-xs text-subtle hover:text-fg"
          >
            Sair
          </button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider fallback={<Splash />} passwordChange={<ForcedPasswordChange />}>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
