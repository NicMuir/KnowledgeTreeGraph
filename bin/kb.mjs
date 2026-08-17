#!/usr/bin/env node
// Thin launcher so `kb` works from any directory once linked (`pnpm link --global`).
// Resolves the repo root from this file's location and runs the CLI under the repo's ts-node.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsnode = path.join(root, 'node_modules', '.bin', 'ts-node');
const res = spawnSync(
  tsnode,
  ['-P', path.join(root, 'scripts', 'tsconfig.json'), path.join(root, 'scripts', 'cli.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, DOTENV_CONFIG_PATH: path.join(root, '.env') } },
);
process.exit(res.status ?? 1);
