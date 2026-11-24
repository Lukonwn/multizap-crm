'use client';
import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Alert, PageHeader, Spinner } from '@multizap/ui';
import { useCampaign } from '@/lib/campaigns';
import { CampaignBuilder } from '@/components/campaigns/campaign-builder';

export default function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useCampaign(id);
  return (
    <>
      <Link
        href={`/campanhas/${id}`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Campanha
      </Link>
      <PageHeader title="Editar campanha" />
      {q.isPending && <Spinner />}
      {q.isError && <Alert tone="danger">{q.error.message}</Alert>}
      {q.data &&
        (q.data.campaign.status === 'DRAFT' ? (
          <CampaignBuilder campaign={q.data.campaign} />
        ) : (
          <Alert tone="warning">Somente rascunhos podem ser editados.</Alert>
        ))}
    </>
  );
}
