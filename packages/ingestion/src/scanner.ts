import fs from 'fs';
import path from 'path';
import { SKIP_DIRS } from '@kb/shared';
import { hashContent } from './hasher';
import { detectLanguage } from './detector';
import type { FileInfo } from './types';

const MAX_FILE_BYTES = 512 * 1024; // 512 KB — skip huge files

const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php',
  '.cs', '.cpp', '.c', '.h', '.hpp',
  '.md', '.mdx', '.json', '.yaml', '.yml', '.toml',
  '.sql', '.sh', '.bash', '.zsh',
  '.graphql', '.gql', '.proto', '.tf', '.hcl',
  '.prisma', '.css', '.scss',
]);

const INDEXABLE_BASENAMES = new Set([
  'dockerfile', 'makefile', '.gitignore', 'readme', 'license', '.env.example',
]);

function isIndexable(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (INDEXABLE_EXTENSIONS.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  return INDEXABLE_BASENAMES.has(base);
}

export async function* scanDirectory(rootDir: string, baseDir = rootDir): AsyncGenerator<FileInfo> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
      // allow .env.example explicitly but skip other dot-dirs
      if (entry.isDirectory()) continue;
      if (!INDEXABLE_BASENAMES.has(entry.name.toLowerCase())) continue;
    }

    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      yield* scanDirectory(fullPath, baseDir);
    } else if (entry.isFile()) {
      if (!isIndexable(fullPath)) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_BYTES) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');
        const relativePath = path.relative(baseDir, fullPath);

        yield {
          absolutePath: fullPath,
          relativePath,
          extension: path.extname(fullPath).toLowerCase(),
          language: detectLanguage(fullPath),
          hash: hashContent(content),
        };
      } catch {
        // skip unreadable / binary files
      }
    }
  }
}
