-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "symbol_nodes" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,

    CONSTRAINT "symbol_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "symbol_edges" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "symbol_edges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "symbol_nodes_repoId_filePath_idx" ON "symbol_nodes"("repoId", "filePath");

-- CreateIndex
CREATE INDEX "symbol_nodes_repoId_name_idx" ON "symbol_nodes"("repoId", "name");

-- CreateIndex
CREATE INDEX "symbol_edges_repoId_idx" ON "symbol_edges"("repoId");

-- CreateIndex
CREATE INDEX "symbol_edges_toId_idx" ON "symbol_edges"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "symbol_edges_fromId_toId_kind_key" ON "symbol_edges"("fromId", "toId", "kind");

-- AddForeignKey
ALTER TABLE "symbol_nodes" ADD CONSTRAINT "symbol_nodes_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "symbol_edges" ADD CONSTRAINT "symbol_edges_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

