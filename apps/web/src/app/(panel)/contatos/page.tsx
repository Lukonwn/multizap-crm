import type { Metadata } from 'next';
import { ModulePending } from '@/components/module-pending';

export const metadata: Metadata = { title: 'Contatos' };

export default function Page() {
  return <ModulePending moduleKey="contacts" />;
}
