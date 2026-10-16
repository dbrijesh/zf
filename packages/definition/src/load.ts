import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Files } from './validate';

const SKIP = new Set(['node_modules', '.git', '.zerovity-local']);

/** Read a definition folder into a path -> content map (forward slashes, text files only). */
export function loadDir(dir: string): Files {
  const out: Files = {};
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile() && fs.statSync(abs).size < 2_000_000) {
        const buf = fs.readFileSync(abs);
        if (!buf.includes(0)) out[r] = buf.toString('utf8');
      }
    }
  };
  walk(dir, '');
  return out;
}

export function writeDir(dir: string, files: Files): void {
  for (const [p, c] of Object.entries(files)) {
    if (p.includes('..')) throw new Error(`Refusing to write outside target: ${p}`);
    const abs = path.join(dir, ...p.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, c);
  }
}

export function filesHash(files: Files): string {
  const h = createHash('sha256');
  for (const k of Object.keys(files).sort()) h.update(k + '\0' + files[k] + '\0');
  return h.digest('hex');
}
