-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Repositories
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "currentCommitSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "repositories_name_key" ON "repositories"("name");

-- Indexed files
CREATE TABLE "indexed_files" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "language" TEXT,
    "fileHash" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "indexed_files_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "indexed_files_repoId_filePath_key" ON "indexed_files"("repoId", "filePath");
CREATE INDEX "indexed_files_repoId_idx" ON "indexed_files"("repoId");
CREATE INDEX "indexed_files_fileHash_idx" ON "indexed_files"("fileHash");
ALTER TABLE "indexed_files" ADD CONSTRAINT "indexed_files_repoId_fkey"
    FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Chunks (embedding column is vector(1536), not managed by Prisma schema)
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "chunkType" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chunks_repoId_idx" ON "chunks"("repoId");
CREATE INDEX "chunks_filePath_idx" ON "chunks"("filePath");
CREATE INDEX "chunks_chunkType_idx" ON "chunks"("chunkType");
-- HNSW index for fast approximate nearest-neighbour search
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks"
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
-- Full-text search index
CREATE INDEX "chunks_content_fts_idx" ON "chunks"
    USING GIN (to_tsvector('english', "content"));
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "indexed_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_repoId_fkey"
    FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexing runs
CREATE TABLE "indexing_runs" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "filesTotal" INTEGER NOT NULL DEFAULT 0,
    "filesIndexed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "indexing_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "indexing_runs_repoId_idx" ON "indexing_runs"("repoId");
ALTER TABLE "indexing_runs" ADD CONSTRAINT "indexing_runs_repoId_fkey"
    FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
