'use client';

import type { SearchResult } from '@/lib/types';

interface Props {
  sources: SearchResult[];
}

export function SourcePanel({ sources }: Props) {
  return (
    <div style={{ padding: '12px 10px' }}>
      <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
        Sources ({sources.length})
      </div>
      {sources.map((source, i) => (
        <SourceCard key={source.chunkId} source={source} index={i + 1} />
      ))}
    </div>
  );
}

function SourceCard({ source, index }: { source: SearchResult; index: number }) {
  const ageHours = (Date.now() - new Date(source.indexedAt).getTime()) / 3_600_000;
  const isStale = ageHours > 48;

  const typeColors: Record<string, string> = {
    function: '#6366f1',
    class: '#8b5cf6',
    markdown_section: '#10b981',
    config: '#f59e0b',
    migration: '#ef4444',
    test: '#06b6d4',
    text_block: '#64748b',
  };

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 6,
      marginBottom: 10,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '8px 10px', background: 'rgba(255,255,255,0.03)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 600 }}>
            [{index}]
          </span>
          <span style={{
            fontSize: 10,
            background: typeColors[source.chunkType] ?? '#64748b',
            color: '#fff',
            borderRadius: 3,
            padding: '1px 5px',
          }}>
            {source.chunkType}
          </span>
          {isStale && (
            <span style={{ fontSize: 10, color: 'var(--yellow)' }}>
              ⚠ stale
            </span>
          )}
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text)', wordBreak: 'break-all' }}>
          {source.repoName}/{source.filePath}:{source.startLine}–{source.endLine}
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          {source.commitSha}
        </div>
        {source.metadata.symbolName && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {source.metadata.symbolName}
          </div>
        )}
      </div>

      {/* Code preview */}
      <pre style={{
        margin: 0,
        padding: '8px 10px',
        fontSize: 11,
        fontFamily: 'monospace',
        overflowX: 'auto',
        background: 'var(--bg)',
        color: 'var(--text)',
        maxHeight: 200,
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {source.content.slice(0, 800)}{source.content.length > 800 ? '\n...' : ''}
      </pre>
    </div>
  );
}
