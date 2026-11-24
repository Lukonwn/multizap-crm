-- CreateEnum
CREATE TYPE "AiDraftStatus" AS ENUM ('PENDING', 'SENT', 'DISCARDED', 'FAILED');

-- AlterTable
ALTER TABLE "ai_agents" ADD COLUMN     "max_replies_per_hour" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "min_interval_seconds" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "show_typing" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ai_token_usage" ADD COLUMN     "conversation_id" UUID,
ADD COLUMN     "purpose" TEXT;

-- CreateTable
CREATE TABLE "ai_conversation_states" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "paused_by" TEXT,
    "paused_reason" TEXT,
    "paused_at" TIMESTAMP(3),
    "enabled_override" BOOLEAN NOT NULL DEFAULT false,
    "last_reply_at" TIMESTAMP(3),
    "last_skip" TEXT,
    "last_skip_at" TIMESTAMP(3),
    "memory" TEXT,
    "memory_agent_id" UUID,
    "memory_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversation_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_drafts" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "version_id" UUID,
    "inbound_message_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "status" "AiDraftStatus" NOT NULL DEFAULT 'PENDING',
    "sent_body" TEXT,
    "message_id" UUID,
    "auto_sent" BOOLEAN NOT NULL DEFAULT false,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_message_links" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_message_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_conversation_states_conversation_id_key" ON "ai_conversation_states"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_drafts_inbound_message_id_key" ON "ai_drafts"("inbound_message_id");

-- CreateIndex
CREATE INDEX "ai_drafts_conversation_id_created_at_idx" ON "ai_drafts"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_drafts_agent_id_status_idx" ON "ai_drafts"("agent_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_message_links_message_id_key" ON "ai_message_links"("message_id");

-- CreateIndex
CREATE INDEX "ai_message_links_agent_id_created_at_idx" ON "ai_message_links"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_token_usage_account_id_created_at_idx" ON "ai_token_usage"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_conversation_states" ADD CONSTRAINT "ai_conversation_states_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_message_links" ADD CONSTRAINT "ai_message_links_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_message_links" ADD CONSTRAINT "ai_message_links_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

