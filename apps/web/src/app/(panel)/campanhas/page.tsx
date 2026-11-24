import type { Metadata } from 'next';
import { ModulePending } from '@/components/module-pending';

export const metadata: Metadata = { title: 'Campanhas' };

export default function Page() {
  return <ModulePending moduleKey="campaigns" />;
}
