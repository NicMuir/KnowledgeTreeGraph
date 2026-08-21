import path from 'path';
import { CODE_EXTENSIONS } from '@kb/shared';
import { chunkMarkdown } from './markdown';
import { chunkCode } from './code';
import { chunkGeneric } from './generic';
import { detectChunkType } from '../detector';
import type { ParsedChunk } from '../types';

export function chunkFile(
  content: string,
  filePath: string,
  language: string | null,
): ParsedChunk[] {
  if (language === 'markdown') {
    return chunkMarkdown(content, filePath);
  }

  const chunkType = detectChunkType(filePath, language);
  const ext = path.extname(filePath).toLowerCase();
  if (language && CODE_EXTENSIONS.has(ext)) {
    // Test files are still parsed by symbol boundary (so a test file's chunks stay readable),
    // but every chunk from it is tagged 'test' rather than chunkCode's default
    // 'function'/'class'/'text_block' — otherwise nothing downstream (e.g. search ranking)
    // can tell a test chunk from an implementation chunk.
    const chunks = chunkCode(content, language, filePath, chunkType === 'test' ? 'test' : undefined);
    if (chunks.length > 0) return chunks;
  }

  return chunkGeneric(content, chunkType, language ?? undefined);
}

export { chunkMarkdown, chunkCode, chunkGeneric };
