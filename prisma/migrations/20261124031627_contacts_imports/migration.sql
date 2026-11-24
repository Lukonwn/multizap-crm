-- AlterEnum
ALTER TYPE "ImportStatus" ADD VALUE 'ANALYZING';

-- AlterTable
ALTER TABLE "import_rows" ADD COLUMN     "existing_contact_id" UUID,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "imports" ADD COLUMN     "existing_rows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "opted_out_rows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processed_rows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "skipped_rows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updated_rows" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "contacts_account_id_name_idx" ON "contacts"("account_id", "name");
