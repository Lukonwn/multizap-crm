import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: { default: 'MultiZap CRM', template: '%s · MultiZap CRM' },
  description: 'Painel administrativo privado de gerenciamento de contas WhatsApp.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-bg">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
