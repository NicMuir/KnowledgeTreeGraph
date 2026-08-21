import { prisma } from '@kb/db';
import { vectorSearch } from './vector';
import { ftsSearch } from './fts';
import type { SearchOptions, SearchResult } from './types';

// Reciprocal Rank Fusion — standard reranking for hybrid search.
// k=60 is the textbook default for large-corpus search (thousands of candidates), where a
// rank difference of a few positions should barely move the score. Here we only ever fuse
// ~fetchLimit (30-90) candidates, so k=60 dwarfs every rank gap and collapses all scores into
// a narrow, unreadable band (~0.016-0.03 regardless of how relevant a hit actually is). Scale
// k down to the funnel width so rank differences that matter at this size actually show up.
const RRF_K = 10;
function rrfScore(rank: number, k = RRF_K): number {
  return 1 / (k + rank);
}
// Best possible fused score (rank 0 in both the vector and FTS lists) — used to normalize
// the final score onto a fixed, human-readable 0..1 scale instead of raw RRF's tiny fractions.
const MAX_RRF_SCORE = 2 / RRF_K;

// Implementations should generally outrank their own tests for equally relevant matches: test
// files (describe/it blocks) tend to repeat the feature name several times, which inflates
// their full-text-search rank above the single mention in the implementation. Penalize test
// chunks rather than excluding them, so they still surface when nothing else is relevant.
const TEST_CHUNK_PENALTY = 0.85;

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
    .map(({ result, score }) => ({
      result,
      score: (result.chunkType === 'test' ? score * TEST_CHUNK_PENALTY : score) / MAX_RRF_SCORE,
    }))
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
