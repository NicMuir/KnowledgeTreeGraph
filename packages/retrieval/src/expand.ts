import { prisma } from '@kb/db';
import type { SearchResult } from './types';

/**
 * Supplements search hits with structurally related code from the symbol tree:
 * for each top hit, pulls the route it belongs to, its parent class, its
 * callees, and direct callers — code the LLM will likely need alongside the hit.
 *
 * Expanded chunks are appended after the originals with `expandedFrom` set,
 * scored below the weakest original so ranking is preserved.
 */
export async function expandResults(
  results: SearchResult[],
  opts: { seedCount?: number; maxExtra?: number } = {},
): Promise<SearchResult[]> {
  const { seedCount = 5, maxExtra = 6 } = opts;
  if (results.length === 0) return results;

  const seeds = results.slice(0, seedCount);

  // Map seed chunks -> symbol nodes by file + line overlap
  const symbols = await prisma.symbolNode.findMany({
    where: {
      OR: seeds.map((s) => ({
        repoId: s.repoId,
        filePath: s.filePath,
        startLine: { lte: s.endLine },
        endLine: { gte: s.startLine },
      })),
    },
  });
  if (symbols.length === 0) return results;

  const symbolIds = symbols.map((s) => s.id);
  const symbolIdToSeed = new Map<string, SearchResult>();
  for (const sym of symbols) {
    const seed = seeds.find(
      (s) =>
        s.repoId === sym.repoId &&
        s.filePath === sym.filePath &&
        sym.startLine <= s.endLine &&
        sym.endLine >= s.startLine,
    );
    if (seed) symbolIdToSeed.set(sym.id, seed);
  }

  // 1-hop neighbors, both directions: callees/children (out) + route/class/callers (in)
  const edges = await prisma.symbolEdge.findMany({
    where: { OR: [{ fromId: { in: symbolIds } }, { toId: { in: symbolIds } }] },
  });

  const known = new Set(symbolIds);
  // neighborId -> { seed, priority } — containers (route/class) beat callees beat callers
  const neighbors = new Map<string, { seed: SearchResult; priority: number }>();
  const consider = (id: string, seedSymbolId: string, priority: number) => {
    if (known.has(id)) return;
    const seed = symbolIdToSeed.get(seedSymbolId);
    if (!seed) return;
    const existing = neighbors.get(id);
    if (!existing || priority < existing.priority) neighbors.set(id, { seed, priority });
  };

  for (const e of edges) {
    if (known.has(e.fromId) && !known.has(e.toId)) {
      consider(e.toId, e.fromId, e.kind === 'contains' ? 1 : 2); // children / callees
    }
    if (known.has(e.toId) && !known.has(e.fromId)) {
      consider(e.fromId, e.toId, e.kind === 'contains' ? 0 : 3); // route/class container / callers
    }
  }
  if (neighbors.size === 0) return results;

  const picked = Array.from(neighbors.entries())
    .sort((a, b) => a[1].priority - b[1].priority)
    .slice(0, maxExtra);

  const neighborNodes = await prisma.symbolNode.findMany({
    where: { id: { in: picked.map(([id]) => id) } },
  });

  // Fetch the chunk covering each neighbor symbol
  const seenChunks = new Set(results.map((r) => r.chunkId));
  const floorScore = Math.min(...results.map((r) => r.score));
  const extra: SearchResult[] = [];

  for (const node of neighborNodes) {
    const info = neighbors.get(node.id);
    if (!info) continue;
    const chunk = await prisma.chunk.findFirst({
      where: {
        repoId: node.repoId,
        filePath: node.filePath,
        startLine: { lte: node.endLine },
        endLine: { gte: node.startLine },
      },
      orderBy: { startLine: 'desc' }, // innermost covering chunk first
      include: { repo: { select: { name: true } } },
    });
    if (!chunk || seenChunks.has(chunk.id)) continue;
    seenChunks.add(chunk.id);
    extra.push({
      chunkId: chunk.id,
      repoId: chunk.repoId,
      repoName: chunk.repo.name,
      filePath: chunk.filePath,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      chunkType: chunk.chunkType as SearchResult['chunkType'],
      commitSha: chunk.commitSha,
      indexedAt: chunk.indexedAt.toISOString(),
      metadata: (chunk.metadata ?? {}) as SearchResult['metadata'],
      score: floorScore * 0.5,
      expandedFrom: info.seed.chunkId,
    });
  }

  return [...results, ...extra];
}
