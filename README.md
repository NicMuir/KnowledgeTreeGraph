# KB — Engineering Knowledge Base

A production-minded multi-repository RAG system for engineering teams. Index multiple Git repos, then ask questions and get answers with citations back to specific files and line ranges — plus a cross-service code graph (call trees, HTTP dependencies, impact analysis) and LAN snapshot distribution so a team shares one index without everyone paying the embedding cost.

## Architecture

```
apps/
  api/        Fastify REST API (chat, index, search, repos, graph, snapshot, health)
  web/        Next.js frontend (chat UI, repo list, source citations)
  mcp/        MCP server exposing kb_search/kb_ask/kb_routes/kb_trace/kb_impact to AI agents

packages/
  shared/     Shared TypeScript types and constants
  db/         Prisma schema, migrations, DB client (PostgreSQL + pgvector)
  llm/        LLM/embedding provider abstraction (Ollama + OpenAI)
  ingestion/  File scanner, chunkers (markdown, code, generic), indexer,
              call-graph extraction (tree-sitter) + cross-service HTTP linking
  retrieval/  Hybrid search: vector (pgvector HNSW) + FTS (pg tsvector) + RRF reranking
```

## Quick Start

### 1. Install (macOS / Linux)

Prerequisites: Node.js 20+, pnpm 9+ (`corepack enable`), Docker.

```bash
git clone <this-repo> && cd KB
./install.sh              # checks prereqs, installs deps, builds, puts `kb` on your PATH
```

Then edit `.env` (created from `.env.example`): pick `LLM_PROVIDER` and its settings — on a team,
these must match the HEAD PC (see Team Setup below).

### 2. Database schema

Joining a team? Skip this — `kb sync` restores schema + data from the HEAD PC's snapshot.
Fresh standalone setup:

```bash
docker compose up -d
pnpm db:migrate           # fresh DB: cd packages/db && npx prisma migrate dev --name init
```

> **Note:** The migration in `packages/db/prisma/migrations/0001_init/migration.sql` is hand-crafted to include `CREATE EXTENSION IF NOT EXISTS vector` and the HNSW index. Prisma cannot auto-generate these.

### 3. Start and check

```bash
kb serve                  # Postgres + API (:3001) + interactive console
kb doctor                 # ✓/✗ for database, embedder, API
```

Web UI (optional): `cd apps/web && pnpm dev` → http://localhost:3000

### 4. Index and ask — the `kb` CLI

```bash
kb index /path/to/your/repo                    # name defaults to the folder name
kb index /path/to/repo --name my-repo --branch main --force
kb index-all /path/to/parent-dir --skip node_modules,dist   # every subdir becomes a repo

kb list                                         # indexed repos + status
kb search "how are refunds handled" --repo crs  # ranked chunks, no LLM
kb ask "How does authentication work?" --repo my-repo   # RAG answer with citations
kb tui                                           # interactive picker (clone missing repos)

kb routes crs --q bookings                      # HTTP routes a repo defines
kb trace "GET /api/bookings" --depth 3          # call tree: what a symbol calls (or --direction in)
kb impact "GET /api/bookings"                   # cross-service: what breaks if this changes
```

**`kb serve` — interactive console.** Starts Postgres + the API, then drops you into a `kb>` prompt
where you run the same commands in-place (the API keeps running in the background, logs to `.kb-api.log`):

```
$ kb serve
Starting API on :3001 (logs → .kb-api.log)… ready
KB console — type a command (doctor, list, ingest <path>, search "…", ask "…", logs, help, exit)
kb> doctor
kb> ingest /path/to/repo
kb> ask "how does auth work?"
kb> logs 40        # tail the API log
kb> exit           # stops the API and quits
```

Run `kb help` for the full list. All commands honour `.env` (`KB_API_URL`, `OLLAMA_BASE_URL`,
`DATABASE_URL`). `index`/`index-all` talk to the DB + embedder directly; `ask`/`search`/`list`
need the API running (`kb serve`).

<details>
<summary>Without installing — via pnpm or the web UI / API</summary>

```bash
pnpm kb index /path/to/repo          # same CLI, no global install
pnpm kb ask "How does auth work?"
```

**Web UI:** click "+ Add" in the sidebar, enter an absolute repo path; use the chat interface to ask.

**API:**
```bash
curl -X POST http://localhost:3001/index -H 'Content-Type: application/json' \
  -d '{"repoPath": "/path/to/repo", "repoName": "my-repo"}'
curl -X POST http://localhost:3001/chat -H 'Content-Type: application/json' \
  -d '{"question": "How does authentication work?", "repoNames": ["my-repo"], "maxResults": 8}'
```
Indexing runs in the background. Poll `/repos` for status.
</details>

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Ask a question, get answer + citations |
| `POST` | `/index` | Start indexing a repo (async) |
| `GET` | `/repos` | List all indexed repos with status |
| `GET` | `/repos/:name/runs` | Indexing run history for a repo |
| `GET` | `/search?q=` | Direct hybrid search (no LLM) |
| `GET` | `/graph/routes?repo=` | HTTP routes a repo defines |
| `GET` | `/graph/trace?symbol=` | Callers/callees of a symbol (call graph walk) |
| `GET` | `/graph/impact?symbol=` | Cross-service transitive dependents |
| `GET` | `/snapshot` | Stream the newest DB dump (team distribution) |
| `GET` | `/snapshot/info` | Dump metadata + embedding model/dims |
| `GET` | `/health` | Health check |

### POST /chat

```json
{
  "question": "string (required)",
  "repoNames": ["optional", "repo", "filter"],
  "pathFilter": "optional/path/prefix",
  "maxResults": 8
}
```

Response includes `answer`, `sources` (with citations), `retrievedChunks`, and `model`.

## Code Graph

Indexing also builds a structural graph in `symbol_nodes`/`symbol_edges`: routes, classes,
functions/methods, and outbound HTTP call-sites, connected by `contains`, `calls` (name-resolved,
confidence-scored), and `http_calls` edges that link a service's outbound requests to the route in
the *other* repo that serves them. `kb trace` walks call trees, `kb impact` answers "which services
break if this endpoint changes", and the MCP server (`apps/mcp`) exposes the same graph to AI
agents so they can collect only the functions a task needs instead of reading whole files.

## How Retrieval Works

1. **Embed** the question with the configured provider (Ollama or OpenAI)
2. **Vector search** — cosine similarity via pgvector HNSW index
3. **Full-text search** — `plainto_tsquery` with GIN index on chunk content
4. **RRF merge** — Reciprocal Rank Fusion combines both ranked lists
5. **Metadata filter** — by repo name, file path, language, chunk type
6. **LLM answer** — the configured chat model, with a prompt that requires citations and staleness warnings

## Incremental Indexing

Re-indexing a repo skips unchanged files (detected by SHA-256 content hash). Only new or modified files are re-chunked and re-embedded.

## Staleness & Citations

Every chunk stores the commit SHA and indexed timestamp. The chat prompt instructs the LLM to warn when context was indexed more than 48 hours ago and to include commit SHAs in citations so you can verify currency.

## Adding a New LLM Provider

Implement `EmbeddingProvider` and/or `ChatProvider` from `packages/llm/src/types.ts`, then update `createEmbeddingProvider()` / `createChatProvider()` in `packages/llm/src/index.ts` to switch based on an env var.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `LLM_PROVIDER` | `openai` | `ollama` or `openai` |
| `OLLAMA_BASE_URL` | — | Ollama host(s); comma-separated list = fallback order |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model (ollama) |
| `OLLAMA_CHAT_MODEL` | `qwen2.5-coder:7b` | Chat model (ollama) |
| `OPENAI_API_KEY` | — | Required when `LLM_PROVIDER=openai` |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model (openai) |
| `OPENAI_CHAT_MODEL` | `gpt-4o-mini` | Chat model (openai) |
| `EMBEDDING_DIMENSIONS` | `768` / `1536` | Must match model output (team: must match HEAD PC) |
| `API_PORT` | `3001` | API server port |
| `KB_API_URL` | `http://localhost:3001` | API address the CLI talks to |
| `KB_HEAD_URL` | `http://10.30.0.60:3001` | HEAD PC address for `kb sync` |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | API URL for frontend |

## Team Setup: HEAD PC + Laptops

One machine ("HEAD PC") holds the source-of-truth index of all repos on main/master and serves
snapshots over the LAN; laptops bootstrap from it instead of indexing from scratch, then stay in
sync with their own branches.

**HEAD PC** (periodically, after upstream merges):
```bash
kb refresh <repos-dir>        # pull main/master everywhere -> reindex -> snapshot
```

**Each laptop** (once):
```bash
git clone <this-repo> && cd KB && ./install.sh   # deps + build + `kb` on your PATH
# edit .env to match the HEAD PC's embedding config (LLM_PROVIDER, model, EMBEDDING_DIMENSIONS)
kb serve                                         # local stack up
kb sync <repos-dir>                              # download + restore + remap paths
```
`kb sync` pulls from `KB_HEAD_URL` (default `http://10.30.0.60:3001`); `kb fetch --from <url> --dir <dir>` is the same against an explicit server.

**Each laptop** (leave running in a spare terminal):
```bash
kb watch <repos-dir>          # reindexes a repo when its branch/commit/working tree changes
```

`kb sync`/`kb fetch` refuse a snapshot whose embedding model/dimensions differ from the local .env
(mixed vector spaces are unusable); `kb watch` only re-embeds files whose hash changed.

## TODOs / Future Work

- [x] Tree-sitter AST parsing for more accurate symbol extraction
- [x] Export/import index snapshots (`kb snapshot` / `kb sync`)
- [ ] GitHub/GitLab webhook sync for automatic re-indexing on push
- [ ] Streaming responses via SSE or WebSockets
- [ ] User auth and per-team repo scoping
- [ ] BM25 scoring as alternative to PostgreSQL FTS
- [ ] Redis job queue for indexing (replaces fire-and-forget `setImmediate`)
- [ ] Configurable embedding batch size and concurrency
- [ ] Web UI: inline diff view showing chunk in file context
