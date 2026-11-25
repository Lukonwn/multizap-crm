-- CreateEnum
CREATE TYPE "AiGenerationStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'ERROR');

-- AlterEnum
ALTER TYPE "AiUsageContext" ADD VALUE 'GENERATOR';

-- AlterTable
ALTER TABLE "ai_agents" ADD COLUMN     "age_gate" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ai_conversation_states" ADD COLUMN     "age_asked_at" TIMESTAMP(3),
ADD COLUMN     "age_confirmed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ai_generations" (
    "id" UUID NOT NULL,
    "status" "AiGenerationStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "model" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "links" JSONB NOT NULL DEFAULT '[]',
    "files" JSONB NOT NULL DEFAULT '[]',
    "target_agent_id" UUID,
    "result" JSONB,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(14,8),
    "cost_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_generations_created_at_idx" ON "ai_generations"("created_at");

