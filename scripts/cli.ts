/**
 * kb — unified CLI for the Knowledge Base.
 *
 *   kb index <path> [--name n] [--branch b] [--force]   index one repo (needs DB + embedder)
 *   kb index-all <dir> [--branch b] [--skip a,b]         index every subdir of <dir>
 *   kb ask "<question>" [--repo r] [--path p]            RAG answer with citations (needs API)
 *   kb search "<query>" [--repo r] [--lang l] [--type t] [--limit n] [--expand]
 *   kb list                                              list indexed repos (needs API)
 *   kb tui                                               interactive index picker
 *   kb serve                                             docker up + start the API
 *   kb doctor                                            check prerequisites (DB, embedder, API)
 *
 * ponytail: runs under ts-node at invocation (no build step) — matches the rest of scripts/.
 * Bundle to a single binary only if startup latency ever matters.
 */
import 'dotenv/config'; // bin/kb.mjs sets DOTENV_CONFIG_PATH to the repo .env so this works from any cwd
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, execSync } from 'child_process';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { indexRepository, resolveGitDirs } from '../packages/ingestion/src/indexer';
import { linkCrossService } from '../packages/ingestion/src/crosslink';
import { embeddingIdentity } from '../packages/llm/src';
import { renderBar, formatError } from './progress';

const API = (process.env.KB_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const OLLAMA = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const ROOT = path.resolve(__dirname, '..');

// ── tiny arg parser: positionals + --flag [value] (bare flag = boolean true) ──
function parse(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function indexOne(repoPath: string, name: string, branch: string, force: boolean): Promise<void> {
  process.stdout.write(`  ${name.padEnd(28)} `);
  const results: boolean[] = [];
  try {
    await indexRepository({
      repoPath, repoName: name, branch, force,
      onProgress: (_i, total, reindexed) => {
        results.push(reindexed);
        process.stdout.write(`\r  ${name.padEnd(28)} ${renderBar(results, total)}`);
      },
    });
    process.stdout.write(`\r\x1b[K  ${name.padEnd(28)} ✓\n`);
  } catch (err) {
    process.stdout.write(`\r\x1b[K  ${name.padEnd(28)} ✗ ${formatError(err)}\n`);
    throw err;
  }
}

async function cmdIndex(pos: string[], flags: Record<string, string | true>): Promise<void> {
  const target = pos[0];
  if (!target) die('Usage: kb index <path> [--name n] [--branch b] [--force]');
  const repoPath = path.resolve(process.cwd(), target);
  if (!fs.existsSync(repoPath)) die(`Path not found: ${repoPath}`);
  const name = (flags.name as string) ?? path.basename(repoPath);
  const branch = (flags.branch as string) ?? 'main';
  await indexOne(repoPath, name, branch, flags.force === true);
}

async function cmdIndexAll(pos: string[], flags: Record<string, string | true>): Promise<void> {
  const dir = pos[0];
  if (!dir) die('Usage: kb index-all <dir> [names,to,include] [--only a,b] [--skip a,b] [--branch b]');
  const absDir = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(absDir)) die(`Directory not found: ${absDir}`);
  const branch = (flags.branch as string) ?? 'main';
  const skip = new Set(String(flags.skip ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  // Include-list: `--only a,b` or a positional comma-list after the dir. Empty = all subdirs.
  const only = new Set(String(flags.only ?? pos[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  const projects = fs.readdirSync(absDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name)
      && (only.size === 0 || only.has(e.name)));
  if (projects.length === 0) {
    die(only.size ? `None of [${[...only].join(', ')}] found in ${absDir}` : `No project directories in ${absDir}`);
  }

  console.log(`Indexing ${projects.length} repos in ${absDir}\n`);
  let ok = 0, failed = 0;
  for (const e of projects) {
    try { await indexOne(path.join(absDir, e.name), e.name, branch, false); ok++; }
    catch { failed++; }
  }
  // Global relink so repos indexed earlier pick up routes from ones indexed later.
  process.stdout.write('  linking cross-service calls… ');
  const { edges } = await linkCrossService();
  console.log(`${edges} edges`);
  console.log(`\nDone. ${ok} succeeded, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

const SNAP_DIR = path.join(ROOT, 'snapshots');
const HEAD_URL = (process.env.KB_HEAD_URL ?? 'http://10.30.0.60:3001').replace(/\/$/, '');

// `kb sync <dir>` — fetch from the team's HEAD PC without remembering its address.
async function cmdSync(pos: string[], flags: Record<string, string | true>): Promise<void> {
  const dir = pos[0] ?? (flags.dir as string);
  if (!dir) die(`Usage: kb sync <repos-dir> [--force]   (pulls the snapshot from ${HEAD_URL}; override with KB_HEAD_URL or --from)`);
  await cmdFetch([], { ...flags, from: (flags.from as string) ?? HEAD_URL, dir });
}

// Dump the DB for distribution to laptops (HEAD PC). Date-named files sort chronologically.
async function cmdSnapshot(_pos: string[], flags: Record<string, string | true>): Promise<void> {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const file = path.join(SNAP_DIR, `kb-main-${new Date().toISOString().slice(0, 10)}.dump`);
  process.stdout.write(`Dumping database → ${path.relative(process.cwd(), file)} … `);
  const r = spawnSync('sh', ['-c', `docker compose exec -T postgres pg_dump -U kb -Fc kb > "${file}"`], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (r.status !== 0) { fs.rmSync(file, { force: true }); die('pg_dump failed (is the stack up? kb serve)'); }
  console.log(`${(fs.statSync(file).size / 1e6).toFixed(0)} MB`);
  const keep = Number(flags.keep) || 3;
  const dumps = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith('.dump')).sort();
  for (const old of dumps.slice(0, Math.max(0, dumps.length - keep))) {
    fs.rmSync(path.join(SNAP_DIR, old));
    console.log(`  pruned ${old}`);
  }
}

// Bootstrap a laptop from the HEAD PC's snapshot: download → restore → remap repo paths.
async function cmdFetch(_pos: string[], flags: Record<string, string | true>): Promise<void> {
  const from = ((flags.from as string) ?? '').replace(/\/$/, '');
  const dir = flags.dir as string;
  if (!from || typeof dir !== 'string') die('Usage: kb fetch --from http://head-pc:3001 --dir <local repos dir> [--force]');
  const absDir = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(absDir)) die(`Directory not found: ${absDir}`);

  let res: Response;
  try { res = await fetch(`${from}/snapshot/info`); }
  catch { die(`Cannot reach ${from} — is kb serve running on the HEAD PC?`); }
  if (!res!.ok) die(`${from}/snapshot/info → ${res!.status}: ${await res!.text()}`);
  const info = await res!.json() as { name: string; size: number; mtime: string; embeddingModel: string; embeddingDimensions: number };

  // Mismatched embeddings make the restored vectors useless with local incremental embeds.
  const local = embeddingIdentity();
  if (info.embeddingModel !== local.model || info.embeddingDimensions !== local.dimensions) {
    console.error(`Embedding mismatch: server ${info.embeddingModel}/${info.embeddingDimensions}d, local ${local.model}/${local.dimensions}d`);
    if (flags.force !== true) die('Aborting — align your .env with the HEAD PC, or pass --force');
  }

  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const dest = path.join(SNAP_DIR, info.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size === info.size) {
    console.log(`Already downloaded: ${info.name}`);
  } else {
    process.stdout.write(`Downloading ${info.name} (${(info.size / 1e6).toFixed(0)} MB) … `);
    const dl = await fetch(`${from}/snapshot`);
    if (!dl.ok || !dl.body) die(`Download failed: ${dl.status}`);
    await pipeline(Readable.fromWeb(dl.body as never), fs.createWriteStream(dest));
    console.log('done');
  }

  // Kill other connections + restore in ONE exec: a live API (prisma pool) would block
  // --clean's DROPs; prisma reconnects lazily afterwards, so a running `kb serve` self-heals.
  console.log('Restoring (drops and recreates all KB tables)…');
  const restore = spawnSync('sh', ['-c',
    `docker compose exec -T postgres sh -c '`
    + `psql -q -U kb -d kb -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity`
    + ` WHERE datname=current_database() AND pid <> pg_backend_pid()" > /dev/null`
    + ` && pg_restore -U kb -d kb --clean --if-exists --no-owner --no-privileges' < "${dest}"`,
  ], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  // ponytail: retry-by-rerun; no lock/pause machinery around the restore
  if (restore.status !== 0) die('pg_restore failed — a live connection may have raced the drop; re-run kb fetch');

  // Server paths are absolute to the HEAD PC — rebase every repo onto --dir by basename.
  const { prisma } = await import('../packages/db/src');
  const repos = await prisma.repository.findMany({ select: { id: true, name: true, localPath: true } });
  const missing: string[] = [];
  for (const r of repos) {
    const localPath = path.join(absDir, path.basename(r.localPath));
    await prisma.repository.update({ where: { id: r.id }, data: { localPath } });
    if (!fs.existsSync(localPath)) missing.push(r.name);
  }
  await prisma.$disconnect();
  console.log(`Restored ${repos.length} repos; paths remapped onto ${absDir}`);
  if (missing.length) console.log(`  not cloned here (search still works; watch skips them): ${missing.join(', ')}`);
  console.log(`\nNext: kb watch ${absDir}   (keeps the index in sync with your branches)`);
}

/** Branch + 12-char SHA from .git files (loose or packed refs); null = not a repo / mid-operation. */
function readGitState(repoPath: string): { sha: string; branch: string } | null {
  try {
    const dirs = resolveGitDirs(repoPath);
    if (!dirs) return null;
    const head = fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf-8').trim();
    if (!head.startsWith('ref: ')) return { sha: head.slice(0, 12), branch: 'HEAD' }; // detached
    const ref = head.slice(5);
    const branch = ref.replace('refs/heads/', '');
    const refFile = path.join(dirs.commonDir, ref);
    if (fs.existsSync(refFile)) return { sha: fs.readFileSync(refFile, 'utf-8').trim().slice(0, 12), branch };
    const packed = path.join(dirs.commonDir, 'packed-refs');
    if (fs.existsSync(packed)) {
      const line = fs.readFileSync(packed, 'utf-8').split('\n').find((l) => l.endsWith(` ${ref}`));
      if (line) return { sha: line.slice(0, 12), branch };
    }
    return null;
  } catch { return null; }
}

/** Fingerprint of uncommitted changes: dirty-file list + mtimes. '' = clean. Changes on every save. */
function dirtyKey(repoPath: string): string {
  try {
    const status = execSync('git status --porcelain -uno', { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    if (!status.trim()) return '';
    const parts = [status];
    for (const line of status.trim().split('\n')) {
      const f = line.slice(3).replace(/^"|"$/g, '');
      try {
        const st = fs.statSync(path.join(repoPath, f));
        parts.push(`${f}:${st.mtimeMs}:${st.size}`);
      } catch { /* deleted or rename composite — the status line itself covers it */ }
    }
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
  } catch { return ''; }
}

// Keep the local index in sync: reindex a repo when its git state (or working tree) changes.
async function cmdWatch(pos: string[], flags: Record<string, string | true>): Promise<void> {
  const dir = pos[0];
  if (!dir) die('Usage: kb watch <dir> [repo…] [--interval 5] [--dirty-interval 60]');
  const only = new Set(pos.slice(1)); // empty = all repos in dir
  const absDir = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(absDir)) die(`Directory not found: ${absDir}`);

  // Baseline from the DB: right after `kb fetch` it holds the HEAD PC's SHAs, so the first
  // pass reindexes exactly the repos whose local checkout differs from the snapshot.
  const { prisma } = await import('../packages/db/src');
  const rows = await prisma.repository.findMany({ select: { name: true, branch: true, currentCommitSha: true } });
  await prisma.$disconnect();
  const seen = new Map(rows.map((r) => [r.name, `${r.branch}@${r.currentCommitSha ?? ''}`]));
  const dirtySeen = new Map<string, string>();

  const interval = (Number(flags.interval) || 5) * 1000;
  const dirtyEvery = (Number(flags['dirty-interval']) || 60) * 1000;
  let lastDirty = 0;
  console.log(`Watching ${absDir} (git state every ${interval / 1000}s, uncommitted saves every ${dirtyEvery / 1000}s; Ctrl-C to stop)`);

  // ponytail: polling beats fs.watch — git swaps .git/HEAD atomically, which kills per-file
  // watchers; reading ~25 HEAD files per tick is trivial. Sequential loop = free serialization.
  for (;;) {
    const checkDirty = Date.now() - lastDirty >= dirtyEvery;
    if (checkDirty) lastDirty = Date.now();
    const entries = fs.readdirSync(absDir, { withFileTypes: true }) // re-scan: picks up new clones
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && (only.size === 0 || only.has(e.name)));
    let reindexed = 0;
    for (const e of entries) {
      const repoPath = path.join(absDir, e.name);
      const state = readGitState(repoPath);
      if (!state) continue;
      const key = `${state.branch}@${state.sha}`;
      let reason = '';
      let newDirty: string | null = null;
      if (seen.get(e.name) !== key) {
        reason = `${seen.get(e.name) ?? 'new'} → ${key}`;
      } else if (checkDirty) {
        const dk = dirtyKey(repoPath);
        if (dk !== (dirtySeen.get(e.name) ?? '')) { reason = dk ? 'uncommitted changes' : 'working tree reverted'; newDirty = dk; }
      }
      if (!reason) continue;
      console.log(`[${new Date().toTimeString().slice(0, 8)}] ${e.name}: ${reason}`);
      try {
        await indexOne(repoPath, e.name, state.branch, false); // incremental: unchanged fileHash skipped
        seen.set(e.name, key);
        if (newDirty !== null) dirtySeen.set(e.name, newDirty);
        reindexed++;
      } catch { /* ✗ printed by indexOne; state not recorded → retried next tick */ }
    }
    if (reindexed > 0) {
      process.stdout.write('  linking cross-service calls… ');
      const { edges } = await linkCrossService(); // global: heals inbound edges after node-id shifts
      console.log(`${edges} edges`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// HEAD PC ritual: pull every repo's main/master, reindex everything, snapshot.
async function cmdRefresh(pos: string[], flags: Record<string, string | true>): Promise<void> {
  const dir = pos[0];
  if (!dir) die('Usage: kb refresh <dir> [--keep n]   (HEAD PC: pull main/master → reindex → snapshot)');
  const absDir = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(absDir)) die(`Directory not found: ${absDir}`);

  console.log(`Updating repos in ${absDir} to main/master…`);
  const entries = fs.readdirSync(absDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  for (const e of entries) {
    const repo = path.join(absDir, e.name);
    if (!fs.existsSync(path.join(repo, '.git'))) continue;
    const sw = spawnSync('sh', ['-c', 'git switch main 2>/dev/null || git switch master'], { cwd: repo, stdio: 'ignore' });
    if (sw.status !== 0) { console.log(`  ${e.name}: cannot switch (dirty working tree?) — left as-is`); continue; }
    const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: repo, stdio: 'ignore' });
    if (pull.status !== 0) console.log(`  ${e.name}: pull failed (no remote / diverged?) — indexing current state`);
  }
  await cmdIndexAll([absDir], {});
  await cmdSnapshot([], flags);
}

async function cmdAsk(pos: string[], flags: Record<string, string | true>): Promise<void> {
  const question = pos.join(' ').trim();
  if (!question) die('Usage: kb ask "<question>" [--repo r] [--path p]');
  const res = await api('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      repoNames: flags.repo ? [flags.repo as string] : [],
      pathFilter: flags.path as string | undefined,
      maxResults: 8,
    }),
  });
  const data = await res.json() as {
    answer: string; retrievedChunks: number; model: string;
    sources: Array<{ repoName: string; filePath: string; startLine: number; endLine: number; chunkType: string; commitSha: string }>;
  };
  console.log(`\n${data.answer}\n`);
  console.log(`--- ${data.retrievedChunks} chunks via ${data.model} ---`);
  if (data.sources.length) {
    console.log('\nSources:');
    data.sources.forEach((s, i) =>
      console.log(`  [${i + 1}] ${s.repoName}/${s.filePath}:${s.startLine}-${s.endLine} (${s.chunkType}, ${s.commitSha})`));
  }
}

async function cmdSearch(pos: string[], flags: Record<string, string | true>): Promise<void> {
  const query = pos.join(' ').trim();
  if (!query) die('Usage: kb search "<query>" [--repo r] [--lang l] [--type t] [--limit n] [--expand]');
  const params = new URLSearchParams({ q: query });
  if (flags.repo) params.set('repo', flags.repo as string);
  if (flags.lang) params.set('lang', flags.lang as string);
  if (flags.type) params.set('type', flags.type as string);
  if (flags.limit) params.set('limit', String(flags.limit));
  if (flags.expand) params.set('expand', '1');

  const res = await api(`/search?${params}`);
  const data = await res.json() as {
    total: number;
    results: Array<{ repoName: string; filePath: string; startLine: number; endLine: number; chunkType: string; score: number; content: string; metadata: { symbolName?: string; heading?: string } }>;
  };
  if (!data.results.length) { console.log('No results.'); return; }
  console.log(`${data.total} results:\n`);
  data.results.forEach((r, i) => {
    const label = r.metadata.symbolName ?? r.metadata.heading ?? r.chunkType;
    console.log(`[${i + 1}] ${r.repoName}/${r.filePath}:${r.startLine}-${r.endLine}  ${label}  (${r.score.toFixed(3)})`);
    console.log(`    ${r.content.slice(0, 200).replace(/\n/g, '\n    ')}${r.content.length > 200 ? ' …' : ''}\n`);
  });
}

interface EdgeSample {
  kind: string; confidence: number | null;
  f_name: string; f_path: string; f_line: number; f_repo: string; f_local: string;
  t_name: string; t_path: string; t_line: number; t_repo: string;
}

// Dump a random sample of edges with source context for manual precision review.
async function cmdSample(pos: string[], flags: Record<string, string | true>): Promise<void> {
  const kind = (flags.kind as string) ?? pos[0] ?? 'calls';
  const n = Number(flags.n) || 30;
  const { prisma } = await import('../packages/db/src');
  const rows = await prisma.$queryRawUnsafe<EdgeSample[]>(
    `SELECT e.kind, e.confidence,
       fn.name AS f_name, fn."filePath" AS f_path, fn."startLine" AS f_line, fr.name AS f_repo, fr."localPath" AS f_local,
       tn.name AS t_name, tn."filePath" AS t_path, tn."startLine" AS t_line, tr.name AS t_repo
     FROM symbol_edges e
     JOIN symbol_nodes fn ON fn.id = e."fromId"  JOIN repositories fr ON fr.id = fn."repoId"
     JOIN symbol_nodes tn ON tn.id = e."toId"    JOIN repositories tr ON tr.id = tn."repoId"
     WHERE e.kind = $1 ORDER BY random() LIMIT $2`,
    kind, n,
  );
  await prisma.$disconnect();

  const out: string[] = [`# Resolution precision sample — kind=${kind}, n=${rows.length}`, '',
    'Mark each edge C (correct) or X (wrong) in the verdict box. Precision = C / (C+X).', ''];
  rows.forEach((r, i) => {
    const snippet = readSnippet(path.join(r.f_local, r.f_path), r.f_line);
    const conf = r.confidence != null ? `conf ${r.confidence}` : 'no conf';
    out.push(`## ${i + 1}. [${conf}] ${r.f_repo}/${r.f_path}:${r.f_line + 1}`);
    out.push(`**${r.f_name}** → **${r.t_name}**  (${r.t_repo}/${r.t_path}:${r.t_line + 1})`);
    out.push('```', snippet, '```', 'Verdict: [ ]', '');
  });

  const text = out.join('\n');
  if (flags.out) { fs.writeFileSync(flags.out as string, text); console.log(`Wrote ${rows.length} samples → ${flags.out}`); }
  else console.log(text);
}

function readSnippet(absPath: string, row0: number): string {
  try {
    const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
    const start = Math.max(0, row0 - 1);
    return lines.slice(start, row0 + 4).join('\n');
  } catch {
    return '(source unavailable)';
  }
}

async function cmdLink(): Promise<void> {
  console.log('Linking cross-service HTTP calls to routes across all repos…');
  const { calls, edges } = await linkCrossService();
  console.log(`Done. ${edges} http_calls edges from ${calls} call-sites.`);
}

async function cmdGraph(kind: 'routes' | 'trace' | 'impact', pos: string[], flags: Record<string, string | true>): Promise<void> {
  if (kind === 'routes') {
    const repo = (flags.repo as string) ?? pos[0];
    if (!repo) die('Usage: kb routes <repo> [--q substr]');
    const params = new URLSearchParams({ repo });
    if (flags.q) params.set('q', flags.q as string);
    const res = await api(`/graph/routes?${params}`);
    const data = await res.json() as { total: number; routes: Array<{ name: string; filePath: string; startLine: number }> };
    console.log(`${data.total} routes:`);
    for (const r of data.routes) console.log(`  ${r.name}  (${r.filePath}:${r.startLine})`);
    return;
  }
  const symbol = pos.join(' ').trim();
  if (!symbol) die(`Usage: kb ${kind} "<symbol|route>" [--repo r]${kind === 'trace' ? ' [--direction in|out]' : ''} [--depth n]`);
  const params = new URLSearchParams({ symbol });
  if (flags.repo) params.set('repo', flags.repo as string);
  if (flags.depth) params.set('depth', String(flags.depth));
  if (kind === 'trace' && flags.direction) params.set('direction', flags.direction as string);
  const res = await api(`/graph/${kind}?${params}`);
  const data = await res.json() as { count: number; services?: string[]; nodes?: GraphNode[]; dependents?: GraphNode[] };
  const rows = data.nodes ?? data.dependents ?? [];
  if (rows.length === 0) { console.log('No results.'); return; }
  if (data.services) console.log(`Impacts ${data.count} nodes across services [${data.services.join(', ')}]:`);
  for (const n of rows) {
    console.log(`${'  '.repeat(n.depth)}[d${n.depth}] ${n.kind} ${n.name}  (${n.repoName}/${n.filePath}:${n.startLine}${n.via ? `, via ${n.via}` : ''}${n.confidence != null ? ` conf ${n.confidence}` : ''})`);
  }
}

interface GraphNode {
  name: string; kind: string; filePath: string; startLine: number;
  repoName: string; depth: number; via: string | null; confidence: number | null;
}

async function cmdList(): Promise<void> {
  const res = await api('/repos');
  const repos = await res.json() as Array<{
    name: string; branch: string; currentCommitSha: string | null; fileCount: number; chunkCount: number;
    lastRun: { status: string; filesIndexed: number; filesTotal: number; startedAt: string } | null;
  }>;
  if (!repos.length) { console.log('No repos indexed yet. Run: kb index <path>'); return; }
  for (const r of repos) {
    const run = r.lastRun ? `${r.lastRun.status} (${r.lastRun.filesIndexed}/${r.lastRun.filesTotal})` : 'never indexed';
    const sha = r.currentCommitSha ? `@${r.currentCommitSha}` : '';
    console.log(`  ${r.name.padEnd(30)}${sha.padEnd(14)} [${r.branch}]  ${String(r.fileCount).padStart(5)} files · ${String(r.chunkCount).padStart(6)} chunks · ${run}`);
  }
}

const API_LOG = path.join(ROOT, '.kb-api.log');

async function cmdServe(): Promise<void> {
  console.log('Starting Postgres (docker compose up -d)…');
  spawnSync('docker', ['compose', 'up', '-d'], { cwd: ROOT, stdio: 'inherit' });

  // API runs as a background child; logs go to a file so the prompt stays clean (`logs` to view).
  // Shell redirection (not a spawn fd) so ts-node-dev's respawned worker inherits it too.
  // detached: own process group, so we can kill the whole tree on exit.
  console.log(`Starting API on :3001 (logs → ${path.relative(process.cwd(), API_LOG)})…`);
  const apiChild = spawn('sh', ['-c', `exec pnpm --filter @kb/api dev > "${API_LOG}" 2>&1`], {
    cwd: ROOT, stdio: 'ignore', detached: true,
  });
  apiChild.on('exit', (code) => {
    if (code) console.log(`\n\x1b[31mAPI exited (code ${code}). Type: logs\x1b[0m`);
  });

  // Wait for health before handing over the prompt.
  process.stdout.write('  waiting for API');
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) break;
    } catch { /* not up yet */ }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(' ready\n');

  await startRepl(apiChild);
}

// Interactive prompt: run kb subcommands in-place without re-launching. `exit`/Ctrl-D stops the API.
async function startRepl(apiChild: ReturnType<typeof spawn>): Promise<never> {
  const readline = await import('readline');
  console.log('KB console — type a command (doctor, list, ingest <path>, search "…", ask "…", logs, help, exit)');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'kb> ' });
  rl.prompt();

  // Serialize lines through a promise chain so commands run one at a time and `close`
  // (Ctrl-D / end of piped input) waits for the in-flight command before shutting down.
  let chain: Promise<void> = Promise.resolve();
  rl.on('line', (raw) => {
    const toks = tokenize(raw.trim());
    if (toks.length === 0) { rl.prompt(); return; }
    const [cmd, ...rest] = toks;
    if (cmd === 'exit' || cmd === 'quit') { rl.close(); return; }
    chain = chain.then(async () => {
      try { await dispatch(cmd, rest, { repl: true }); }
      catch (err) { console.error(err instanceof CliError ? err.message : formatError(err)); }
      rl.prompt();
    });
  });

  return new Promise<never>(() => {
    rl.on('close', () => {
      void chain.then(() => {
        console.log('\nStopping API…');
        try { if (apiChild.pid) process.kill(-apiChild.pid, 'SIGTERM'); } catch { /* already gone */ }
        process.exit(0);
      });
    });
  });
}

/** Split a line into tokens, honouring single/double quotes so paths and questions with spaces work. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

async function cmdDoctor(): Promise<void> {
  const line = (label: string, ok: boolean, detail: string) =>
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label.padEnd(20)} ${detail}`);

  // DB
  try {
    const { prisma } = await import('../packages/db/src');
    await prisma.$queryRaw`SELECT 1`;
    line('database', true, process.env.DATABASE_URL ?? '');
    await prisma.$disconnect();
  } catch (err) { line('database', false, formatError(err)); }

  // Embedder — OLLAMA_BASE_URL may be a comma-list (remote,local fallback); check each host
  const hosts = OLLAMA.split(',').map((h) => h.trim().replace(/\/$/, '')).filter(Boolean);
  let anyEmbedder = false;
  for (const host of hosts) {
    try {
      const r = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(4000) });
      const v = await r.json() as { version?: string };
      line('embedder (ollama)', r.ok, `${host} ${v.version ? `v${v.version}` : ''}`);
      anyEmbedder ||= r.ok;
    } catch { line('embedder (ollama)', false, `${host} unreachable`); }
  }
  if (!anyEmbedder) console.log('    \x1b[33m→ no embedder reachable: indexing/search will fail\x1b[0m');

  // API
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(4000) });
    line('api', r.ok, API);
  } catch { line('api', false, `${API} — not running (kb serve)`); }
}

function cmdLogs(pos: string[]): void {
  const n = Number(pos[0]) || 60;
  if (!fs.existsSync(API_LOG)) { console.log('No API log yet.'); return; }
  const lines = fs.readFileSync(API_LOG, 'utf-8').split('\n');
  console.log(lines.slice(-n).join('\n'));
}

function usage(repl = false): void {
  const p = repl ? '' : 'kb ';
  console.log(`kb — Knowledge Base CLI

  ${p}index|ingest <path> [--name n] [--branch b] [--force]   index one repo
  ${p}index-all <dir> [names,to,include] [--only a,b] [--skip a,b]   index subdirs (+auto link)
  ${p}refresh <dir> [--keep n]                                HEAD PC: pull main/master → reindex → snapshot
  ${p}snapshot [--keep 3]                                     dump the DB → snapshots/ (served at /snapshot)
  ${p}sync <dir> [--force]                                    bootstrap/refresh from the HEAD PC (${HEAD_URL})
  ${p}fetch --from http://pc:3001 --dir <dir> [--force]       same, from an explicit server
  kb watch <dir> [repo…] [--interval 5] [--dirty-interval 60]  reindex repos as their git state changes
  ${p}link                                                    rebuild cross-service HTTP call edges
  ${p}sample [calls|http_calls] [--n 30] [--out file.md]      edge sample for precision review
  ${p}ask "<question>" [--repo r] [--path p]                  RAG answer with citations
  ${p}search "<query>" [--repo r] [--lang l] [--type t] [--limit n] [--expand]
  ${p}routes <repo> [--q substr]                              list a repo's HTTP routes
  ${p}trace "<symbol>" [--repo r] [--direction in|out] [--depth n]   callers/callees
  ${p}impact "<symbol|route>" [--repo r] [--depth n]          cross-service dependents
  ${p}list                                                    list indexed repos
  ${p}doctor                                                  check DB / embedder / API
  ${p}tui                                                     interactive index picker${repl ? `
  logs [n]                                                  show last n API log lines
  exit                                                     stop the API and quit` : `
  kb serve                                                    start the stack + interactive console`}

Env: KB_API_URL (default ${API}), KB_HEAD_URL (default ${HEAD_URL}), OLLAMA_BASE_URL, DATABASE_URL.`);
}

// Shared command router for both the one-shot CLI and the `kb serve` console.
async function dispatch(cmd: string | undefined, rest: string[], ctx: { repl: boolean }): Promise<void> {
  const { pos, flags } = parse(rest);
  switch (cmd) {
    case 'index': case 'ingest': await cmdIndex(pos, flags); break;
    case 'index-all': await cmdIndexAll(pos, flags); break;
    case 'snapshot': await cmdSnapshot(pos, flags); break;
    case 'sync': await cmdSync(pos, flags); break;
    case 'fetch': await cmdFetch(pos, flags); break;
    case 'refresh': await cmdRefresh(pos, flags); break;
    case 'watch':
      if (ctx.repl) die('`watch` runs standalone: open another terminal and run `kb watch <dir>`');
      await cmdWatch(pos, flags);
      break;
    case 'link': await cmdLink(); break;
    case 'sample': await cmdSample(pos, flags); break;
    case 'routes': await cmdGraph('routes', pos, flags); break;
    case 'trace': await cmdGraph('trace', pos, flags); break;
    case 'impact': await cmdGraph('impact', pos, flags); break;
    case 'ask': await cmdAsk(pos, flags); break;
    case 'search': await cmdSearch(pos, flags); break;
    case 'list': await cmdList(); break;
    case 'doctor': await cmdDoctor(); break;
    case 'tui': await import('./kb-tui'); break;
    case 'logs':
      if (ctx.repl) cmdLogs(pos);
      else die('`logs` is only available inside the kb serve console');
      break;
    case 'serve':
      if (ctx.repl) console.log('Already serving.');
      else await cmdServe();
      break;
    case undefined: case 'help': case '--help': case '-h': usage(ctx.repl); break;
    default: die(`Unknown command: ${cmd} (try 'help')`);
  }
}

// ── helpers ──
async function api(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API}${pathAndQuery}`, init);
  } catch {
    die(`Cannot reach API at ${API}. Start it with: kb serve`);
  }
  if (!res!.ok) die(`API error ${res!.status}: ${await res!.text()}`);
  return res!;
}

// Throws instead of exiting, so the serve console survives a bad command. One-shot main turns it into exit 1.
class CliError extends Error {}
function die(msg: string): never {
  throw new CliError(msg);
}

// One-shot mode: `serve`/`tui` keep the process alive; everything else runs and exits.
void (async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  await dispatch(cmd, rest, { repl: false });
  if (cmd !== 'serve' && cmd !== 'tui') process.exit(0);
})().catch((err: unknown) => {
  console.error(err instanceof CliError ? err.message : `Error: ${formatError(err)}`);
  process.exit(1);
});
