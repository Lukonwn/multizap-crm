-- CreateEnum
CREATE TYPE "AiDeliverableKind" AS ENUM ('FILE', 'TEXT', 'LINK');

-- CreateEnum
CREATE TYPE "AiApprovalMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "AiDeliveryStatus" AS ENUM ('AWAITING_PAYMENT', 'AWAITING_APPROVAL', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'BLOCKED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AiPaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELED');

-- AlterTable
ALTER TABLE "ai_drafts" ADD COLUMN     "deliverable_id" UUID;

-- CreateTable
CREATE TABLE "ai_deliverables" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "AiDeliverableKind" NOT NULL,
    "asset_id" UUID,
    "text" TEXT,
    "adult_only" BOOLEAN NOT NULL DEFAULT false,
    "approval" "AiApprovalMode" NOT NULL DEFAULT 'MANUAL',
    "requires_payment" BOOLEAN NOT NULL DEFAULT false,
    "price_cents" INTEGER,
    "payment_instructions" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_deliverables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_deliverables" (
    "agent_id" UUID NOT NULL,
    "deliverable_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_deliverables_pkey" PRIMARY KEY ("agent_id","deliverable_id")
);

-- CreateTable
CREATE TABLE "ai_deliveries" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "deliverable_id" UUID,
    "item_name" TEXT NOT NULL,
    "item_code" TEXT NOT NULL,
    "agent_id" UUID,
    "inbound_message_id" UUID,
    "status" "AiDeliveryStatus" NOT NULL,
    "reason" TEXT,
    "message_id" UUID,
    "decided_by" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_payments" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "status" "AiPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "claimed_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" TEXT,
    "external_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_deliverables_code_key" ON "ai_deliverables"("code");

-- CreateIndex
CREATE INDEX "ai_agent_deliverables_deliverable_id_idx" ON "ai_agent_deliverables"("deliverable_id");

-- CreateIndex
CREATE INDEX "ai_deliveries_conversation_id_created_at_idx" ON "ai_deliveries"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_deliveries_status_idx" ON "ai_deliveries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_deliveries_inbound_message_id_deliverable_id_key" ON "ai_deliveries"("inbound_message_id", "deliverable_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_payments_delivery_id_key" ON "ai_payments"("delivery_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_payments_reference_key" ON "ai_payments"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "ai_payments_external_id_key" ON "ai_payments"("external_id");

-- AddForeignKey
ALTER TABLE "ai_deliverables" ADD CONSTRAINT "ai_deliverables_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_deliverables" ADD CONSTRAINT "ai_agent_deliverables_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_deliverables" ADD CONSTRAINT "ai_agent_deliverables_deliverable_id_fkey" FOREIGN KEY ("deliverable_id") REFERENCES "ai_deliverables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_deliveries" ADD CONSTRAINT "ai_deliveries_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_deliveries" ADD CONSTRAINT "ai_deliveries_deliverable_id_fkey" FOREIGN KEY ("deliverable_id") REFERENCES "ai_deliverables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_payments" ADD CONSTRAINT "ai_payments_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "ai_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

