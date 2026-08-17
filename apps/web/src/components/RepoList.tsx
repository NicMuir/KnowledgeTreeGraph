'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import type { RepoSummary } from '@/lib/types';

interface Props {
  selectedRepos: string[];
  onToggleRepo: (name: string) => void;
}

export function RepoList({ selectedRepos, onToggleRepo }: Props) {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [indexing, setIndexing] = useState(false);
  const [form, setForm] = useState({ repoPath: '', repoName: '', branch: 'main' });
  const [showForm, setShowForm] = useState(false);

  const loadRepos = useCallback(async () => {
    try {
      const data = await api.getRepos();
      setRepos(data);
    } catch {
      // silently ignore on polling
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRepos();
    const interval = setInterval(() => void loadRepos(), 5000);
    return () => clearInterval(interval);
  }, [loadRepos]);

  async function handleIndex(e: React.FormEvent) {
    e.preventDefault();
    if (!form.repoPath || !form.repoName) return;
    setIndexing(true);
    try {
      await api.indexRepo(form.repoPath, form.repoName, form.branch || undefined);
      setShowForm(false);
      setForm({ repoPath: '', repoName: '', branch: 'main' });
      await loadRepos();
    } catch (err) {
      alert(`Failed to start indexing: ${String(err)}`);
    } finally {
      setIndexing(false);
    }
  }

  const statusColor = (status?: string) => {
    if (status === 'completed') return 'var(--green)';
    if (status === 'failed') return 'var(--red)';
    if (status === 'running') return 'var(--yellow)';
    return 'var(--text-muted)';
  };

  return (
    <div style={{ padding: '12px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Repositories
        </span>
        <button
          onClick={() => setShowForm((v) => !v)}
          style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12 }}
        >
          + Add
        </button>
      </div>

      {showForm && (
        <form onSubmit={(e) => void handleIndex(e)} style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            placeholder="Repo path (absolute)"
            value={form.repoPath}
            onChange={(e) => setForm((f) => ({ ...f, repoPath: e.target.value }))}
            style={inputStyle}
          />
          <input
            placeholder="Repo name"
            value={form.repoName}
            onChange={(e) => setForm((f) => ({ ...f, repoName: e.target.value }))}
            style={inputStyle}
          />
          <input
            placeholder="Branch (default: main)"
            value={form.branch}
            onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
            style={inputStyle}
          />
          <button
            type="submit"
            disabled={indexing}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, padding: '5px', cursor: 'pointer', fontSize: 12 }}
          >
            {indexing ? 'Starting...' : 'Index repo'}
          </button>
        </form>
      )}

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading...</div>}

      {repos.map((repo) => {
        const selected = selectedRepos.includes(repo.name);
        const status = repo.lastRun?.status;
        const progress = status === 'running' && repo.lastRun
          ? `${repo.lastRun.filesIndexed}/${repo.lastRun.filesTotal}`
          : null;

        return (
          <button
            key={repo.id}
            onClick={() => onToggleRepo(repo.name)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              background: selected ? 'rgba(99,102,241,0.15)' : 'transparent',
              border: selected ? '1px solid var(--accent)' : '1px solid transparent',
              borderRadius: 6,
              padding: '8px 10px',
              marginBottom: 6,
              cursor: 'pointer',
              color: 'var(--text)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(status), flexShrink: 0 }} />
              <span style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {repo.name}
              </span>
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {repo.fileCount} files · {repo.chunkCount} chunks
              {progress && ` · indexing ${progress}`}
            </div>
            {repo.currentCommitSha && (
              <div style={{ color: 'var(--text-muted)', fontSize: 10, fontFamily: 'monospace', marginTop: 2 }}>
                {repo.branch}@{repo.currentCommitSha}
              </div>
            )}
          </button>
        );
      })}

      {!loading && repos.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', marginTop: 20 }}>
          No repos indexed yet.
          <br />Click + Add to start.
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '5px 8px',
  color: 'var(--text)',
  fontSize: 12,
  width: '100%',
};
