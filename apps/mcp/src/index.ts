#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API = (process.env.KB_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// Every API call gets a deadline: a hung/restarting API must fail a tool call,
// never wedge the MCP process (a wedged stdio server blocks all later calls).
const TIMEOUT_MS = Number(process.env.KB_MCP_TIMEOUT_MS ?? 60_000);
function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

const server = new Server(
  { name: 'kb', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'kb_ask',
      description:
        'Ask a question about the indexed codebases. Returns an answer grounded in source code with file path citations and commit SHAs.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Your question about the codebase' },
          repos: {
            type: 'array',
            items: { type: 'string' },
            description: 'Limit search to these repo names (omit for all repos)',
          },
          path_filter: {
            type: 'string',
            description: 'Only search files whose path contains this string (e.g. "auth", "routes")',
          },
        },
        required: ['question'],
      },
    },
    {
      name: 'kb_search',
      description:
        'Search the knowledge base directly (no LLM). Returns ranked code/doc chunks with file paths and line numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          repo: { type: 'string', description: 'Filter to a specific repo name' },
          language: { type: 'string', description: 'Filter by language (typescript, python, go, etc.)' },
          chunk_type: {
            type: 'string',
            enum: ['function', 'class', 'markdown_section', 'text_block', 'config', 'migration', 'test'],
            description: 'Filter by chunk type',
          },
          limit: { type: 'number', description: 'Number of results (default 10, max 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'kb_list_repos',
      description: 'List all indexed repositories with file/chunk counts and last indexing status.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'kb_routes',
      description: 'List the HTTP routes a repo defines (method + path), optionally filtered. Use to find which service owns an endpoint.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo name to list routes for' },
          q: { type: 'string', description: 'Filter routes by method/path substring (e.g. "bookings")' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'kb_trace',
      description: 'Trace callers or callees of a symbol within its call graph. direction "out" = what it calls; "in" = what calls it. Returns nodes with file/line and depth.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol name (e.g. function/method/route name) or exact node id' },
          repo: { type: 'string', description: 'Scope resolution to this repo (recommended when a name repeats)' },
          direction: { type: 'string', enum: ['in', 'out'], description: 'in = callers, out = callees (default out)' },
          depth: { type: 'number', description: 'Max traversal depth 1-8 (default 4)' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'kb_impact',
      description: 'Cross-service impact analysis: what breaks if a symbol or route changes. Reverse-walks calls, containment, AND HTTP call→route edges across repositories. Use for "which services depend on this endpoint/function?".',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol or route name (e.g. "GET /api/bookings") or exact node id' },
          repo: { type: 'string', description: 'Repo that owns the symbol/route being changed' },
          depth: { type: 'number', description: 'Max traversal depth 1-8 (default 4)' },
        },
        required: ['symbol'],
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === 'kb_ask') {
    const { question, repos, path_filter } = args as {
      question: string;
      repos?: string[];
      path_filter?: string;
    };

    const res = await apiFetch(`${API}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, repoNames: repos ?? [], pathFilter: path_filter, maxResults: 8 }),
    });

    if (!res.ok) {
      return { content: [{ type: 'text', text: `KB API error ${res.status}: ${await res.text()}` }] };
    }

    const data = await res.json() as {
      answer: string;
      sources: Array<{ repoName: string; filePath: string; startLine: number; endLine: number; chunkType: string; commitSha: string; indexedAt: string }>;
      retrievedChunks: number;
      model: string;
    };

    const sourceList = data.sources
      .map((s, i) =>
        `[${i + 1}] ${s.repoName}/${s.filePath}:${s.startLine}-${s.endLine}  (${s.chunkType}, commit: ${s.commitSha}, indexed: ${new Date(s.indexedAt).toLocaleDateString()})`,
      )
      .join('\n');

    const text = [
      data.answer,
      '',
      `--- ${data.retrievedChunks} chunks via ${data.model} ---`,
      ...(sourceList ? ['', 'Sources:', sourceList] : []),
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  }

  if (name === 'kb_search') {
    const { query, repo, language, chunk_type, limit } = args as {
      query: string; repo?: string; language?: string; chunk_type?: string; limit?: number;
    };

    const params = new URLSearchParams({ q: query });
    if (repo) params.set('repo', repo);
    if (language) params.set('lang', language);
    if (chunk_type) params.set('type', chunk_type);
    if (limit) params.set('limit', String(Math.min(limit, 20)));

    const res = await apiFetch(`${API}/search?${params}`);
    if (!res.ok) {
      return { content: [{ type: 'text', text: `KB API error ${res.status}: ${await res.text()}` }] };
    }

    const data = await res.json() as {
      results: Array<{ repoName: string; filePath: string; startLine: number; endLine: number; chunkType: string; commitSha: string; content: string; score: number; metadata: { symbolName?: string; heading?: string } }>;
      total: number;
    };

    if (data.results.length === 0) {
      return { content: [{ type: 'text', text: 'No results found.' }] };
    }

    const text = data.results
      .map((r, i) => {
        const label = r.metadata.symbolName ?? r.metadata.heading ?? r.chunkType;
        const preview = r.content.slice(0, 300).replace(/\n/g, '\n    ');
        return `[${i + 1}] ${r.repoName}/${r.filePath}:${r.startLine}-${r.endLine}  ${label}  (score: ${r.score.toFixed(3)}, commit: ${r.commitSha})\n    ${preview}${r.content.length > 300 ? '\n    ...' : ''}`;
      })
      .join('\n\n');

    return { content: [{ type: 'text', text: `${data.total} results:\n\n${text}` }] };
  }

  if (name === 'kb_list_repos') {
    const res = await apiFetch(`${API}/repos`);
    if (!res.ok) {
      return { content: [{ type: 'text', text: `KB API error ${res.status}` }] };
    }

    const repos = await res.json() as Array<{
      name: string; branch: string; currentCommitSha: string | null;
      fileCount: number; chunkCount: number;
      lastRun: { status: string; filesIndexed: number; filesTotal: number; startedAt: string } | null;
    }>;

    if (repos.length === 0) {
      return { content: [{ type: 'text', text: 'No repos indexed yet.' }] };
    }

    const text = repos.map((r) => {
      const run = r.lastRun
        ? `${r.lastRun.status} (${r.lastRun.filesIndexed}/${r.lastRun.filesTotal} files, ${new Date(r.lastRun.startedAt).toLocaleDateString()})`
        : 'never indexed';
      const sha = r.currentCommitSha ? `@${r.currentCommitSha}` : '';
      return `• ${r.name}${sha}  [${r.branch}]  ${r.fileCount} files · ${r.chunkCount} chunks · ${run}`;
    }).join('\n');

    return { content: [{ type: 'text', text }] };
  }

  if (name === 'kb_routes') {
    const { repo, q } = args as { repo: string; q?: string };
    const params = new URLSearchParams({ repo });
    if (q) params.set('q', q);
    const res = await apiFetch(`${API}/graph/routes?${params}`);
    if (!res.ok) return { content: [{ type: 'text', text: `KB API error ${res.status}: ${await res.text()}` }] };
    const data = await res.json() as { total: number; routes: Array<{ name: string; filePath: string; startLine: number }> };
    if (data.routes.length === 0) return { content: [{ type: 'text', text: 'No routes found.' }] };
    const text = data.routes.map((r) => `${r.name}  (${r.filePath}:${r.startLine})`).join('\n');
    return { content: [{ type: 'text', text: `${data.total} routes:\n${text}` }] };
  }

  if (name === 'kb_trace') {
    const { symbol, repo, direction, depth } = args as { symbol: string; repo?: string; direction?: string; depth?: number };
    const params = new URLSearchParams({ symbol });
    if (repo) params.set('repo', repo);
    if (direction) params.set('direction', direction);
    if (depth) params.set('depth', String(depth));
    const res = await apiFetch(`${API}/graph/trace?${params}`);
    if (!res.ok) return { content: [{ type: 'text', text: `KB API error ${res.status}: ${await res.text()}` }] };
    const data = await res.json() as { direction: string; count: number; nodes: Array<{ name: string; kind: string; filePath: string; startLine: number; endLine: number; repoName: string; depth: number; via: string | null; confidence: number | null }> };
    if (data.count === 0) return { content: [{ type: 'text', text: `No ${data.direction === 'in' ? 'callers' : 'callees'} found.` }] };
    const text = data.nodes
      .map((n) => `${'  '.repeat(n.depth - 1)}[d${n.depth}] ${n.kind} ${n.name}  (${n.repoName}/${n.filePath}:${n.startLine}-${n.endLine}${n.confidence != null ? `, conf ${n.confidence}` : ''})`)
      .join('\n');
    return { content: [{ type: 'text', text: `${data.count} ${data.direction === 'in' ? 'callers' : 'callees'}:\n${text}` }] };
  }

  if (name === 'kb_impact') {
    const { symbol, repo, depth } = args as { symbol: string; repo?: string; depth?: number };
    const params = new URLSearchParams({ symbol });
    if (repo) params.set('repo', repo);
    if (depth) params.set('depth', String(depth));
    const res = await apiFetch(`${API}/graph/impact?${params}`);
    if (!res.ok) return { content: [{ type: 'text', text: `KB API error ${res.status}: ${await res.text()}` }] };
    const data = await res.json() as { services: string[]; count: number; dependents: Array<{ name: string; kind: string; filePath: string; startLine: number; endLine: number; repoName: string; depth: number; via: string | null; confidence: number | null }> };
    if (data.count === 0) return { content: [{ type: 'text', text: 'Nothing depends on this symbol (no dependents found).' }] };
    const text = data.dependents
      .map((n) => `${'  '.repeat(n.depth - 1)}[d${n.depth}] ${n.kind} ${n.name}  (${n.repoName}/${n.filePath}:${n.startLine}-${n.endLine}, via ${n.via}${n.confidence != null ? ` conf ${n.confidence}` : ''})`)
      .join('\n');
    return { content: [{ type: 'text', text: `Impacts ${data.count} nodes across services [${data.services.join(', ')}]:\n${text}` }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

// ── Start ─────────────────────────────────────────────────────────────────────
void (async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
