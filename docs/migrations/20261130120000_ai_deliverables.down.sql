-- Reversão de 20261130120000_ai_deliverables (entregáveis do MultiZap AI).
-- Remove só o que a migração criou; nenhuma tabela do CRM é tocada (as chaves estrangeiras
-- ficam nas tabelas novas e somem junto com elas).
-- Depois de executar, apague a linha correspondente em "_prisma_migrations".
BEGIN;
DROP TABLE IF EXISTS "ai_payments";
DROP TABLE IF EXISTS "ai_deliveries";
DROP TABLE IF EXISTS "ai_agent_deliverables";
DROP TABLE IF EXISTS "ai_deliverables";
ALTER TABLE "ai_drafts" DROP COLUMN IF EXISTS "deliverable_id";
DROP TYPE IF EXISTS "AiPaymentStatus";
DROP TYPE IF EXISTS "AiDeliveryStatus";
DROP TYPE IF EXISTS "AiApprovalMode";
DROP TYPE IF EXISTS "AiDeliverableKind";
COMMIT;
