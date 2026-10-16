import { useMemo, useState } from 'react';
import { Btn, Seg, Empty, Chip } from '@zerovity/ui-kit';
import { Markdown } from '../ui/Markdown';
import { lineDiff } from '../ui/Diff';

export interface SpecComment { line: number; text: string; file?: string }

/**
 * The spec rendered line by line with inline comments, plus a diff against the previous version when the writer revised it.
 * Reviewers' comments travel with "request changes" and reach the same spec-writer session (spec 12.2).
 */
export function SpecReview({ text, previous, comments, onComments, readOnly }: { text: string; previous?: string | null; comments: SpecComment[]; onComments: (c: SpecComment[]) => void; readOnly?: boolean }) {
  const [mode, setMode] = useState<'rendered' | 'diff' | 'source'>('rendered');
  const [draft, setDraft] = useState<{ line: number; text: string } | null>(null);
  const lines = useMemo(() => text.split('\n'), [text]);
  const diff = useMemo(() => (previous ? lineDiff(previous, text) : []), [previous, text]);
  const changed = diff.filter((d) => d.kind !== 'same').length;

  // group source lines into blocks (separated by blank lines) so each paragraph, list or table can take a comment
  const blocks = useMemo(() => {
    const out: Array<{ start: number; text: string }> = [];
    let cur: string[] = [], start = 1;
    lines.forEach((l, i) => {
      if (l.trim() === '' && !cur.join('\n').includes('```')) { if (cur.length) out.push({ start, text: cur.join('\n') }); cur = []; start = i + 2; }
      else { if (!cur.length) start = i + 1; cur.push(l); }
    });
    if (cur.length) out.push({ start, text: cur.join('\n') });
    return out;
  }, [lines]);

  return (
    <div className="spec">
      <div className="spechead">
        <Seg value={mode} onChange={setMode} options={[{ value: 'rendered', label: 'Rendered' }, ...(previous ? [{ value: 'diff' as const, label: `Changes since last version${changed ? ` (${changed})` : ''}` }] : []), { value: 'source', label: 'Source' }]} />
        {comments.length > 0 && <Chip c="var(--gate)">{comments.length} comment{comments.length === 1 ? '' : 's'}</Chip>}
      </div>
      {mode === 'rendered' && blocks.map((b) => {
        const cs = comments.filter((c) => c.line >= b.start && c.line < b.start + b.text.split('\n').length);
        return (
          <div key={b.start} className={`sblock${cs.length ? ' has' : ''}`}>
            <Markdown text={b.text} />
            {!readOnly && <button className="sadd" aria-label={`Comment on line ${b.start}`} onClick={() => setDraft({ line: b.start, text: '' })}>+ comment</button>}
            {cs.map((c, i) => <div key={i} className="scomment"><b>line {c.line}</b> {c.text}{!readOnly && <button aria-label="Remove comment" onClick={() => onComments(comments.filter((x) => x !== c))}>×</button>}</div>)}
            {draft && draft.line === b.start && (
              <div className="inlineform">
                <textarea autoFocus rows={3} placeholder="What should change here?" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} aria-label="Comment" />
                <div className="opts"><Btn pri small disabled={!draft.text.trim()} onClick={() => { onComments([...comments, { line: draft.line, text: draft.text.trim() }]); setDraft(null); }}>Add comment</Btn><Btn small onClick={() => setDraft(null)}>Cancel</Btn></div>
              </div>
            )}
          </div>
        );
      })}
      {mode === 'diff' && (diff.length ? <pre className="linediff">{diff.map((d, i) => d.kind === 'same' && diff[i - 1]?.kind === 'same' && diff[i + 1]?.kind === 'same' ? null : <div key={i} className={d.kind}>{d.kind === 'add' ? '+ ' : d.kind === 'del' ? '− ' : '  '}{d.text}</div>)}</pre> : <Empty>No earlier version to compare with.</Empty>)}
      {mode === 'source' && <pre className="linediff src">{lines.map((l, i) => <div key={i}><span className="no">{i + 1}</span>{l}</div>)}</pre>}
    </div>
  );
}
