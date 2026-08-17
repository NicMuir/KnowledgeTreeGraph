/**
 * Interactive indexing TUI.
 * Usage: pnpm kb
 *
 * Pick repos to index; repos whose localPath is missing on this machine are
 * offered for cloning (shallow) into KB_MIRROR_DIR (default ~/.kb/mirrors).
 */
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { prisma } from '../packages/db/src';
import { indexRepository } from '../packages/ingestion/src/indexer';
import { renderBar, formatError } from './progress';

const MIRROR_DIR = process.env.KB_MIRROR_DIR ?? path.join(os.homedir(), '.kb', 'mirrors');

interface RepoRow {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  branch: string;
  local: boolean;
  fileCount: number;
  lastIndexed: Date | null;
}

async function loadRepos(): Promise<RepoRow[]> {
  const repos = await prisma.repository.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { files: true } },
      indexingRuns: { orderBy: { startedAt: 'desc' }, take: 1 },
    },
  });
  return repos.map((r) => ({
    id: r.id,
    name: r.name,
    localPath: r.localPath,
    remoteUrl: r.remoteUrl,
    branch: r.branch,
    local: fs.existsSync(r.localPath),
    fileCount: r._count.files,
    lastIndexed: r.indexingRuns[0]?.completedAt ?? null,
  }));
}

function ago(d: Date | null): string {
  if (!d) return 'never';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function repoLabel(r: RepoRow): string {
  const status = r.local ? '\x1b[32m✓ local\x1b[0m  ' : r.remoteUrl ? '\x1b[33m✗ missing (clone available)\x1b[0m' : '\x1b[31m✗ missing (no remote known)\x1b[0m';
  return `${r.name.padEnd(30)} ${status} ${String(r.fileCount).padStart(5)} files   indexed ${ago(r.lastIndexed)}`;
}

/** Clone a missing repo into the mirror dir and point the DB at it. */
async function cloneRepo(r: RepoRow): Promise<string | null> {
  if (!r.remoteUrl) return null;
  const dest = path.join(MIRROR_DIR, r.name);
  const ok = await confirm({
    message: `${r.name} is not on this machine. Clone from ${r.remoteUrl} into ${dest}?`,
  });
  if (!ok) return null;

  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  if (fs.existsSync(dest)) {
    console.log(`  ${dest} already exists — reusing it.`);
  } else {
    execSync(`git clone --depth 1 --branch ${r.branch} ${r.remoteUrl} ${dest}`, { stdio: 'inherit' });
  }
  await prisma.repository.update({ where: { id: r.id }, data: { localPath: dest } });
  return dest;
}

async function runIndex(name: string, repoPath: string, branch: string, force: boolean): Promise<void> {
  console.log(`\nIndexing "${name}" at ${repoPath}${force ? ' (force)' : ''}...`);
  const results: boolean[] = [];
  try {
    await indexRepository({
      repoPath,
      repoName: name,
      branch,
      force,
      onProgress: (indexed, total, reindexed) => {
        results.push(reindexed);
        process.stdout.write(`\r  ${renderBar(results, total)}`);
      },
    });
    console.log('\n  done.');
  } catch (err) {
    console.error(`\n  failed: ${formatError(err)}`);
  }
}

async function actionIndex(): Promise<void> {
  const repos = await loadRepos();
  const selectable = repos.filter((r) => r.local || r.remoteUrl);
  if (selectable.length === 0) {
    console.log('No indexable repos. Use "Add a repo" first.');
    return;
  }

  const picked = await checkbox({
    message: 'Select repos to index:',
    pageSize: 20,
    choices: selectable.map((r) => ({ name: repoLabel(r), value: r })),
  });
  if (picked.length === 0) return;

  const force = await confirm({
    message: 'Force re-index (re-chunk + re-embed unchanged files — costs embedding tokens)?',
    default: false,
  });

  for (const r of picked) {
    let repoPath: string | null = r.localPath;
    if (!r.local) repoPath = await cloneRepo(r);
    if (!repoPath) {
      console.log(`  skipping ${r.name}.`);
      continue;
    }
    await runIndex(r.name, repoPath, r.branch, force);
  }
}

async function actionAdd(): Promise<void> {
  const source = await input({ message: 'Local path or git URL:' });
  if (!source.trim()) return;

  let repoPath = source.trim();
  const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(repoPath);
  const defaultName = path.basename(repoPath, '.git');
  const name = await input({ message: 'Repo name:', default: defaultName });
  const branch = await input({ message: 'Branch:', default: 'main' });

  if (isUrl) {
    const dest = path.join(MIRROR_DIR, name);
    fs.mkdirSync(MIRROR_DIR, { recursive: true });
    if (!fs.existsSync(dest)) {
      execSync(`git clone --depth 1 --branch ${branch} ${repoPath} ${dest}`, { stdio: 'inherit' });
    }
    repoPath = dest;
  } else if (!fs.existsSync(repoPath)) {
    console.log(`Path does not exist: ${repoPath}`);
    return;
  }

  await runIndex(name, repoPath, branch, false);
}

async function actionStatus(): Promise<void> {
  const repos = await loadRepos();
  console.log();
  for (const r of repos) console.log(`  ${repoLabel(r)}`);
  console.log();
}

void (async () => {
  // loop until exit so you can index, check status, index more
  for (;;) {
    const action = await select({
      message: 'KB indexing — what do you want to do?',
      choices: [
        { name: 'Index repos', value: 'index' },
        { name: 'Add a repo (path or git URL)', value: 'add' },
        { name: 'Status', value: 'status' },
        { name: 'Exit', value: 'exit' },
      ],
    });
    if (action === 'index') await actionIndex();
    else if (action === 'add') await actionAdd();
    else if (action === 'status') await actionStatus();
    else break;
  }
  await prisma.$disconnect();
})();
