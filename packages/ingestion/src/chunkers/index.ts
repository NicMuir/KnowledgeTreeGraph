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

  const ext = path.extname(filePath).toLowerCase();
  if (language && CODE_EXTENSIONS.has(ext)) {
    const chunks = chunkCode(content, language, filePath);
    if (chunks.length > 0) return chunks;
  }

  const chunkType = detectChunkType(filePath, language);
  return chunkGeneric(content, chunkType, language ?? undefined);
}

export { chunkMarkdown, chunkCode, chunkGeneric };
