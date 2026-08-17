'use client';

import { useState } from 'react';
import { ChatInterface } from '@/components/ChatInterface';
import { SourcePanel } from '@/components/SourcePanel';
import { GraphView } from '@/components/GraphView';
import { StatsView } from '@/components/StatsView';
import type { ChatMessage, SearchResult } from '@/lib/types';

type Tab = 'graph' | 'chat' | 'stats';

export default function Home() {
  const [tab, setTab] = useState<Tab>('graph');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeSources, setActiveSources] = useState<SearchResult[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);

  function handleNewAnswer(msg: ChatMessage) {
    setMessages((prev) => [...prev, msg]);
    if (msg.sources && msg.sources.length > 0) setActiveSources(msg.sources);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Top nav */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 20px', height: 48, flexShrink: 0,
        borderBottom: '1px solid var(--border)', background: 'var(--surface)',
      }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--accent)', marginRight: 12 }}>KB</span>
        {(['graph', 'chat', 'stats'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: tab === t ? 'rgba(99,102,241,0.15)' : 'none',
              border: 'none',
              borderRadius: 6,
              color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontWeight: tab === t ? 600 : 400,
              fontSize: 13,
              padding: '5px 14px',
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </header>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {tab === 'graph' && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <GraphView />
          </div>
        )}

        {tab === 'chat' && (
          <>
            <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <ChatInterface
                messages={messages}
                selectedRepos={selectedRepos}
                onNewAnswer={handleNewAnswer}
                onUserMessage={(content) =>
                  setMessages((prev) => [...prev, { role: 'user', content }])
                }
              />
            </main>
            {activeSources.length > 0 && (
              <aside style={{
                width: 340, flexShrink: 0,
                borderLeft: '1px solid var(--border)',
                background: 'var(--surface)', overflowY: 'auto',
              }}>
                <SourcePanel sources={activeSources} />
              </aside>
            )}
          </>
        )}

        {tab === 'stats' && (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <StatsView />
          </div>
        )}
      </div>
    </div>
  );
}
