// ponytail: minimal self-check, run with: node --test dist/chunkers/markdown.test.js
import assert from 'assert/strict';
import { test } from 'node:test';
import { chunkMarkdown } from './markdown';

test('splits on headings', () => {
  const md = '# Title\n\nSome intro text.\n\n## Section A\n\nContent A.\n\n## Section B\n\nContent B.';
  const chunks = chunkMarkdown(md, 'README.md');
  assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
  assert.ok(chunks.some((c) => c.metadata.heading === 'Title'));
  assert.ok(chunks.some((c) => c.metadata.heading === 'Section A'));
});

test('handles file with no headings', () => {
  const md = 'Just some text\nwith no headings at all.';
  const chunks = chunkMarkdown(md, 'notes.md');
  assert.equal(chunks.length, 1);
});
