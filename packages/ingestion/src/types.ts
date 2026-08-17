import type { ChunkType, ChunkMetadata } from '@kb/shared';

export interface ParsedChunk {
  content: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  metadata: ChunkMetadata;
}

export interface FileInfo {
  absolutePath: string;
  relativePath: string;
  extension: string;
  language: string | null;
  hash: string;
}
