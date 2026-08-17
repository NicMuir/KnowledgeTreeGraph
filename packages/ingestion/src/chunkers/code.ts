import type { ParsedChunk } from '../types';
import { MAX_CHUNK_TOKENS, CHUNK_OVERLAP_LINES } from '@kb/shared';
import { countTokens } from '../tokenizer';

// Top-level symbol boundary patterns per language
const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^(export\s+)?(default\s+)?(async\s+)?function[\s*]\w+/,
    /^(export\s+)?(abstract\s+)?class\s+\w+/,
    /^(export\s+)?const\s+\w+\s*[=:]/,
    /^(export\s+)?interface\s+\w+/,
    /^(export\s+)?type\s+\w+\s*=/,
    /^(export\s+)?enum\s+\w+/,
  ],
  javascript: [
    /^(export\s+)?(default\s+)?(async\s+)?function[\s*]\w+/,
    /^(export\s+)?class\s+\w+/,
    /^(export\s+)?const\s+\w+\s*=/,
    /^module\.exports\s*=/,
  ],
  python: [
    /^(async\s+)?def\s+\w+/,
    /^class\s+\w+/,
  ],
  go: [
    /^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/,
    /^type\s+\w+\s+(struct|interface)/,
  ],
  rust: [
    /^(pub(\(.*?\))?\s+)?(async\s+)?fn\s+\w+/,
    /^(pub(\(.*?\))?\s+)?struct\s+\w+/,
    /^(pub(\(.*?\))?\s+)?impl(\s+\w+\s+for)?\s+\w+/,
    /^(pub(\(.*?\))?\s+)?trait\s+\w+/,
    /^(pub(\(.*?\))?\s+)?enum\s+\w+/,
  ],
  java: [
    /^\s*(public|private|protected|static|final|abstract|synchronized|\s)+[\w<>\[\]]+\s+\w+\s*\(/,
    /^\s*(public|private|protected)?\s*(abstract\s+)?class\s+\w+/,
    /^\s*(public\s+)?interface\s+\w+/,
    /^\s*(public\s+)?enum\s+\w+/,
  ],
  php: [
    /^(abstract\s+|final\s+)?class\s+\w+/,
    /^(interface|trait|enum)\s+\w+/,
    /^(public|private|protected|static|final|abstract)[\w\s]*function\s+\w+/,
    /^function\s+\w+/,
  ],
};

export function chunkCode(content: string, language: string, _filePath: string): ParsedChunk[] {
  const lines = content.split('\n');
  const patterns = SYMBOL_PATTERNS[language] ?? [];

  if (patterns.length === 0) return chunkBySize(lines, language);

  const imports = extractImports(lines, language);
  const boundaries: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (patterns.some((p) => p.test(trimmed))) boundaries.push(i);
  }

  if (boundaries.length === 0) return chunkBySize(lines, language);

  const chunks: ParsedChunk[] = [];

  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b];
    const end = boundaries[b + 1] ?? lines.length;
    const symbolLines = lines.slice(start, end);
    const symbolName = extractSymbolName(lines[start]);

    // Prepend a few lines of overlap from previous chunk for context
    const ctxStart = Math.max(0, start - CHUNK_OVERLAP_LINES);
    const ctxLines = lines.slice(ctxStart, start);
    const chunkContent = [...ctxLines, ...symbolLines].join('\n').trim();

    if (countTokens(chunkContent) > MAX_CHUNK_TOKENS) {
      const subs = chunkBySize(symbolLines, language, start);
      chunks.push(...subs.map((c) => ({
        ...c,
        metadata: { ...c.metadata, symbolName, imports: imports.slice(0, 10) },
      })));
    } else {
      const chunkType = language === 'java' && /class|interface|enum/.test(lines[start])
        ? 'class' as const
        : 'function' as const;
      chunks.push({
        content: chunkContent,
        startLine: ctxStart,
        endLine: end,
        chunkType,
        metadata: { symbolName, language, imports: imports.slice(0, 10) },
      });
    }
  }

  return chunks;
}

function extractImports(lines: string[], language: string): string[] {
  const patterns: Record<string, RegExp> = {
    typescript: /^(import|require)\s/,
    javascript: /^(import|require)\s/,
    python: /^(import|from)\s/,
    go: /^import\s/,
    rust: /^use\s/,
    java: /^import\s/,
    php: /^use\s/,
  };
  const p = patterns[language];
  if (!p) return [];
  return lines.filter((l) => p.test(l.trim())).slice(0, 20).map((l) => l.trim());
}

function extractSymbolName(line: string): string | undefined {
  const m =
    line.match(/(?:function|class|def|fn|func)\s+(\w+)/) ??
    line.match(/const\s+(\w+)\s*[=:]/) ??
    line.match(/(?:interface|type|enum|struct|trait|impl)\s+(\w+)/);
  return m?.[1];
}

function chunkBySize(lines: string[], language: string, lineOffset = 0): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let acc: string[] = [];
  let start = 0;

  for (let i = 0; i < lines.length; i++) {
    acc.push(lines[i]);
    if (countTokens(acc.join('\n')) >= MAX_CHUNK_TOKENS) {
      const text = acc.join('\n').trim();
      if (text) {
        chunks.push({
          content: text,
          startLine: lineOffset + start,
          endLine: lineOffset + i,
          chunkType: 'text_block',
          metadata: { language },
        });
      }
      // overlap: retain last CHUNK_OVERLAP_LINES lines
      const overlapStart = Math.max(0, i - CHUNK_OVERLAP_LINES + 1);
      start = overlapStart;
      acc = lines.slice(overlapStart, i + 1);
    }
  }

  const remaining = acc.join('\n').trim();
  if (remaining) {
    chunks.push({
      content: remaining,
      startLine: lineOffset + start,
      endLine: lineOffset + lines.length,
      chunkType: 'text_block',
      metadata: { language },
    });
  }
  return chunks;
}
