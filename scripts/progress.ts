const BLUE = '\x1b[34m';
const WHITE = '\x1b[97m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

// `results[i]` = true if file i was actually re-embedded, false if skipped (hash unchanged).
// Each bucket's shade reflects the fraction of its files that were reindexed, not just
// whether any single one was — with 8000+ files in a 24-wide bar, one new file per bucket
// would otherwise paint the whole thing white and look like a full reindex.
export function renderBar(results: boolean[], total: number, width = 24): string {
  const bar = Array.from({ length: width }, (_, slot) => {
    const start = Math.floor((slot * total) / width);
    const end = Math.max(start + 1, Math.floor(((slot + 1) * total) / width));
    const slice = results.slice(start, end);
    if (slice.length === 0) return `${GRAY}░${RESET}`;
    const reindexedFrac = slice.filter(Boolean).length / slice.length;
    const color = reindexedFrac === 0 ? BLUE : reindexedFrac < 0.5 ? BLUE : WHITE;
    return `${color}█${RESET}`;
  }).join('');
  const reindexed = results.filter(Boolean).length;
  return `[${bar}] ${results.length}/${total} (${reindexed} reindexed, ${results.length - reindexed} skipped)`;
}

// Strip huge inlined vector literals (e.g. '[0.123,0.456,...]'::vector) from error
// output so a failed embedding insert doesn't dump 1536 floats to the terminal.
export function formatError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\[-?\d+(\.\d+)?(,-?\d+(\.\d+)?){20,}\]/g, '[<embedding>]');
}
