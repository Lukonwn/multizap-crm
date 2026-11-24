-- CreateEnum
CREATE TYPE "AiAgentMode" AS ENUM ('REVIEW', 'AUTO');

-- CreateEnum
CREATE TYPE "AiAgentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ERROR');

-- CreateEnum
CREATE TYPE "AiUsageContext" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "AiEventCategory" AS ENUM ('WHATSAPP', 'OPENROUTER', 'AGENT', 'KNOWLEDGE', 'DELIVERY');

-- CreateTable
CREATE TABLE "ai_credentials" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "key_enc" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "key_last4" TEXT NOT NULL,
    "last_test_at" TIMESTAMP(3),
    "last_test_ok" BOOLEAN,
    "last_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_personas" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_template" BOOLEAN NOT NULL DEFAULT false,
    "age" INTEGER,
    "identity" TEXT,
    "biography" TEXT,
    "backstory" TEXT,
    "personality" TEXT,
    "traits" TEXT,
    "tone_of_voice" TEXT,
    "communication_style" TEXT,
    "formality" TEXT NOT NULL DEFAULT 'neutral',
    "emoji_usage" TEXT NOT NULL DEFAULT 'low',
    "response_length" TEXT NOT NULL DEFAULT 'short',
    "conversation_start" TEXT,
    "expressions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "instructions" TEXT,
    "rules" TEXT,
    "allowed_topics" TEXT,
    "restricted_topics" TEXT,
    "opening_messages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_personas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_persona_revisions" (
    "id" UUID NOT NULL,
    "persona_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "changed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_persona_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agents" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "persona_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION,
    "max_tokens" INTEGER NOT NULL DEFAULT 400,
    "instructions" TEXT,
    "memory_enabled" BOOLEAN NOT NULL DEFAULT true,
    "mode" "AiAgentMode" NOT NULL DEFAULT 'REVIEW',
    "status" "AiAgentStatus" NOT NULL DEFAULT 'DRAFT',
    "published_version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_versions" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_accounts" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_test_sessions" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_test_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_test_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "debug" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_test_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_token_usage" (
    "id" UUID NOT NULL,
    "agent_id" UUID,
    "account_id" UUID,
    "context" "AiUsageContext" NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(14,8),
    "cost_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_events" (
    "id" UUID NOT NULL,
    "agent_id" UUID,
    "category" "AiEventCategory" NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_credentials_provider_key" ON "ai_credentials"("provider");

-- CreateIndex
CREATE INDEX "ai_personas_is_template_name_idx" ON "ai_personas"("is_template", "name");

-- CreateIndex
CREATE INDEX "ai_persona_revisions_persona_id_created_at_idx" ON "ai_persona_revisions"("persona_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agents_published_version_id_key" ON "ai_agents"("published_version_id");

-- CreateIndex
CREATE INDEX "ai_agents_status_idx" ON "ai_agents"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_versions_agent_id_number_key" ON "ai_agent_versions"("agent_id", "number");

-- CreateIndex
CREATE INDEX "ai_agent_accounts_account_id_idx" ON "ai_agent_accounts"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_accounts_agent_id_account_id_key" ON "ai_agent_accounts"("agent_id", "account_id");

-- CreateIndex
CREATE INDEX "ai_test_sessions_agent_id_created_at_idx" ON "ai_test_sessions"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_test_messages_session_id_created_at_idx" ON "ai_test_messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_token_usage_agent_id_created_at_idx" ON "ai_token_usage"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_token_usage_created_at_idx" ON "ai_token_usage"("created_at");

-- CreateIndex
CREATE INDEX "ai_agent_events_agent_id_created_at_idx" ON "ai_agent_events"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_agent_events_category_created_at_idx" ON "ai_agent_events"("category", "created_at");

-- AddForeignKey
ALTER TABLE "ai_persona_revisions" ADD CONSTRAINT "ai_persona_revisions_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "ai_personas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "ai_personas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Agente e versões se referenciam (versão publicada). A checagem fica para o fim da transação
-- para que backup e restauração consigam carregar as duas tabelas em qualquer ordem.
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "ai_agent_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "ai_agent_versions" ADD CONSTRAINT "ai_agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_accounts" ADD CONSTRAINT "ai_agent_accounts_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_accounts" ADD CONSTRAINT "ai_agent_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_test_sessions" ADD CONSTRAINT "ai_test_sessions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_test_messages" ADD CONSTRAINT "ai_test_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_test_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_token_usage" ADD CONSTRAINT "ai_token_usage_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_events" ADD CONSTRAINT "ai_agent_events_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

