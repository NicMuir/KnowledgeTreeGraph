/**
 * Seed script: indexes this KB repo itself as a demo.
 * Run: pnpm seed
 */
import 'dotenv/config';
import path from 'path';
import { indexRepository } from '../packages/ingestion/src/indexer';

const repoRoot = path.resolve(__dirname, '..');

void (async () => {
  console.log('Seeding with the KB repo itself as a demo...\n');
  console.log(`Path: ${repoRoot}\n`);

  const { runId, repoId } = await indexRepository({
    repoPath: repoRoot,
    repoName: 'kb-demo',
    branch: 'main',
    onProgress: (indexed, total) => {
      process.stdout.write(`\r  ${indexed}/${total} files indexed`);
    },
  });

  console.log(`\n\nSeeding complete!`);
  console.log(`  Run ID:  ${runId}`);
  console.log(`  Repo ID: ${repoId}`);
  console.log('\nYou can now start the API and web app, and ask questions about the KB codebase itself.');
  process.exit(0);
})().catch((err: unknown) => {
  console.error('\nSeed failed:', err);
  process.exit(1);
});
