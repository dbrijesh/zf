import { useMemo, useState } from 'react';

interface Line { kind: 'add' | 'del' | 'ctx' | 'meta'; text: string; oldNo?: number; newNo?: number }
interface FileDiff { path: string; adds: number; dels: number; lines: Line[] }

/** Parse a unified diff (git diff output) into files with line numbers. */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let o = 0, n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) { const m = / b\/(.+)$/.exec(raw); cur = { path: m?.[1] ?? raw, adds: 0, dels: 0, lines: [] }; files.push(cur); continue; }
    if (!cur) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) { o = Number(h[1]); n = Number(h[2]); cur.lines.push({ kind: 'meta', text: raw }); continue; }
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(raw)) continue;
    if (raw.startsWith('+')) { cur.adds++; cur.lines.push({ kind: 'add', text: raw.slice(1), newNo: n++ }); }
    else if (raw.startsWith('-')) { cur.dels++; cur.lines.push({ kind: 'del', text: raw.slice(1), oldNo: o++ }); }
    else if (raw.startsWith(' ')) cur.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: o++, newNo: n++ });
  }
  return files;
}

export function DiffView({ diff, onComment }: { diff: string; onComment?: (file: string, line: number) => void }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!files.length) return <div className="emptyblock"><div>No changes recorded yet.</div></div>;
  return (
    <div className="diff">
      <div className="diffsum">{files.length} file{files.length === 1 ? '' : 's'} changed · <span className="add">+{files.reduce((a, f) => a + f.adds, 0)}</span> <span className="del">−{files.reduce((a, f) => a + f.dels, 0)}</span></div>
      {files.map((f) => {
        const isOpen = open[f.path] ?? files.length <= 6;
        return (
          <section key={f.path} className="dfile">
            <button className="dhead" onClick={() => setOpen({ ...open, [f.path]: !isOpen })} aria-expanded={isOpen}><span className="mono">{f.path}</span><em className="add">+{f.adds}</em><em className="del">−{f.dels}</em></button>
            {isOpen && (
              <table><tbody>
                {f.lines.map((l, i) => l.kind === 'meta'
                  ? <tr key={i} className="hunk"><td colSpan={3}>{l.text}</td></tr>
                  : <tr key={i} className={l.kind}>
                      <td className="no">{l.oldNo ?? ''}</td>
                      <td className="no" onClick={() => l.newNo && onComment?.(f.path, l.newNo)} title={onComment && l.newNo ? 'Comment on this line' : undefined}>{l.newNo ?? ''}</td>
                      <td className="code"><span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>{l.text}</td>
                    </tr>)}
              </tbody></table>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Line diff of two texts for the spec review (what changed since the last version). */
export function lineDiff(a: string, b: string): Array<{ kind: 'add' | 'del' | 'same'; text: string }> {
  const x = a.split('\n'), y = b.split('\n');
  const m = x.length, n = y.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ kind: 'add' | 'del' | 'same'; text: string }> = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) { out.push({ kind: 'same', text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: x[i++] });
    else out.push({ kind: 'add', text: y[j++] });
  }
  while (i < m) out.push({ kind: 'del', text: x[i++] });
  while (j < n) out.push({ kind: 'add', text: y[j++] });
  return out;
}
