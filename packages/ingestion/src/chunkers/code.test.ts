// ponytail: minimal self-check, run with: node --test dist/chunkers/code.test.js
import assert from 'assert/strict';
import { test } from 'node:test';
import { chunkFile } from './index';

test('a spec/test file is tagged chunkType "test", not "function"/"text_block"', () => {
  const src = `import { roundVat } from './VatRounding';

describe('VAT calculation rounding', () => {
  it('rounds up at half cent', () => {
    expect(roundVat(1.005)).toBeCloseTo(1.01);
  });
});
`;
  const chunks = chunkFile(src, 'src/vat/VatRounding.test.ts', 'typescript');
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => c.chunkType === 'test'), `expected all chunks tagged 'test', got ${chunks.map((c) => c.chunkType)}`);
});

test('an implementation file keeps its normal function/class chunkType', () => {
  const src = `export function roundVat(amount: number): number {
  return Math.round(amount * 100) / 100;
}
`;
  const chunks = chunkFile(src, 'src/vat/VatRounding.ts', 'typescript');
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => c.chunkType === 'function'));
});
