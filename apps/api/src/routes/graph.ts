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
      const startIds = await resolveStartIds(symbol, repo);
      if (startIds.length === 0) return reply.status(404).send({ error: `No symbol matching "${symbol}"` });

      // direction out = follow fromId→toId (callees); in = toId→fromId (callers)
      const [fromCol, toCol] = direction === 'in' ? ['toId', 'fromId'] : ['fromId', 'toId'];
      const rows = await traverse(startIds, clampDepth(depth), ['calls', 'contains'], fromCol, toCol);
      return reply.send({ symbol, direction, count: rows.length, nodes: rows });
    },
  );

  // Transitive dependents crossing services: reverse-walk over calls + contains + http_calls.
  app.get<{ Querystring: { symbol: string; repo?: string; depth?: string } }>('/graph/impact', async (req, reply) => {
    const { symbol, repo, depth } = req.query;
    if (!symbol) return reply.status(400).send({ error: 'symbol is required' });
    const startIds = await resolveStartIds(symbol, repo);
    if (startIds.length === 0) return reply.status(404).send({ error: `No symbol matching "${symbol}"` });

    // reverse reachability: who points AT the target, all edge kinds, across repos
    const rows = await traverse(startIds, clampDepth(depth), ['calls', 'contains', 'http_calls'], 'toId', 'fromId');
    const services = [...new Set(rows.map((r) => r.repoName))];
    return reply.send({ symbol, services, count: rows.length, dependents: rows });
  });
}

/** Resolve a symbol argument (exact node id, or a name optionally scoped to a repo) to start-node ids. */
async function resolveStartIds(symbol: string, repo?: string): Promise<string[]> {
  const byId = await prisma.symbolNode.findUnique({ where: { id: symbol }, select: { id: true } });
  if (byId) return [byId.id];
  const repoId = repo ? (await prisma.repository.findUnique({ where: { name: repo } }))?.id : undefined;
  if (repo && !repoId) return [];
  const nodes = await prisma.symbolNode.findMany({
    where: { name: symbol, ...(repoId ? { repoId } : {}) },
    select: { id: true },
    take: 25,
  });
  return nodes.map((n) => n.id);
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
