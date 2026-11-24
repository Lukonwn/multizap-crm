-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "phone_e164" TEXT,
ADD COLUMN     "photo_checked_at" TIMESTAMP(3),
ADD COLUMN     "photo_key" TEXT;

-- CreateTable
CREATE TABLE "wa_identities" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "jid" TEXT NOT NULL,
    "lid" TEXT,
    "phone_e164" TEXT,
    "saved_name" TEXT,
    "push_name" TEXT,
    "verified_name" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wa_identities_account_id_lid_idx" ON "wa_identities"("account_id", "lid");

-- CreateIndex
CREATE INDEX "wa_identities_account_id_phone_e164_idx" ON "wa_identities"("account_id", "phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "wa_identities_account_id_jid_key" ON "wa_identities"("account_id", "jid");

-- AddForeignKey
ALTER TABLE "wa_identities" ADD CONSTRAINT "wa_identities_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

