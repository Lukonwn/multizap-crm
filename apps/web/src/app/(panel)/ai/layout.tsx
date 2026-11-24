import { PageHeader } from '@multizap/ui';
import { AiTabs } from '@/components/ai/ai-tabs';

export default function AiLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader
        title="MultiZap AI"
        description="Agentes de IA para atendimento pelo WhatsApp, com revisão humana por padrão."
      />
      <AiTabs />
      {children}
    </>
  );
}
