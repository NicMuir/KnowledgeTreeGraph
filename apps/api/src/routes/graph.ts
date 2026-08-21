import type { FastifyInstance } from 'fastify';
import { prisma } from '@kb/db';

// ---------------------------------------------------------------------------
// Structural graph queries over symbol_nodes / symbol_edges, for LLM agents.
//   /graph/routes  — list a repo's HTTP routes
//   /graph/trace   — callers (in) or callees (out) of a symbol, within its call graph
//   /graph/impact  — transitive dependents of a symbol/route, CROSSING services via
//                    http_calls edges ("what breaks if this endpoint changes?")
// ---------------------------------------------------------------------------

interface GraphRow {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  repoName: string;
  depth: number;
  via: string | null;
  confidence: number | null;
}

const clampDepth = (v: unknown, def = 4) => Math.min(Math.max(Number(v) || def, 1), 8);

export async function graphRoutes(app: FastifyInstance): Promise<void> {
  // List routes for a repo, optionally filtered by method/path substring.
  app.get<{ Querystring: { repo: string; q?: string; limit?: string } }>('/graph/routes', async (req, reply) => {
    const { repo, q, limit } = req.query;
    if (!repo) return reply.status(400).send({ error: 'repo is required' });
    const r = await prisma.repository.findUnique({ where: { name: repo } });
    if (!r) return reply.status(404).send({ error: 'Repo not found' });

    const routes = await prisma.symbolNode.findMany({
      where: {
        repoId: r.id,
        kind: 'route',
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      },
      select: { name: true, filePath: true, startLine: true },
      orderBy: { name: 'asc' },
      take: Math.min(Number(limit) || 200, 500),
    });
    return reply.send({ repo, total: routes.length, routes });
  });

  // Callers/callees of a symbol within the call graph (calls + contains edges).
  app.get<{ Querystring: { symbol: string; repo?: string; direction?: string; depth?: string } }>(
    '/graph/trace',
    async (req, reply) => {
      const { symbol, repo, direction = 'out', depth } = req.query;
      if (!symbol) return reply.status(400).send({ error: 'symbol is required' });
      const queriedIds = await resolveStartIds(symbol, repo);
      if (queriedIds.length === 0) return reply.status(404).send({ error: `No symbol matching "${symbol}"` });

      // direction out = follow fromId→toId (callees); in = toId→fromId (callers)
      const [fromCol, toCol] = direction === 'in' ? ['toId', 'fromId'] : ['fromId', 'toId'];
      // Nothing ever points a 'calls'/'contains' edge AT a class node itself (calls target
      // methods, contains is class→method) — walking "in" from a bare class id always finds
      // zero edges. Seed with the class's own methods too, so we still recurse into
      // method-level callers ("who calls this class").
      const startIds = direction === 'in' ? await expandClassSeeds(queriedIds) : queriedIds;
      let rows = await traverse(startIds, clampDepth(depth), ['calls', 'contains'], fromCol, toCol);
      // A class's own "contains" edge to its method can walk straight back to the class
      // itself — that's structural, not a caller, so drop the symbol(s) we started from.
      rows = rows.filter((r) => !queriedIds.includes(r.id));
      return reply.send({ symbol, direction, count: rows.length, nodes: rows });
    },
  );

  // Transitive dependents crossing services: reverse-walk over calls + contains + http_calls.
  app.get<{ Querystring: { symbol: string; repo?: string; depth?: string } }>('/graph/impact', async (req, reply) => {
    const { symbol, repo, depth } = req.query;
    if (!symbol) return reply.status(400).send({ error: 'symbol is required' });
    const queriedIds = await resolveStartIds(symbol, repo);
    if (queriedIds.length === 0) return reply.status(404).send({ error: `No symbol matching "${symbol}"` });

    // reverse reachability: who points AT the target, all edge kinds, across repos.
    // Same class-seed gap as /graph/trace direction=in (see there) — expand class ids to
    // their methods so a class's dependents (its methods' callers) are found.
    const startIds = await expandClassSeeds(queriedIds);
    let rows = await traverse(startIds, clampDepth(depth), ['calls', 'contains', 'http_calls'], 'toId', 'fromId');
    // Drop the class's own "contains" walk back to itself — not a real dependent.
    rows = rows.filter((r) => !queriedIds.includes(r.id));
    const services = [...new Set(rows.map((r) => r.repoName))];
    return reply.send({ symbol, services, count: rows.length, dependents: rows });
  });
}

/**
 * Resolve a symbol argument to start-node ids. Accepts:
 *  - an exact node id
 *  - a bare name ("calculate") — matches that name anywhere (optionally repo-scoped),
 *    which can span unrelated classes
 *  - a "Class::member" scoped name — resolves member(s) of the named class(es) only
 */
async function resolveStartIds(symbol: string, repo?: string): Promise<string[]> {
  const byId = await prisma.symbolNode.findUnique({ where: { id: symbol }, select: { id: true } });
  if (byId) return [byId.id];
  const repoId = repo ? (await prisma.repository.findUnique({ where: { name: repo } }))?.id : undefined;
  if (repo && !repoId) return [];

  const sepIndex = symbol.indexOf('::');
  if (sepIndex !== -1) {
    const className = symbol.slice(0, sepIndex);
    const memberName = symbol.slice(sepIndex + 2);
    const classes = await prisma.symbolNode.findMany({
      where: { name: className, kind: 'class', ...(repoId ? { repoId } : {}) },
      select: { id: true },
    });
    if (classes.length === 0) return [];
    const containsEdges = await prisma.symbolEdge.findMany({
      where: { kind: 'contains', fromId: { in: classes.map((c) => c.id) } },
      select: { toId: true },
    });
    const members = await prisma.symbolNode.findMany({
      where: { id: { in: containsEdges.map((e) => e.toId) }, name: memberName },
      select: { id: true },
      take: 25,
    });
    return members.map((m) => m.id);
  }

  const nodes = await prisma.symbolNode.findMany({
    where: { name: symbol, ...(repoId ? { repoId } : {}) },
    select: { id: true },
    take: 25,
  });
  return nodes.map((n) => n.id);
}

/** For any class-kind id in the set, also seed with its contained method/function ids. */
async function expandClassSeeds(startIds: string[]): Promise<string[]> {
  const classIds = (
    await prisma.symbolNode.findMany({
      where: { id: { in: startIds }, kind: 'class' },
      select: { id: true },
    })
  ).map((n) => n.id);
  if (classIds.length === 0) return startIds;
  const members = await prisma.symbolEdge.findMany({
    where: { kind: 'contains', fromId: { in: classIds } },
    select: { toId: true },
  });
  return [...new Set([...startIds, ...members.map((m) => m.toId)])];
}

/** Recursive CTE walk over symbol_edges. fromCol/toCol pick direction; kinds filters edge types. */
async function traverse(
  startIds: string[],
  depth: number,
  kinds: string[],
  fromCol: string,
  toCol: string,
): Promise<GraphRow[]> {
  // fromCol/toCol and kinds are code-controlled (not user input); ids/depth are parameterized.
  const kindList = kinds.map((k) => `'${k}'`).join(',');
  const sql = `
    WITH RECURSIVE walk AS (
      SELECT n.id, n.name, n.kind, n."filePath", n."startLine", n."endLine", n."repoId",
             0 AS depth, NULL::text AS via, NULL::double precision AS confidence
      FROM symbol_nodes n WHERE n.id = ANY($1)
      UNION
      SELECT n.id, n.name, n.kind, n."filePath", n."startLine", n."endLine", n."repoId",
             walk.depth + 1, e.kind, e.confidence
      FROM walk
      JOIN symbol_edges e ON e."${fromCol}" = walk.id AND e.kind IN (${kindList})
      JOIN symbol_nodes n ON n.id = e."${toCol}"
      WHERE walk.depth < $2
    )
    SELECT DISTINCT ON (w.id) w.id, w.name, w.kind, w."filePath", w."startLine", w."endLine",           r.name AS "repoName", w.depth, w.via, w.confidence
    FROM walk w JOIN repositories r ON r.id = w."repoId"
    WHERE w.depth > 0
    ORDER BY w.id, w.depth ASC
  `;
  const rows = await prisma.$queryRawUnsafe<GraphRow[]>(sql, startIds, depth);
  return rows.sort((a, b) => a.depth - b.depth);
}
