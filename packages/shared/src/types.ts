export type ChunkType =
  | 'function'
  | 'class'
  | 'markdown_section'
  | 'text_block'
  | 'config'
  | 'migration'
  | 'test';

export type IndexingStatus = 'running' | 'completed' | 'failed';

export interface ChunkMetadata {
  symbolName?: string;
  language?: string;
  imports?: string[];
  heading?: string;
  headingLevel?: number;
  repoName?: string;
  fileName?: string;
}

export interface SearchResult {
  chunkId: string;
  repoId: string;
  repoName: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  commitSha: string;
  indexedAt: string;
  metadata: ChunkMetadata;
  score: number;
  /** chunkId of the search hit this chunk was pulled in for via the symbol tree */
  expandedFrom?: string;
}

export interface ChatRequest {
  question: string;
  repoNames?: string[];
  pathFilter?: string;
  maxResults?: number;
}

export interface ChatResponse {
  answer: string;
  sources: SearchResult[];
  retrievedChunks: number;
  model: string;
}

export interface IndexRequest {
  repoPath: string;
  repoName: string;
  branch?: string;
}

export interface IndexResponse {
  runId: string;
  repoId: string;
  status: 'started';
}

export interface RepoSummary {
  id: string;
  name: string;
  localPath: string;
  branch: string;
  currentCommitSha: string | null;
  fileCount: number;
  chunkCount: number;
  lastRun: {
    id: string;
    status: IndexingStatus;
    filesTotal: number;
    filesIndexed: number;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
  } | null;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: boolean;
  timestamp: string;
}
