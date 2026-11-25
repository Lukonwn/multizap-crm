import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export interface KnowledgeRow {
  sourceId: string;
  sourceName: string;
  title: string | null;
  content: string;
  rank: number;
}

/**
 * Busca nos trechos das fontes que o agente pode usar (prontas e habilitadas), com o índice de
 * texto do PostgreSQL em português. `query` já vem como "termo | termo | ..." (qualquer um dos
 * termos); a consulta é parametrizada e só aceita letras e números.
 */
export async function searchKnowledge(
  db: Db,
  agentId: string,
  query: string,
  limit = 4,
): Promise<KnowledgeRow[]> {
  const q = query.trim();
  if (!q || !/^[\p{L}\p{N}]+( \| [\p{L}\p{N}]+)*$/u.test(q)) return [];
  const rows = await db.$queryRaw<
    {
      source_id: string;
      source_name: string;
      title: string | null;
      content: string;
      rank: number;
    }[]
  >`
    SELECT c.source_id, s.name AS source_name, c.title, c.content,
           ts_rank_cd(
             to_tsvector('portuguese', coalesce(c.title, '') || ' ' || c.content),
             to_tsquery('portuguese', ${q})
           ) AS rank
    FROM ai_knowledge_chunks c
    JOIN ai_knowledge_sources s ON s.id = c.source_id
    JOIN ai_agent_knowledge ak ON ak.source_id = s.id AND ak.agent_id = ${agentId}::uuid
    WHERE s.enabled AND s.status = 'READY'
      AND to_tsvector('portuguese', coalesce(c.title, '') || ' ' || c.content)
          @@ to_tsquery('portuguese', ${q})
    ORDER BY rank DESC, c.position ASC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    sourceId: r.source_id,
    sourceName: r.source_name,
    title: r.title,
    content: r.content,
    rank: Number(r.rank),
  }));
}

/** O agente tem ao menos uma fonte pronta e habilitada? */
export async function hasKnowledge(db: Db, agentId: string): Promise<boolean> {
  return (
    (await db.aiAgentKnowledge.count({
      where: { agentId, source: { enabled: true, status: 'READY' } },
    })) > 0
  );
}
