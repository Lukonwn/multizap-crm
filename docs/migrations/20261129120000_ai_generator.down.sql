-- Reversão de 20261129120000_ai_generator (Gerador de Persona e portão de idade).
-- Remove o que a migração criou; nenhuma tabela do CRM é tocada.
-- O valor 'GENERATOR' do tipo "AiUsageContext" permanece: o PostgreSQL não remove valores de enum,
-- e ele é inofensivo sem linhas que o usem (apague-as antes, se existirem).
-- Depois de executar, apague a linha correspondente em "_prisma_migrations".
BEGIN;
DELETE FROM "ai_token_usage" WHERE "context"::text = 'GENERATOR';
DROP TABLE IF EXISTS "ai_generations";
DROP TYPE IF EXISTS "AiGenerationStatus";
ALTER TABLE "ai_conversation_states" DROP COLUMN IF EXISTS "age_asked_at", DROP COLUMN IF EXISTS "age_confirmed_at";
ALTER TABLE "ai_agents" DROP COLUMN IF EXISTS "age_gate";
COMMIT;
