-- Reversão de 20261127120000_ai_knowledge (base de conhecimento do MultiZap AI).
-- Remove só o que a migração criou; nenhuma tabela do CRM é tocada.
-- Depois de executar, apague a linha correspondente em "_prisma_migrations".
-- Os arquivos enviados ficam no bucket (prefixo ai/knowledge/) e podem ser apagados à parte.
BEGIN;
DROP TABLE IF EXISTS "ai_agent_knowledge";
DROP TABLE IF EXISTS "ai_knowledge_chunks";
DROP TABLE IF EXISTS "ai_knowledge_sources";
ALTER TABLE "ai_drafts" DROP COLUMN IF EXISTS "sources";
DROP TYPE IF EXISTS "AiKnowledgeStatus";
DROP TYPE IF EXISTS "AiKnowledgeKind";
COMMIT;
