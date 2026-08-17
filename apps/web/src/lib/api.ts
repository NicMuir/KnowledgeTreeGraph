const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getRepos: () => request<import('./types').RepoSummary[]>('/repos'),

  indexRepo: (repoPath: string, repoName: string, branch?: string) =>
    request<{ runId: string; repoId: string; status: string }>('/index', {
      method: 'POST',
      body: JSON.stringify({ repoPath, repoName, branch }),
    }),

  chat: (question: string, repoNames?: string[], pathFilter?: string, maxResults?: number) =>
    request<{ answer: string; sources: import('./types').SearchResult[]; retrievedChunks: number; model: string }>(
      '/chat',
      { method: 'POST', body: JSON.stringify({ question, repoNames, pathFilter, maxResults }) },
    ),

  search: (q: string, repo?: string, lang?: string, limit = 20) =>
    request<{ results: import('./types').SearchResult[]; total: number }>(
      `/search?q=${encodeURIComponent(q)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}&limit=${limit}`,
    ),

  health: () => request<{ status: string; db: boolean; timestamp: string }>('/health'),

  getFiles: (repo: string) =>
    request<Array<{ id: string; filePath: string; language: string | null; commitSha: string; indexedAt: string }>>(
      `/repos/${encodeURIComponent(repo)}/files`,
    ),

  getChunks: (repo: string, fileId: string) =>
    request<import('./types').SearchResult[]>(
      `/repos/${encodeURIComponent(repo)}/files/${encodeURIComponent(fileId)}/chunks`,
    ),

  getCallGraph: (repo: string) =>
    request<import('./types').CallGraph>(`/repos/${encodeURIComponent(repo)}/callgraph`),
};
