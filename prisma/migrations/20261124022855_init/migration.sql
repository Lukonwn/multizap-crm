-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('NOT_CONFIGURED', 'AWAITING_CONNECTION', 'CONNECTED', 'DISCONNECTED', 'ATTENTION', 'NEEDS_REPAIR', 'DISABLED');

-- CreateEnum
CREATE TYPE "ConnectionType" AS ENUM ('WHATSAPP_WEB', 'EXTERNAL_DEVICE');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('PENDING', 'GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ContactOrigin" AS ENUM ('MANUAL', 'IMPORT', 'INBOUND', 'OTHER');

-- CreateEnum
CREATE TYPE "ConsentAction" AS ENUM ('GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'ANALYZED', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('VALID', 'DUPLICATE', 'INVALID', 'OPTED_OUT', 'IMPORTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'BANNER', 'TEXT', 'LINK', 'TEMPLATE', 'FILE');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'PENDING', 'ANSWERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('CONNECTION', 'PROCESSING', 'IMPORT', 'STORAGE', 'INTEGRATION', 'BACKUP', 'SECURITY', 'SYSTEM');

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "password_changed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token_hash" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone_e164" TEXT,
    "connection_type" "ConnectionType" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "status_reason" TEXT,
    "last_activity_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "credentials_enc" BYTEA,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "wa_jid" TEXT,
    "device_name" TEXT,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "paired_at" TIMESTAMP(3),
    "last_check_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_keys" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "value_enc" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_events" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT,
    "phone_e164" TEXT NOT NULL,
    "origin" "ContactOrigin" NOT NULL DEFAULT 'MANUAL',
    "origin_detail" TEXT,
    "consent_status" "ConsentStatus" NOT NULL DEFAULT 'PENDING',
    "consent_at" TIMESTAMP(3),
    "opted_out_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#10b981',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tags" (
    "contact_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("contact_id","tag_id")
);

-- CreateTable
CREATE TABLE "consent_events" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "action" "ConsentAction" NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opt_outs" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opt_outs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imports" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "file_size" BIGINT NOT NULL,
    "format" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "columns" JSONB NOT NULL DEFAULT '[]',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '{}',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_rows" INTEGER NOT NULL DEFAULT 0,
    "rejected_file_key" TEXT,
    "error" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "name" TEXT,
    "phone_e164" TEXT,
    "status" "ImportRowStatus" NOT NULL,
    "reason" TEXT,
    "contact_id" UUID,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_jobs" (
    "id" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "params" JSONB NOT NULL DEFAULT '{}',
    "input_keys" JSONB NOT NULL DEFAULT '[]',
    "output_keys" JSONB NOT NULL DEFAULT '[]',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_folders" (
    "id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "folder_id" UUID,
    "kind" "AssetKind" NOT NULL,
    "name" TEXT NOT NULL,
    "storage_key" TEXT,
    "mime_type" TEXT,
    "size_bytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT,
    "text_content" TEXT,
    "url" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_usages" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "body" TEXT,
    "link_url" TEXT,
    "asset_id" UUID,
    "audience" JSONB NOT NULL DEFAULT '{}',
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_accounts" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "body" TEXT,
    "link_url" TEXT,
    "asset_id" UUID,
    "audience" JSONB NOT NULL DEFAULT '{}',
    "scheduled_at" TIMESTAMP(3),
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" UUID NOT NULL,
    "campaign_account_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "status" "RecipientStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "contact_id" UUID,
    "remote_jid" TEXT NOT NULL,
    "title" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3),
    "last_message_preview" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "body" TEXT,
    "media_key" TEXT,
    "status" "MessageStatus" NOT NULL,
    "campaign_recipient_id" UUID,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_events" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_metrics" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "campaign_account_id" UUID NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "read" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "replied" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_metrics" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "account_id" UUID NOT NULL,
    "contacts_created" INTEGER NOT NULL DEFAULT 0,
    "consents_granted" INTEGER NOT NULL DEFAULT 0,
    "opt_outs" INTEGER NOT NULL DEFAULT 0,
    "campaigns_created" INTEGER NOT NULL DEFAULT 0,
    "campaigns_completed" INTEGER NOT NULL DEFAULT 0,
    "messages_sent" INTEGER NOT NULL DEFAULT 0,
    "messages_delivered" INTEGER NOT NULL DEFAULT 0,
    "messages_read" INTEGER NOT NULL DEFAULT 0,
    "messages_failed" INTEGER NOT NULL DEFAULT 0,
    "messages_received" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "account_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_notifications" (
    "id" UUID NOT NULL,
    "severity" "NotificationSeverity" NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "account_id" UUID,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_events" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "backups" (
    "id" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" TEXT NOT NULL,
    "db_key" TEXT,
    "files_key" TEXT,
    "size_bytes" BIGINT,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_token_hash_key" ON "admin_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "admin_sessions_user_id_idx" ON "admin_sessions"("user_id");

-- CreateIndex
CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "accounts_status_idx" ON "accounts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_account_id_key" ON "integrations"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_keys_account_id_type_key_id_key" ON "integration_keys"("account_id", "type", "key_id");

-- CreateIndex
CREATE INDEX "connection_events_account_id_created_at_idx" ON "connection_events"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "contacts_account_id_consent_status_idx" ON "contacts"("account_id", "consent_status");

-- CreateIndex
CREATE INDEX "contacts_account_id_created_at_idx" ON "contacts"("account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_account_id_phone_e164_key" ON "contacts"("account_id", "phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "tags_account_id_name_key" ON "tags"("account_id", "name");

-- CreateIndex
CREATE INDEX "contact_tags_tag_id_idx" ON "contact_tags"("tag_id");

-- CreateIndex
CREATE INDEX "consent_events_account_id_created_at_idx" ON "consent_events"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "consent_events_contact_id_idx" ON "consent_events"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "opt_outs_account_id_phone_e164_key" ON "opt_outs"("account_id", "phone_e164");

-- CreateIndex
CREATE INDEX "imports_account_id_created_at_idx" ON "imports"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "imports_account_id_file_hash_idx" ON "imports"("account_id", "file_hash");

-- CreateIndex
CREATE INDEX "import_rows_import_id_status_idx" ON "import_rows"("import_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_import_id_row_number_key" ON "import_rows"("import_id", "row_number");

-- CreateIndex
CREATE INDEX "file_jobs_created_at_idx" ON "file_jobs"("created_at");

-- CreateIndex
CREATE INDEX "asset_folders_parent_id_idx" ON "asset_folders"("parent_id");

-- CreateIndex
CREATE INDEX "assets_folder_id_idx" ON "assets"("folder_id");

-- CreateIndex
CREATE INDEX "assets_kind_idx" ON "assets"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "asset_usages_asset_id_campaign_id_key" ON "asset_usages"("asset_id", "campaign_id");

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE INDEX "campaigns_scheduled_at_idx" ON "campaigns"("scheduled_at");

-- CreateIndex
CREATE INDEX "campaign_accounts_account_id_status_idx" ON "campaign_accounts"("account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_accounts_campaign_id_account_id_key" ON "campaign_accounts"("campaign_id", "account_id");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaign_account_id_status_idx" ON "campaign_recipients"("campaign_account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaign_account_id_contact_id_key" ON "campaign_recipients"("campaign_account_id", "contact_id");

-- CreateIndex
CREATE INDEX "conversations_account_id_last_message_at_idx" ON "conversations"("account_id", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_account_id_status_idx" ON "conversations"("account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_account_id_remote_jid_key" ON "conversations"("account_id", "remote_jid");

-- CreateIndex
CREATE UNIQUE INDEX "messages_campaign_recipient_id_key" ON "messages"("campaign_recipient_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_sent_at_idx" ON "messages"("conversation_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_account_id_provider_message_id_key" ON "messages"("account_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "message_events_account_id_occurred_at_idx" ON "message_events"("account_id", "occurred_at");

-- CreateIndex
CREATE INDEX "message_events_message_id_idx" ON "message_events"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_metrics_campaign_account_id_key" ON "campaign_metrics"("campaign_account_id");

-- CreateIndex
CREATE INDEX "campaign_metrics_campaign_id_idx" ON "campaign_metrics"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_metrics_date_account_id_key" ON "daily_metrics"("date", "account_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_account_id_created_at_idx" ON "audit_logs"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "system_notifications_read_at_created_at_idx" ON "system_notifications"("read_at", "created_at");

-- CreateIndex
CREATE INDEX "system_notifications_dedupe_key_idx" ON "system_notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "system_events_created_at_idx" ON "system_events"("created_at");

-- CreateIndex
CREATE INDEX "system_events_source_level_idx" ON "system_events"("source", "level");

-- CreateIndex
CREATE INDEX "backups_created_at_idx" ON "backups"("created_at");

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_keys" ADD CONSTRAINT "integration_keys_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_events" ADD CONSTRAINT "connection_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opt_outs" ADD CONSTRAINT "opt_outs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_folders" ADD CONSTRAINT "asset_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "asset_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "asset_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_usages" ADD CONSTRAINT "asset_usages_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_usages" ADD CONSTRAINT "asset_usages_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_accounts" ADD CONSTRAINT "campaign_accounts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_accounts" ADD CONSTRAINT "campaign_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_accounts" ADD CONSTRAINT "campaign_accounts_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_account_id_fkey" FOREIGN KEY ("campaign_account_id") REFERENCES "campaign_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_recipient_id_fkey" FOREIGN KEY ("campaign_recipient_id") REFERENCES "campaign_recipients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_metrics" ADD CONSTRAINT "campaign_metrics_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_metrics" ADD CONSTRAINT "campaign_metrics_campaign_account_id_fkey" FOREIGN KEY ("campaign_account_id") REFERENCES "campaign_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_notifications" ADD CONSTRAINT "system_notifications_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
