import fs from 'fs';
import path from 'path';
import { prisma } from '@kb/db';
import { createEmbeddingProvider } from '@kb/llm';
import type { EmbeddingProvider } from '@kb/llm';
import { scanDirectory } from './scanner';
import { chunkFile } from './chunkers';
import { buildCodeTree } from './callgraph';
import { linkCrossService } from './crosslink';
import type { FileInfo } from './types';

const EMBED_BATCH_SIZE = 10;

export interface IndexOptions {
  repoPath: string;
  repoName: string;
  branch?: string;
  /** re-chunk and re-embed files even when their hash is unchanged */
  force?: boolean;
  onProgress?: (indexed: number, total: number, reindexed: boolean) => void;
}

/**
 * Creates the repository and indexing_run DB records synchronously,
 * then returns IDs. Call runIndexing() separately for background processing.
 */
export async function createIndexingRun(opts: {
  repoPath: string;
  repoName: string;
  branch?: string;
}): Promise<{ runId: string; repoId: string }> {
  const repo = await prisma.repository.upsert({
    where: { name: opts.repoName },
    create: { name: opts.repoName, localPath: opts.repoPath, branch: opts.branch ?? 'main' },
    update: { localPath: opts.repoPath, branch: opts.branch ?? 'main', updatedAt: new Date() },
  });

  const run = await prisma.indexingRun.create({
    data: { repoId: repo.id, status: 'running' },
  });

  return { runId: run.id, repoId: repo.id };
}

/**
 * Runs the actual indexing work. Expects runId + repoId from createIndexingRun().
 * Updates run record to completed/failed on exit.
 */
export async function runIndexing(
  runId: string,
  opts: IndexOptions,
): Promise<void> {
  const embedder = createEmbeddingProvider();

  const repo = await prisma.repository.findFirst({
    where: { name: opts.repoName },
  });
  if (!repo) throw new Error(`Repository not found: ${opts.repoName}`);

  const commitSha = readCommitSha(opts.repoPath) ?? 'unknown';
  const remoteUrl = readRemoteUrl(opts.repoPath);
  if (commitSha !== 'unknown' || remoteUrl) {
    await prisma.repository.update({
      where: { id: repo.id },
      data: {
        ...(commitSha !== 'unknown' ? { currentCommitSha: commitSha } : {}),
        ...(remoteUrl ? { remoteUrl } : {}),
      },
    });
  }

  // Collect all files first (for total count)
  const files: FileInfo[] = [];
  for await (const f of scanDirectory(opts.repoPath)) files.push(f);

  await prisma.indexingRun.update({
    where: { id: runId },
    data: { filesTotal: files.length },
  });

  let indexed = 0;
  try {
    for (const fileInfo of files) {
      const reindexed = await indexFile(repo.id, fileInfo, commitSha, embedder, opts.force);
      indexed++;
      opts.onProgress?.(indexed, files.length, reindexed);
      // update progress every 10 files to avoid DB hammering
      if (indexed % 10 === 0 || indexed === files.length) {
        await prisma.indexingRun.update({
          where: { id: runId },
          data: { filesIndexed: indexed },
        });
      }
    }

    // Prune rows for files that no longer exist on disk (deleted, renamed,
    // or stale basename paths from the pre-fix scanner). Chunks cascade.
    await prisma.indexedFile.deleteMany({
      where: { repoId: repo.id, filePath: { notIn: files.map((f) => f.relativePath) } },
    });

    // indexFile() above skips writing a file whose content hash is unchanged, so its
    // commitSha (and its chunks') is left at whatever commit last modified it — not this
    // run's HEAD. That's a stale *label*, not stale content: the file was just re-read from
    // disk at opts.repoPath (checked out at commitSha), so its content is correct for the
    // current ref regardless of when it last changed. Bulk-restamp every row for this repo
    // so the whole index reads as one consistent ref after each run, instead of a mix of
    // whichever commit happened to touch each file last (which can be a commit that only
    // exists on a since-merged/rebased branch).
    if (commitSha !== 'unknown') {
      await prisma.indexedFile.updateMany({ where: { repoId: repo.id }, data: { commitSha } });
      await prisma.chunk.updateMany({ where: { repoId: repo.id }, data: { commitSha } });
    }

    await persistCodeTree(repo.id, opts.repoPath, files);
    // Link this repo's outbound HTTP calls to routes in other repos (cross-service edges).
    await linkCrossService({ repoId: repo.id });

    await prisma.indexingRun.update({
      where: { id: runId },
      data: { status: 'completed', filesIndexed: indexed, completedAt: new Date() },
    });
  } catch (err) {
    await prisma.indexingRun.update({
      where: { id: runId },
      data: { status: 'failed', error: String(err), completedAt: new Date() },
    });
    throw err;
  }
}

/**
 * Convenience wrapper that creates the run and immediately processes it.
 * Use for CLI / scripts. The API uses createIndexingRun + runIndexing separately.
 */
export async function indexRepository(
  opts: IndexOptions,
): Promise<{ runId: string; repoId: string }> {
  const { runId, repoId } = await createIndexingRun(opts);
  await runIndexing(runId, opts);
  return { runId, repoId };
}

// ---------------------------------------------------------------------------

/**
 * Rebuilds the persisted code tree (route > class > function + calls edges)
 * for the whole repo. ponytail: full rebuild each run, incremental per-file
 * updates if repos get big enough for this to hurt.
 */
async function persistCodeTree(repoId: string, repoPath: string, files: FileInfo[]): Promise<void> {
  const tree = buildCodeTree(
    repoPath,
    files.map((f) => ({ filePath: f.relativePath, language: f.language })),
  );

  const nodeId = (localId: string) => `${repoId}:${localId}`;

  await prisma.symbolEdge.deleteMany({ where: { repoId } });
  await prisma.symbolNode.deleteMany({ where: { repoId } });
  await prisma.symbolNode.createMany({
    data: tree.nodes.map((n) => ({
      id: nodeId(n.id),
      repoId,
      kind: n.kind,
      name: n.name,
      filePath: n.filePath,
      language: n.language,
      startLine: n.startLine,
      endLine: n.endLine,
    })),
    skipDuplicates: true,
  });
  await prisma.symbolEdge.createMany({
    data: tree.edges.map((e) => ({
      repoId,
      fromId: nodeId(e.from),
      toId: nodeId(e.to),
      kind: e.kind,
      confidence: e.confidence ?? null,
    })),
    skipDuplicates: true,
  });
}

async function indexFile(
  repoId: string,
  fileInfo: FileInfo,
  commitSha: string,
  embedder: EmbeddingProvider,
  force = false,
): Promise<boolean> {
  // Skip if file hash unchanged (incremental indexing)
  const existing = await prisma.indexedFile.findUnique({
    where: { repoId_filePath: { repoId, filePath: fileInfo.relativePath } },
  });
  if (!force && existing?.fileHash === fileInfo.hash) return false;

  const content = fs.readFileSync(fileInfo.absolutePath, 'utf-8');

  // Delete stale chunks before re-indexing
  if (existing) {
    await prisma.chunk.deleteMany({ where: { fileId: existing.id } });
  }

  const file = await prisma.indexedFile.upsert({
    where: { repoId_filePath: { repoId, filePath: fileInfo.relativePath } },
    create: { repoId, filePath: fileInfo.relativePath, language: fileInfo.language, fileHash: fileInfo.hash, commitSha },
    update: { language: fileInfo.language, fileHash: fileInfo.hash, commitSha, indexedAt: new Date() },
  });

  const parsed = chunkFile(content, fileInfo.relativePath, fileInfo.language);
  if (parsed.length === 0) return true;

  // Embed in batches, then insert with embedding via raw SQL
  for (let i = 0; i < parsed.length; i += EMBED_BATCH_SIZE) {
    const batch = parsed.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedder.embedBatch(batch.map((c) => c.content));

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const vec = `[${embeddings[j].join(',')}]`;

      // ponytail: $executeRawUnsafe used for vector literal — safe because
      // repoId/fileId are DB-generated CUIDs and vec is float array from OpenAI.
      await prisma.$executeRawUnsafe(`
        INSERT INTO chunks (id, "fileId", "repoId", "filePath", content, embedding, metadata, "startLine", "endLine", "chunkType", "commitSha", "indexedAt")
        VALUES (
          gen_random_uuid()::text,
          $1, $2, $3, $4,
          '${vec}'::vector,
          $5::jsonb,
          $6, $7, $8, $9,
          NOW()
        )
      `,
        file.id,
        repoId,
        fileInfo.relativePath,
        chunk.content,
        JSON.stringify(chunk.metadata),
        chunk.startLine,
        chunk.endLine,
        chunk.chunkType,
        commitSha,
      );
    }
  }

  return true;
}

/**
 * Locate the git dirs for a checkout, following worktrees: in a worktree `.git` is a file
 * ("gitdir: /main/.git/worktrees/<name>"). HEAD lives in gitDir; refs/config in commonDir.
 */
export function resolveGitDirs(repoPath: string): { gitDir: string; commonDir: string } | null {
  try {
    let gitDir = path.join(repoPath, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = fs.readFileSync(gitDir, 'utf-8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      gitDir = path.resolve(repoPath, m[1].trim());
    }
    const cd = path.join(gitDir, 'commondir');
    const commonDir = fs.existsSync(cd)
      ? path.resolve(gitDir, fs.readFileSync(cd, 'utf-8').trim())
      : gitDir;
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

/** origin URL from .git/config — lets other machines clone repos they don't have. */
function readRemoteUrl(repoPath: string): string | null {
  try {
    const dirs = resolveGitDirs(repoPath);
    if (!dirs) return null;
    const config = fs.readFileSync(path.join(dirs.commonDir, 'config'), 'utf-8');
    const m = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function readCommitSha(repoPath: string): string | null {
  try {
    const dirs = resolveGitDirs(repoPath);
    if (!dirs) return null;
    const headPath = path.join(dirs.gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) return null;
    const head = fs.readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const refFile = path.join(dirs.commonDir, head.slice(5));
      return fs.existsSync(refFile)
        ? fs.readFileSync(refFile, 'utf-8').trim().slice(0, 12)
        : null;
    }
    return head.slice(0, 12); // detached HEAD
  } catch {
    return null;
  }
}
