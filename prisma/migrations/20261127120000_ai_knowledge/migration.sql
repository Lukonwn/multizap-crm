-- CreateEnum
CREATE TYPE "AiKnowledgeKind" AS ENUM ('TEXT', 'QA', 'FILE', 'LINK');

-- CreateEnum
CREATE TYPE "AiKnowledgeStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'ERROR');

-- AlterTable
ALTER TABLE "ai_drafts" ADD COLUMN     "sources" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "ai_knowledge_sources" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AiKnowledgeKind" NOT NULL,
    "status" "AiKnowledgeStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "content" TEXT,
    "question" TEXT,
    "storage_key" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "url" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_chunks" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_knowledge" (
    "agent_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_knowledge_pkey" PRIMARY KEY ("agent_id","source_id")
);

-- CreateIndex
CREATE INDEX "ai_knowledge_sources_status_idx" ON "ai_knowledge_sources"("status");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunks_source_id_position_idx" ON "ai_knowledge_chunks"("source_id", "position");

-- CreateIndex
CREATE INDEX "ai_agent_knowledge_source_id_idx" ON "ai_agent_knowledge"("source_id");

-- AddForeignKey
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ai_knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_knowledge" ADD CONSTRAINT "ai_agent_knowledge_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_knowledge" ADD CONSTRAINT "ai_agent_knowledge_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ai_knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Busca de texto (português) nos trechos. Índice por expressão: a consulta usa a mesma expressão.
-- Nenhuma coluna gerada, para que o backup (COPY) continue restaurando a tabela sem tratamento especial.
CREATE INDEX "ai_knowledge_chunks_fts_idx" ON "ai_knowledge_chunks"
  USING GIN (to_tsvector('portuguese', coalesce("title", '') || ' ' || "content"));
