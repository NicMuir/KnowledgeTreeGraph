import type { SearchResult } from '@kb/shared';

export interface SearchOptions {
  query: string;
  repoNames?: string[];
  pathFilter?: string;
  language?: string;
  chunkType?: string;
  limit?: number;
}

export type { SearchResult };
