'use client';
import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { api } from '@/lib/api';
import type { RepoSummary } from '@/lib/types';

const STATUS_COLOR: Record<string, string> = {
  completed: '#22c55e',
  running: '#eab308',
  failed: '#ef4444',
};

const CHART_COLORS = ['#6366f1', '#22c55e', '#eab308', '#ef4444', '#3178c6', '#f7df1e', '#3572a5', '#00add8'];

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
      padding: '16px 20px', flex: 1, minWidth: 140,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text)', margin: '4px 0' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

export function StatsView() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getRepos()
      .then(setRepos)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading stats...</div>;
  }

  const totalFiles = repos.reduce((s, r) => s + r.fileCount, 0);
  const totalChunks = repos.reduce((s, r) => s + r.chunkCount, 0);
  const lastIndexed = repos
    .flatMap((r) => (r.lastRun?.completedAt ? [new Date(r.lastRun.completedAt)] : []))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  // Bar chart data: files & chunks per repo
  const barData = repos.map((r) => ({
    name: r.name.length > 12 ? r.name.slice(0, 12) + '…' : r.name,
    files: r.fileCount,
    chunks: r.chunkCount,
  }));

  // Pie: status breakdown
  const statusCounts = repos.reduce<Record<string, number>>((acc, r) => {
    const s = r.lastRun?.status ?? 'never';
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const pieData = Object.entries(statusCounts).map(([name, value]) => ({ name, value }));

  return (
    <div style={{ padding: 24, overflowY: 'auto', height: '100%' }}>
      {/* Stat cards */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 28 }}>
        <StatCard label="Repositories" value={repos.length} />
        <StatCard label="Total Files" value={totalFiles.toLocaleString()} />
        <StatCard label="Total Chunks" value={totalChunks.toLocaleString()} />
        <StatCard
          label="Last Indexed"
          value={lastIndexed ? lastIndexed.toLocaleDateString() : '—'}
          sub={lastIndexed ? lastIndexed.toLocaleTimeString() : undefined}
        />
      </div>

      {repos.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', paddingTop: 40 }}>
          No repos indexed yet.
        </div>
      ) : (
        <>
          {/* Charts row */}
          <div style={{ display: 'flex', gap: 24, marginBottom: 28, flexWrap: 'wrap' }}>
            {/* Files / Chunks per repo */}
            <div style={{ flex: 2, minWidth: 300, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 20px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 16, color: 'var(--text)' }}>Files &amp; Chunks per Repo</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={barData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: '#e2e8f0' }}
                    cursor={{ fill: 'rgba(99,102,241,0.1)' }}
                  />
                  <Bar dataKey="files" name="Files" fill="#6366f1" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="chunks" name="Chunks" fill="#22c55e" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Status pie */}
            <div style={{ flex: 1, minWidth: 220, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 20px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 16, color: 'var(--text)' }}>Indexing Status</div>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>
                    {pieData.map((entry, i) => (
                      <Cell key={entry.name} fill={STATUS_COLOR[entry.name] ?? CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', borderRadius: 6, fontSize: 12 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Repo table */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'rgba(99,102,241,0.08)' }}>
                  {['Repo', 'Branch', 'Files', 'Chunks', 'Status', 'Commit'].map((h) => (
                    <th key={h} style={{ padding: '10px 16px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {repos.map((r, i) => {
                  const status = r.lastRun?.status ?? 'never';
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                      <td style={{ padding: '10px 16px', fontWeight: 600, color: 'var(--text)' }}>{r.name}</td>
                      <td style={{ padding: '10px 16px', color: 'var(--text-muted)' }}>{r.branch}</td>
                      <td style={{ padding: '10px 16px', color: 'var(--text)' }}>{r.fileCount.toLocaleString()}</td>
                      <td style={{ padding: '10px 16px', color: 'var(--text)' }}>{r.chunkCount.toLocaleString()}</td>
                      <td style={{ padding: '10px 16px' }}>
                        <span style={{ background: `${STATUS_COLOR[status] ?? '#64748b'}22`, color: STATUS_COLOR[status] ?? '#64748b', borderRadius: 10, padding: '2px 8px', fontSize: 11 }}>
                          {status}
                        </span>
                      </td>
                      <td style={{ padding: '10px 16px', color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11 }}>
                        {r.currentCommitSha ? r.currentCommitSha.slice(0, 8) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
