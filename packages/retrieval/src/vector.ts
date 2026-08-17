import { prisma } from '@kb/db';
import type { SearchResult } from '@kb/shared';

interface VectorRow {
  id: string;
  repo_id: string;
  repo_name: string;
  file_path: string;
  content: string;
  start_line: number;
  end_line: number;
  chunk_type: string;
  commit_sha: string;
  indexed_at: Date;
  metadata: unknown;
  distance: number;
}

export async function vectorSearch(
  embedding: number[],
  repoIds: string[],
  limit: number,
): Promise<Array<SearchResult & { rank: number }>> {
  const vec = `[${embedding.join(',')}]`;
  // ponytail: $queryRawUnsafe for vector literal — repoIds are DB-generated CUIDs (safe)
  const repoFilter = repoIds.length > 0
    ? `AND c."repoId" = ANY(ARRAY[${repoIds.map((id) => `'${id}'`).join(',')}]::text[])`
    : '';

  const rows = await prisma.$queryRawUnsafe<VectorRow[]>(`
    SELECT
      c.id,
      c."repoId"   AS repo_id,
      r.name       AS repo_name,
      c."filePath" AS file_path,
      c.content,
      c."startLine" AS start_line,
      c."endLine"   AS end_line,
      c."chunkType" AS chunk_type,
      c."commitSha" AS commit_sha,
      c."indexedAt" AS indexed_at,
      c.metadata,
      c.embedding <=> '${vec}'::vector AS distance
    FROM chunks c
    JOIN repositories r ON r.id = c."repoId"
    WHERE c.embedding IS NOT NULL
    ${repoFilter}
    ORDER BY distance ASC
    LIMIT ${limit}
  `);

  return rows.map((row, i) => ({
    chunkId: row.id,
    repoId: row.repo_id,
    repoName: row.repo_name,
    filePath: row.file_path,
    content: row.content,
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    chunkType: row.chunk_type as SearchResult['chunkType'],
    commitSha: row.commit_sha,
    indexedAt: row.indexed_at instanceof Date ? row.indexed_at.toISOString() : String(row.indexed_at),
    metadata: (row.metadata ?? {}) as SearchResult['metadata'],
    score: 1 - Math.min(1, Number(row.distance)),
    rank: i + 1,
  }));
}
