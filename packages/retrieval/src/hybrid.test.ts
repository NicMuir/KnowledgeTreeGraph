// ponytail: minimal self-check for RRF merge logic
import assert from 'assert/strict';
import { test } from 'node:test';

// Inline the same constants/formula as hybrid.ts to test without a DB
const RRF_K = 10;
const MAX_RRF_SCORE = 2 / RRF_K;
const TEST_CHUNK_PENALTY = 0.85;
function rrfScore(rank: number, k = RRF_K): number {
  return 1 / (k + rank);
}
function normalize(score: number, chunkType: string): number {
  return (chunkType === 'test' ? score * TEST_CHUNK_PENALTY : score) / MAX_RRF_SCORE;
}

test('RRF: rank 1 scores higher than rank 10', () => {
  assert.ok(rrfScore(1) > rrfScore(10));
});

test('RRF: chunk appearing in both lists gets higher score', () => {
  const singleListScore = rrfScore(1);
  const bothListsScore = rrfScore(2) + rrfScore(3);
  assert.ok(bothListsScore > singleListScore);
});

test('normalized score is human-readable: best possible match scores exactly 1', () => {
  const bestPossible = rrfScore(0) + rrfScore(0); // rank 0 in both vector + FTS lists
  assert.equal(normalize(bestPossible, 'function'), 1);
});

test('normalized score: a modest single-list match is not squashed into a ~0.01-0.03 band', () => {
  const score = normalize(rrfScore(2), 'function');
  assert.ok(score > 0.1, `expected a human-readable score, got ${score}`);
});

test('test chunkType is penalized below an equally-ranked implementation chunk', () => {
  const raw = rrfScore(0);
  const implScore = normalize(raw, 'function');
  const testScore = normalize(raw, 'test');
  assert.ok(testScore < implScore);
});
