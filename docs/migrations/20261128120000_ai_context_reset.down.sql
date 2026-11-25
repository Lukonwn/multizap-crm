-- Reversão de 20261128120000_ai_context_reset (reiniciar contexto da IA por conversa).
-- Remove só a coluna criada; nenhuma tabela do CRM é tocada.
-- Depois de executar, apague a linha correspondente em "_prisma_migrations".
BEGIN;
ALTER TABLE "ai_conversation_states" DROP COLUMN IF EXISTS "context_reset_at";
COMMIT;
