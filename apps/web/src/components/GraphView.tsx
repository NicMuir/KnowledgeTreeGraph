'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, MarkerType,
  useNodesState, useEdgesState,
  type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceRadial } from 'd3-force';
import { api } from '@/lib/api';
import { SourcePanel } from './SourcePanel';
import type { RepoSummary, SearchResult, CallGraph } from '@/lib/types';

type FileInfo = { id: string; filePath: string; language: string | null };

const LANG_COLORS: Record<string, string> = {
  typescript: '#3178c6', javascript: '#f7df1e', python: '#3572a5',
  go: '#00add8', rust: '#dea584', java: '#b07219',
  css: '#563d7c', html: '#e34c26', markdown: '#083fa1',
};
const langColor = (lang: string | null) => (lang && LANG_COLORS[lang.toLowerCase()]) ?? '#64748b';

const NODE_W_REPO = 160;
const NODE_H_REPO = 48;
const NODE_W_FILE = 200;
const NODE_H_FILE = 36;

// Turns a flat file list into folder/file nodes nested under the repo node.
function buildFileTree(repoName: string, files: FileInfo[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const seenFolders = new Set<string>();
  const edgeStyle = { stroke: '#2a2d3a', strokeWidth: 1 };

  for (const f of files) {
    const parts = f.filePath.split('/');
    const fileName = parts.pop() ?? f.filePath;
    let parentId = `repo-${repoName}`;
    let pathSoFar = '';
    for (const part of parts) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      const folderId = `folder-${repoName}-${pathSoFar}`;
      if (!seenFolders.has(folderId)) {
        seenFolders.add(folderId);
        nodes.push({
          id: folderId,
          position: { x: 0, y: 0 },
          data: { label: <span style={{ fontSize: 11 }}>📁 {part}</span> },
          style: {
            background: '#14161f', border: '1px solid #2a2d3a', borderRadius: 4,
            color: '#e2e8f0', width: NODE_W_FILE, padding: '5px 10px',
          },
        });
        edges.push({ id: `e-${parentId}-${folderId}`, source: parentId, target: folderId, style: edgeStyle });
      }
      parentId = folderId;
    }

    const fileNodeId = `file-${repoName}-${f.id}`;
    nodes.push({
      id: fileNodeId,
      position: { x: 0, y: 0 },
      data: {
        label: (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 1, background: langColor(f.language), flexShrink: 0 }} />
            <span style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.filePath}>
              {fileName}
            </span>
          </div>
        ),
      },
      style: {
        background: '#0f1117', border: '1px solid #2a2d3a', borderRadius: 4,
        color: '#e2e8f0', width: NODE_W_FILE, cursor: 'pointer', padding: '6px 10px', fontSize: 11,
      },
    });
    edges.push({ id: `e-${parentId}-${fileNodeId}`, source: parentId, target: fileNodeId, style: edgeStyle });
  }

  return { nodes, edges };
}

function callNodeId(repoName: string, cgId: string): string {
  return `call-${repoName}::${encodeURIComponent(cgId)}`;
}

// Turns a per-repo call graph (functions + call edges) into nodes tied to the
// repo node, plus accent-colored arrows for the actual caller -> callee calls.
function buildCallGraphView(repoName: string, graph: CallGraph): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: callNodeId(repoName, n.id),
    position: { x: 0, y: 0 },
    data: {
      label: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 1, background: langColor(n.language), flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {n.symbolName}()
            </span>
          </div>
          <span style={{ fontSize: 9, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n.filePath}>
            {n.filePath.split('/').pop()}
          </span>
        </div>
      ),
    },
    style: {
      background: '#0f1117', border: '1px solid #2a2d3a', borderRadius: 4,
      color: '#e2e8f0', width: NODE_W_FILE, cursor: 'pointer', padding: '6px 10px',
    },
  }));

  const edges: Edge[] = graph.nodes.map((n) => ({
    id: `e-repo-${repoName}-${n.id}`,
    source: `repo-${repoName}`,
    target: callNodeId(repoName, n.id),
    style: { stroke: '#2a2d3a', strokeWidth: 1 },
  }));

  for (const e of graph.edges) {
    edges.push({
      id: `ce-${repoName}-${e.caller}->${e.callee}`,
      source: callNodeId(repoName, e.caller),
      target: callNodeId(repoName, e.callee),
      style: { stroke: '#6366f1', strokeWidth: 1.2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 14, height: 14 },
    });
  }

  return { nodes, edges };
}

// Radial force layout: repos pinned at center, folders/files pushed to concentric
// rings and spread apart by mutual repulsion — a "point cloud" instead of a tree.
const RING_RADIUS: Record<string, number> = { repo: 0, folder: 260, file: 480 };
const kindOf = (id: string) => (id.startsWith('repo-') ? 'repo' : id.startsWith('folder-') ? 'folder' : 'file');
const sizeFor = (id: string) => (kindOf(id) === 'repo' ? NODE_W_REPO : NODE_W_FILE);

function layout(nodes: Node[], edges: Edge[]): Node[] {
  const simNodes = nodes.map((n) => ({ id: n.id, x: Math.random() * 300 - 150, y: Math.random() * 300 - 150 }));
  const simLinks = edges.map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation(simNodes as never[])
    .force('charge', forceManyBody().strength(-150))
    .force('link', forceLink(simLinks as never[]).id((d: any) => d.id).distance(70).strength(0.4))
    .force('collide', forceCollide().radius((d: any) => sizeFor(d.id) / 1.5))
    .force('radial', forceRadial((d: any) => RING_RADIUS[kindOf(d.id)], 0, 0).strength(0.9))
    .force('center', forceCenter(0, 0))
    .stop();

  for (let i = 0; i < 300; i++) sim.tick();

  const posById = new Map(simNodes.map((n) => [n.id, n]));
  return nodes.map((n) => {
    const pos = posById.get(n.id)!;
    const w = sizeFor(n.id);
    const h = kindOf(n.id) === 'repo' ? NODE_H_REPO : NODE_H_FILE;
    return { ...n, position: { x: pos.x - w / 2, y: pos.y - h / 2 } };
  });
}

type Detail =
  | { kind: 'file'; repoName: string; filePath: string; language: string | null; chunks: SearchResult[] | null }
  | { kind: 'symbol'; repoName: string; filePath: string; symbolName: string; startLine: number };

export function GraphView() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [mode, setMode] = useState<'files' | 'calls'>('files');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filesCache, setFilesCache] = useState<Map<string, FileInfo[]>>(new Map());
  const [callGraphCache, setCallGraphCache] = useState<Map<string, CallGraph>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => {
    api.getRepos().then(setRepos).catch(console.error);
  }, []);

  // Lazily fetch whatever the current mode needs for each expanded repo
  useEffect(() => {
    for (const repoName of expanded) {
      const key = `${mode}:${repoName}`;
      if (loading.has(key)) continue;

      if (mode === 'files' && !filesCache.has(repoName)) {
        setLoading((prev) => new Set(prev).add(key));
        api.getFiles(repoName)
          .then((files) => setFilesCache((prev) => new Map(prev).set(repoName, files)))
          .catch(console.error)
          .finally(() => setLoading((prev) => { const n = new Set(prev); n.delete(key); return n; }));
      } else if (mode === 'calls' && !callGraphCache.has(repoName)) {
        setLoading((prev) => new Set(prev).add(key));
        api.getCallGraph(repoName)
          .then((graph) => setCallGraphCache((prev) => new Map(prev).set(repoName, graph)))
          .catch(console.error)
          .finally(() => setLoading((prev) => { const n = new Set(prev); n.delete(key); return n; }));
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, mode]);

  // Recompute graph whenever repos/expanded/caches/mode change
  useEffect(() => {
    const rawNodes: Node[] = [];
    const rawEdges: Edge[] = [];

    for (const repo of repos) {
      const status = repo.lastRun?.status ?? 'never';
      const statusColor = status === 'completed' ? '#22c55e' : status === 'running' ? '#eab308' : status === 'failed' ? '#ef4444' : '#64748b';
      rawNodes.push({
        id: `repo-${repo.name}`,
        position: { x: 0, y: 0 },
        data: {
          label: (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
              <span style={{ fontWeight: 600, fontSize: 13 }}>{repo.name}</span>
              <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 'auto' }}>
                {expanded.has(repo.name) ? '▲' : '▼'}
              </span>
            </div>
          ),
        },
        style: {
          background: '#1a1d27',
          border: `2px solid ${expanded.has(repo.name) ? '#6366f1' : '#2a2d3a'}`,
          borderRadius: 8,
          color: '#e2e8f0',
          width: NODE_W_REPO,
          cursor: 'pointer',
          padding: '8px 12px',
        },
      });

      if (expanded.has(repo.name)) {
        if (mode === 'files') {
          const files = filesCache.get(repo.name) ?? [];
          const tree = buildFileTree(repo.name, files);
          rawNodes.push(...tree.nodes);
          rawEdges.push(...tree.edges);
        } else {
          const graph = callGraphCache.get(repo.name);
          if (graph) {
            const view = buildCallGraphView(repo.name, graph);
            rawNodes.push(...view.nodes);
            rawEdges.push(...view.edges);
          }
        }
      }
    }

    const laid = layout(rawNodes, rawEdges);
    setNodes(laid);
    setEdges(rawEdges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, expanded, filesCache, callGraphCache, mode]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.id.startsWith('folder-')) return;

    if (node.id.startsWith('call-')) {
      const sep = node.id.indexOf('::');
      const repoName = node.id.slice('call-'.length, sep);
      const cgId = decodeURIComponent(node.id.slice(sep + 2));
      const symbol = callGraphCache.get(repoName)?.nodes.find((n) => n.id === cgId);
      if (symbol) {
        setDetail({ kind: 'symbol', repoName, filePath: symbol.filePath, symbolName: symbol.symbolName, startLine: symbol.startLine });
      }
      return;
    }

    if (!node.id.startsWith('repo-')) {
      // file node — show detail and fetch its chunks
      const [, repoName, ...rest] = node.id.split('-');
      const files = filesCache.get(repoName) ?? [];
      // node.id = `file-${repoName}-${f.id}`, rest = [id]
      const fileId = rest.join('-');
      const file = files.find((f) => f.id === fileId);
      if (!file) return;

      setDetail({ kind: 'file', repoName, filePath: file.filePath, language: file.language, chunks: null });
      api.getChunks(repoName, fileId)
        .then((chunks) => setDetail((d) => (d?.kind === 'file' && d.filePath === file.filePath ? { ...d, chunks } : d)))
        .catch(console.error);
      return;
    }

    const repoName = node.id.slice('repo-'.length);

    // Toggle expand — data fetch is handled by the effect above
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(repoName)) {
        next.delete(repoName);
      } else {
        next.add(repoName);
      }
      return next;
    });
  }, [filesCache, callGraphCache]);

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
      >
        <Background gap={20} size={1} />
        <Controls />
        <MiniMap
          nodeColor={(n) => n.id.startsWith('repo-') ? '#6366f1' : '#2a2d3a'}
          maskColor="rgba(15,17,23,0.7)"
        />
      </ReactFlow>

      {/* Legend */}
      <div style={{
        position: 'absolute', top: 12, right: 12, background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px',
        fontSize: 11, color: 'var(--text-muted)', zIndex: 10,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          {(['files', 'calls'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                flex: 1, fontSize: 10, textTransform: 'capitalize', padding: '3px 8px', cursor: 'pointer',
                borderRadius: 4, border: '1px solid var(--border)',
                background: mode === m ? 'rgba(99,102,241,0.2)' : 'transparent',
                color: mode === m ? 'var(--accent)' : 'var(--text-muted)',
              }}
            >
              {m === 'calls' ? 'Call graph' : m}
            </button>
          ))}
        </div>
        <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>Legend</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} /> Indexed
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#eab308' }} /> Running
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444' }} /> Failed
        </div>
        {mode === 'calls' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 14, height: 2, background: '#6366f1' }} /> Calls
          </div>
        )}
        <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>Click repo to expand</div>
      </div>

      {/* File detail drawer */}
      {detail && (
        <div style={{
          position: 'absolute', bottom: 12, left: 12, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 6, padding: '10px 14px',
          fontSize: 12, zIndex: 10, width: 380, maxHeight: '70vh', overflowY: 'auto',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{detail.kind === 'symbol' ? 'Function' : 'File'}</span>
            <button
              onClick={() => setDetail(null)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14 }}
            >✕</button>
          </div>
          {detail.kind === 'symbol' ? (
            <>
              <div style={{ color: 'var(--accent)' }}>{detail.symbolName}()</div>
              <div style={{ color: 'var(--text-muted)', marginTop: 4, wordBreak: 'break-all' }}>
                {detail.repoName} · {detail.filePath}:{detail.startLine + 1}
              </div>
            </>
          ) : (
            <>
              <div style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{detail.filePath}</div>
              <div style={{ color: 'var(--text-muted)', marginTop: 4, marginBottom: 8 }}>
                {detail.repoName} · {detail.language ?? 'unknown'}
              </div>
              {detail.chunks === null && <div style={{ color: 'var(--text-muted)' }}>Loading chunks…</div>}
              {detail.chunks && <SourcePanel sources={detail.chunks} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}
