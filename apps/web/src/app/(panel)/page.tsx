import type { Metadata } from 'next';
import { ModulePending } from '@/components/module-pending';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardPage() {
  return <ModulePending moduleKey="dashboard" />;
}
