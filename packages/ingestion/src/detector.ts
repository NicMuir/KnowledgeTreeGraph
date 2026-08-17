import path from 'path';
import {
  EXTENSION_TO_LANGUAGE,
  MIGRATION_PATTERNS,
  CODE_EXTENSIONS,
  CONFIG_EXTENSIONS,
} from '@kb/shared';
import type { ChunkType } from '@kb/shared';

export function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (ext === '' && base === 'dockerfile') return 'dockerfile';
  if (ext === '' && base === 'makefile') return 'makefile';
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

export function detectChunkType(filePath: string, language: string | null): ChunkType {
  const isTest =
    /\.(test|spec)\.(ts|tsx|js|jsx|py|go|rb|java)$/.test(filePath) ||
    /__(tests?|spec)__/.test(filePath);
  if (isTest) return 'test';

  for (const pattern of MIGRATION_PATTERNS) {
    if (pattern.test(filePath)) return 'migration';
  }

  if (language === 'markdown') return 'markdown_section';

  const ext = path.extname(filePath).toLowerCase();
  if (CONFIG_EXTENSIONS.has(ext)) return 'config';
  if (CODE_EXTENSIONS.has(ext)) return 'function';

  return 'text_block';
}
