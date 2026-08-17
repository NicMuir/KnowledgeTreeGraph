import { prisma } from '@kb/db';

// ---------------------------------------------------------------------------
// Cross-service linking: match http_call nodes (outbound requests) to route
// nodes that serve them, across repositories. Produces http_calls edges — the
// dependency that no single-repo code graph can represent.
//
// A call matches a route when: same HTTP method, same segment count, and every
// segment pairs up — either equal static text, or one side is a path parameter
// (a wildcard). GET /bookings/active matches GET /bookings/:id; GET /a/{}/c
// matches GET /a/b/c. Cross-service only: the route must live in another repo.
// ---------------------------------------------------------------------------

export type MatchQuality = 'exact' | 'param';

/** A route/http_call node name is "METHOD /a/b/c". */
export function parseNodeName(name: string): { method: string; segs: string[] } | null {
  const sp = name.indexOf(' ');
  if (sp === -1) return null;
  const method = name.slice(0, sp).toUpperCase();
  const path = name.slice(sp + 1);
  if (!path.startsWith('/')) return null;
  const segs = path.split('/').filter((s) => s.length > 0); // '/' → []
  return { method, segs };
}

/** A path parameter / interpolation placeholder: :id, {id}, {}, <id>, $id, * */
export function isDynamic(seg: string): boolean {
  return /^[:{<$*]/.test(seg) || seg === '{}';
}

/** null = no match; 'exact' = all static equal; 'param' = matched using ≥1 wildcard. */
export function matchQuality(callSegs: string[], routeSegs: string[]): MatchQuality | null {
  if (callSegs.length !== routeSegs.length) return null;
  let usedWildcard = false;
  for (let i = 0; i < callSegs.length; i++) {
    const c = callSegs[i];
    const r = routeSegs[i];
    const cDyn = isDynamic(c);
    const rDyn = isDynamic(r);
    if (cDyn || rDyn) { usedWildcard = true; continue; }
    if (c.toLowerCase() !== r.toLowerCase()) return null;
  }
  return usedWildcard ? 'param' : 'exact';
}

/** Count segments where both sides are static and equal — stronger anchoring than wildcard binding. */
export function staticOverlap(callSegs: string[], routeSegs: string[]): number {
  let n = 0;
  for (let i = 0; i < callSegs.length; i++) {
    if (!isDynamic(callSegs[i]) && !isDynamic(routeSegs[i]) && callSegs[i].toLowerCase() === routeSegs[i].toLowerCase()) n++;
  }
  return n;
}

const CONFIDENCE: Record<MatchQuality, number> = { exact: 0.95, param: 0.8 };
const AMBIGUOUS = 0.5; // a call matching routes in >1 other service — link all, lower confidence

interface GraphNode { id: string; repoId: string; name: string }

/**
 * (Re)build http_calls edges. With repoId, links just that repo's outbound calls
 * (run after indexing it); without, rebuilds every http_calls edge (`kb link`).
 */
export async function linkCrossService(opts: { repoId?: string } = {}): Promise<{ calls: number; edges: number }> {
  const routes = await prisma.symbolNode.findMany({
    where: { kind: 'route' },
    select: { id: true, repoId: true, name: true },
  });
  const calls: GraphNode[] = await prisma.symbolNode.findMany({
    where: { kind: 'http_call', ...(opts.repoId ? { repoId: opts.repoId } : {}) },
    select: { id: true, repoId: true, name: true },
  });

  // Bucket routes by (method, segment count) to avoid an all-pairs scan.
  const buckets = new Map<string, Array<GraphNode & { segs: string[] }>>();
  for (const r of routes) {
    const p = parseNodeName(r.name);
    if (!p) continue;
    const key = `${p.method}:${p.segs.length}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push({ ...r, segs: p.segs });
  }

  const edges: Array<{ repoId: string; fromId: string; toId: string; kind: string; confidence: number }> = [];
  for (const call of calls) {
    const p = parseNodeName(call.name);
    if (!p || p.segs.length === 0) continue; // '/' is too generic to be a meaningful dependency
    const candidates = (buckets.get(`${p.method}:${p.segs.length}`) ?? [])
      .filter((r) => r.repoId !== call.repoId); // cross-service only
    const hits = candidates
      .map((r) => ({ route: r, q: matchQuality(p.segs, r.segs)!, s: staticOverlap(p.segs, r.segs) }))
      .filter((h) => h.q !== null);
    if (hits.length === 0) continue;
    // Keep only the best-anchored matches — drops spurious param alignments like
    // /bookings/{}/locks matching /bookings/by_code/{code}.
    const maxStatic = Math.max(...hits.map((h) => h.s));
    const best = hits.filter((h) => h.s === maxStatic);
    const ambiguous = new Set(best.map((h) => h.route.repoId)).size > 1;
    for (const h of best) {
      edges.push({
        repoId: call.repoId,
        fromId: call.id,
        toId: h.route.id,
        kind: 'http_calls',
        confidence: ambiguous ? AMBIGUOUS : CONFIDENCE[h.q],
      });
    }
  }

  // Replace prior http_calls edges in scope, then insert fresh.
  await prisma.symbolEdge.deleteMany({
    where: { kind: 'http_calls', ...(opts.repoId ? { repoId: opts.repoId } : {}) },
  });
  if (edges.length > 0) {
    await prisma.symbolEdge.createMany({ data: edges, skipDuplicates: true });
  }
  return { calls: calls.length, edges: edges.length };
}
