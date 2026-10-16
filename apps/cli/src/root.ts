import fs from 'node:fs';
import path from 'node:path';

/** Folder that holds packs/zerovity-core, found from the CLI's own location (works from a checkout or an installed copy). */
export function findRepoRootSync(from = import.meta.dirname): string {
  let d = path.resolve(from);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'packs', 'zerovity-core'))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return process.cwd();
}
