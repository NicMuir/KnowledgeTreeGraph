export interface SearchResult {
  chunkId: string;
  repoId: string;
  repoName: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  chunkType: string;
  commitSha: string;
  indexedAt: string;
  metadata: {
    symbolName?: string;
    language?: string;
    heading?: string;
    headingLevel?: number;
    imports?: string[];
  };
  score: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: SearchResult[];
}

export interface CallGraphNode {
  id: string;
  symbolName: string;
  filePath: string;
  language: string;
  startLine: number;
  kind: 'function' | 'method';
}

export interface CallGraphEdge {
  caller: string;
  callee: string;
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
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
    status: 'running' | 'completed' | 'failed';
    filesTotal: number;
    filesIndexed: number;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
  } | null;
}
