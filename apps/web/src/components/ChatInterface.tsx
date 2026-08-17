'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ChatMessage } from '@/lib/types';

interface Props {
  messages: ChatMessage[];
  selectedRepos: string[];
  onNewAnswer: (msg: ChatMessage) => void;
  onUserMessage: (content: string) => void;
}

export function ChatInterface({ messages, selectedRepos, onNewAnswer, onUserMessage }: Props) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || loading) return;

    setInput('');
    onUserMessage(q);
    setLoading(true);

    try {
      const res = await api.chat(q, selectedRepos.length > 0 ? selectedRepos : undefined);
      onNewAnswer({ role: 'assistant', content: res.answer, sources: res.sources });
    } catch (err) {
      onNewAnswer({
        role: 'assistant',
        content: `Error: ${String(err)}`,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 600 }}>KB Chat</span>
        {selectedRepos.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--border)', borderRadius: 10, padding: '2px 8px' }}>
            {selectedRepos.join(', ')}
          </span>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: 60 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
            <div>Ask anything about your indexed repositories.</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>Filter by repo using the sidebar.</div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}

        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', marginTop: 8 }}>
            <Spinner /> Searching and reasoning...
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your codebase..."
          disabled={loading}
          style={{
            flex: 1,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '8px 12px',
            color: 'var(--text)',
            fontSize: 14,
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          style={{
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '8px 16px',
            cursor: loading ? 'wait' : 'pointer',
            fontWeight: 500,
            opacity: loading || !input.trim() ? 0.6 : 1,
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div style={{
      marginBottom: 16,
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        maxWidth: '85%',
        background: isUser ? 'var(--accent)' : 'var(--surface)',
        border: isUser ? 'none' : '1px solid var(--border)',
        borderRadius: 8,
        padding: '10px 14px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {message.content}
      </div>
      {message.sources && message.sources.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
          {message.sources.length} source{message.sources.length !== 1 ? 's' : ''} cited
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ animation: 'spin 1s linear infinite' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="20" strokeDashoffset="5" />
    </svg>
  );
}
