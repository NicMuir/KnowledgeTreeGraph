import { prisma } from '@kb/db';
import { vectorSearch } from './vector';
import { ftsSearch } from './fts';
import type { SearchOptions, SearchResult } from './types';

// Reciprocal Rank Fusion — standard reranking for hybrid search
function rrfScore(rank: number, k = 60): number {
  return 1 / (k + rank);
}

export async function hybridSearch(
  queryEmbedding: number[],
  opts: SearchOptions,
): Promise<SearchResult[]> {
  const { query, repoNames = [], limit = 10 } = opts;
  const repoIds = await resolveRepoIds(repoNames);
  const fetchLimit = Math.max(limit * 3, 30);

  const [vectorResults, ftsResults] = await Promise.all([
    vectorSearch(queryEmbedding, repoIds, fetchLimit),
    ftsSearch(query, repoIds, fetchLimit),
  ]);

  // Merge with RRF
  const scoreMap = new Map<string, { result: SearchResult; score: number }>();

  for (const r of vectorResults) {
    scoreMap.set(r.chunkId, { result: r, score: rrfScore(r.rank) });
  }
  for (const r of ftsResults) {
    const existing = scoreMap.get(r.chunkId);
    if (existing) {
      existing.score += rrfScore(r.rank);
    } else {
      scoreMap.set(r.chunkId, { result: r, score: rrfScore(r.rank) });
    }
  }

  let results = Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));

  // Metadata filters
  if (opts.pathFilter) {
    const f = opts.pathFilter.toLowerCase();
    results = results.filter((r) => r.filePath.toLowerCase().includes(f));
  }
  if (opts.language) {
    results = results.filter((r) => r.metadata.language === opts.language);
  }
  if (opts.chunkType) {
    results = results.filter((r) => r.chunkType === opts.chunkType);
  }

  return results.slice(0, limit);
}

async function resolveRepoIds(repoNames: string[]): Promise<string[]> {
  if (repoNames.length === 0) return [];
  const repos = await prisma.repository.findMany({
    where: { name: { in: repoNames } },
    select: { id: true },
  });
  return repos.map((r) => r.id);
}
