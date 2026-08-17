import type { ParsedChunk } from '../types';
import { MAX_CHUNK_TOKENS } from '@kb/shared';
import type { ChunkType } from '@kb/shared';
import { countTokens } from '../tokenizer';

export function chunkGeneric(
  content: string,
  chunkType: ChunkType,
  language?: string,
): ParsedChunk[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  if (countTokens(trimmed) <= MAX_CHUNK_TOKENS) {
    return [{
      content: trimmed,
      startLine: 0,
      endLine: content.split('\n').length,
      chunkType,
      metadata: { language },
    }];
  }

  const lines = content.split('\n');
  const chunks: ParsedChunk[] = [];
  let acc: string[] = [];
  let start = 0;

  for (let i = 0; i < lines.length; i++) {
    acc.push(lines[i]);
    if (countTokens(acc.join('\n')) >= MAX_CHUNK_TOKENS) {
      const text = acc.join('\n').trim();
      if (text) chunks.push({ content: text, startLine: start, endLine: i, chunkType, metadata: { language } });
      start = i;
      acc = [lines[i]];
    }
  }

  const last = acc.join('\n').trim();
  if (last) chunks.push({ content: last, startLine: start, endLine: lines.length, chunkType, metadata: { language } });

  return chunks;
}
