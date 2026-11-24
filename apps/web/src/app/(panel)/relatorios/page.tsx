import type { Metadata } from 'next';
import { ModulePending } from '@/components/module-pending';

export const metadata: Metadata = { title: 'Relatórios' };

export default function Page() {
  return <ModulePending moduleKey="reports" />;
}
