import type { ParsedChunk } from '../types';
import { MAX_CHUNK_TOKENS } from '@kb/shared';
import { countTokens, splitByTokens } from '../tokenizer';

interface Section {
  heading: string;
  level: number;
  startLine: number;
  lines: string[];
}

export function chunkMarkdown(content: string, _filePath: string): ParsedChunk[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let current: Section = { heading: 'preamble', level: 0, startLine: 0, lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(#{1,6})\s+(.+)/);
    if (m) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      current = { heading: m[2].trim(), level: m[1].length, startLine: i, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some((l) => l.trim())) sections.push(current);

  const chunks: ParsedChunk[] = [];
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    if (!text) continue;

    if (countTokens(text) > MAX_CHUNK_TOKENS) {
      splitByTokens(text, MAX_CHUNK_TOKENS).forEach((sub, i) => {
        chunks.push({
          content: sub,
          startLine: section.startLine + i,
          endLine: section.startLine + section.lines.length,
          chunkType: 'markdown_section',
          metadata: { heading: section.heading, headingLevel: section.level },
        });
      });
    } else {
      chunks.push({
        content: text,
        startLine: section.startLine,
        endLine: section.startLine + section.lines.length,
        chunkType: 'markdown_section',
        metadata: { heading: section.heading, headingLevel: section.level },
      });
    }
  }
  return chunks;
}

