#!/usr/bin/env node
// Thin launcher: runs the TypeScript CLI through tsx (a bundled build replaces this in container images).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');
const r = spawnSync(process.execPath, [tsx, path.join(import.meta.dirname, '..', 'src', 'main.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
