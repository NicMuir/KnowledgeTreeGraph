-- Change embedding dimension from 1536 (OpenAI) to 768 (nomic-embed-text / Ollama).
-- Must drop and recreate the HNSW index — Postgres can't ALTER an indexed column in place.

DROP INDEX IF EXISTS "chunks_embedding_hnsw_idx";

ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(768);

CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks"
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
