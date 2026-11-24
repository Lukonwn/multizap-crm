-- Reverte a migration 20261125120000_ai_foundation (MultiZap AI, Entrega 1).
-- Use somente com backup recente: apaga personas, agentes, versões, sessões de teste e consumo.
-- Depois de rodar, remova a linha correspondente em _prisma_migrations:
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261125120000_ai_foundation';
BEGIN;
DROP TABLE IF EXISTS "ai_agent_events";
DROP TABLE IF EXISTS "ai_token_usage";
DROP TABLE IF EXISTS "ai_test_messages";
DROP TABLE IF EXISTS "ai_test_sessions";
DROP TABLE IF EXISTS "ai_agent_accounts";
ALTER TABLE IF EXISTS "ai_agents" DROP CONSTRAINT IF EXISTS "ai_agents_published_version_id_fkey";
DROP TABLE IF EXISTS "ai_agent_versions";
DROP TABLE IF EXISTS "ai_agents";
DROP TABLE IF EXISTS "ai_persona_revisions";
DROP TABLE IF EXISTS "ai_personas";
DROP TABLE IF EXISTS "ai_credentials";
DROP TYPE IF EXISTS "AiEventCategory";
DROP TYPE IF EXISTS "AiUsageContext";
DROP TYPE IF EXISTS "AiAgentStatus";
DROP TYPE IF EXISTS "AiAgentMode";
COMMIT;
