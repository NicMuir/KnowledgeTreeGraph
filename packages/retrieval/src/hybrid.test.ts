// ponytail: minimal self-check for RRF merge logic
import assert from 'assert/strict';
import { test } from 'node:test';

// Inline the RRF function to test without DB
function rrfScore(rank: number, k = 60): number {
  return 1 / (k + rank);
}

test('RRF: rank 1 scores higher than rank 10', () => {
  assert.ok(rrfScore(1) > rrfScore(10));
});

test('RRF: chunk appearing in both lists gets higher score', () => {
  const singleListScore = rrfScore(1);
  const bothListsScore = rrfScore(2) + rrfScore(3);
  assert.ok(bothListsScore > singleListScore);
});
