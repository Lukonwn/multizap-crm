-- Reversão de 20261126120000_ai_service (atendimento real do MultiZap AI).
-- Remove só o que a migração criou; nenhuma tabela do CRM é tocada.
-- Depois de executar, apague a linha correspondente em "_prisma_migrations".
BEGIN;
DROP TABLE IF EXISTS "ai_message_links";
DROP TABLE IF EXISTS "ai_drafts";
DROP TABLE IF EXISTS "ai_conversation_states";
DROP INDEX IF EXISTS "ai_token_usage_account_id_created_at_idx";
ALTER TABLE "ai_token_usage" DROP COLUMN IF EXISTS "conversation_id", DROP COLUMN IF EXISTS "purpose";
ALTER TABLE "ai_agents" DROP COLUMN IF EXISTS "max_replies_per_hour", DROP COLUMN IF EXISTS "min_interval_seconds", DROP COLUMN IF EXISTS "show_typing";
DROP TYPE IF EXISTS "AiDraftStatus";
COMMIT;
