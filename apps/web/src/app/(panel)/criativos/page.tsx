import type { Metadata } from 'next';
import { ModulePending } from '@/components/module-pending';

export const metadata: Metadata = { title: 'Biblioteca de criativos' };

export default function Page() {
  return <ModulePending moduleKey="assets" />;
}
