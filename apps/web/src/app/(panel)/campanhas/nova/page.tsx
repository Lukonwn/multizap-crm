'use client';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '@multizap/ui';
import { CampaignBuilder } from '@/components/campaigns/campaign-builder';

export default function NewCampaignPage() {
  return (
    <>
      <Link
        href="/campanhas"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Campanhas
      </Link>
      <PageHeader
        title="Nova campanha"
        description="Monte a mensagem e escolha as instâncias. Nada é enviado ao salvar."
      />
      <CampaignBuilder />
    </>
  );
}
