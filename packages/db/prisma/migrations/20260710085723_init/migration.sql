/*
  Warnings:

  - You are about to drop the column `embedding` on the `chunks` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "chunks_embedding_hnsw_idx";

-- AlterTable
ALTER TABLE "chunks" DROP COLUMN "embedding";
