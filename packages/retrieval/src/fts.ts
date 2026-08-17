import { prisma } from '@kb/db';
import type { SearchResult } from '@kb/shared';

interface FtsRow {
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
  fts_rank: number;
}

export async function ftsSearch(
  query: string,
  repoIds: string[],
  limit: number,
): Promise<Array<SearchResult & { rank: number }>> {
  // Basic sanitization — strip chars that break plainto_tsquery
  const safeQuery = query.replace(/['"\\;]/g, ' ').trim();
  if (!safeQuery) return [];

  const repoFilter = repoIds.length > 0
    ? `AND c."repoId" = ANY(ARRAY[${repoIds.map((id) => `'${id}'`).join(',')}]::text[])`
    : '';

  const rows = await prisma.$queryRawUnsafe<FtsRow[]>(`
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
      ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $1)) AS fts_rank
    FROM chunks c
    JOIN repositories r ON r.id = c."repoId"
    WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', $1)
    ${repoFilter}
    ORDER BY fts_rank DESC
    LIMIT ${limit}
  `, safeQuery);

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
    score: Number(row.fts_rank),
    rank: i + 1,
  }));
}
