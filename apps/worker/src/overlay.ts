import fs from 'node:fs';
import path from 'node:path';

/**
 * Files the factory places inside the agent's working copy for one run (skills, tool config, MCP config).
 * They must not outlive the run: some hold credentials, and a repository may already track a file at the same path
 * (for example its own .claude/skills or .cursor/mcp.json), which must come back exactly as it was.
 *
 * `write` remembers what was there before; `restore` puts it back and removes everything the overlay created.
 * A journal on disk lets the next run clean up after a crash (see `recoverOverlay`).
 */
export class Overlay {
  private saved = new Map<string, Buffer | null>();
  private createdDirs = new Set<string>();

  constructor(private root: string, private journal?: string) {}

  private resolve(rel: string): string {
    const base = path.resolve(this.root);
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`refusing to write outside the workspace: ${rel}`);
    return target;
  }

  write(rel: string, content: string): void {
    const target = this.resolve(rel);
    if (!this.saved.has(target)) this.saved.set(target, fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target) : null);
    let d = path.dirname(target);
    const missing: string[] = [];
    while (!fs.existsSync(d) && d.length > path.resolve(this.root).length) { missing.push(d); d = path.dirname(d); }
    for (const m of missing) this.createdDirs.add(m);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    this.persist();
  }

  /** Put everything back. Safe to call more than once. */
  restore(): void {
    for (const [target, original] of this.saved) {
      try {
        if (original === null) fs.rmSync(target, { force: true });
        else fs.writeFileSync(target, original);
      } catch { /* best effort: the journal retries next run */ }
    }
    this.saved.clear();
    // newly created folders, deepest first, only if they ended up empty
    for (const d of [...this.createdDirs].sort((a, b) => b.length - a.length)) {
      try { if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* not empty: the agent put something there */ }
    }
    this.createdDirs.clear();
    if (this.journal) fs.rmSync(this.journal, { force: true });
  }

  private persist() {
    if (!this.journal) return;
    const entries = [...this.saved].map(([target, original]) => ({ target, original: original === null ? null : original.toString('base64') }));
    fs.mkdirSync(path.dirname(this.journal), { recursive: true });
    fs.writeFileSync(this.journal, JSON.stringify({ entries, dirs: [...this.createdDirs] }));
  }
}

/** Undo what a crashed run left behind (called at the start of the next run on the same workspace). Returns how many paths were restored. */
export function recoverOverlay(journal: string): number {
  if (!fs.existsSync(journal)) return 0;
  let n = 0;
  try {
    const j = JSON.parse(fs.readFileSync(journal, 'utf8')) as { entries: Array<{ target: string; original: string | null }>; dirs: string[] };
    for (const e of j.entries) {
      try {
        if (e.original === null) fs.rmSync(e.target, { force: true });
        else fs.writeFileSync(e.target, Buffer.from(e.original, 'base64'));
        n++;
      } catch { /* ignore */ }
    }
    for (const d of [...(j.dirs ?? [])].sort((a, b) => b.length - a.length)) {
      try { if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* ignore */ }
    }
  } catch { /* corrupt journal: drop it */ }
  fs.rmSync(journal, { force: true });
  return n;
}
