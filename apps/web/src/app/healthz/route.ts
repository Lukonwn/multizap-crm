// Health check do serviço web (independente da API) — usado pela Railway.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', service: 'multizap-web' });
}
