import { useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Btn, fmtAgo, useTick } from '@zerovity/ui-kit';
import { api, useAct, useApi, queryClient, type InboxItem, type Question } from '../api';
import { toast, toastError, useApp } from '../state';
import { Markdown } from '../ui/Markdown';

const KIND: Record<string, { label: string; c: string }> = {
  spec_approval: { label: 'Spec approval', c: 'var(--gate)' }, question: { label: 'Question', c: 'var(--intent)' }, context_request: { label: 'Context request', c: 'var(--spec)' },
  gate: { label: 'Approval', c: 'var(--gate)' }, pr_review: { label: 'PR review', c: 'var(--ship)' }, blocked: { label: 'Blocked', c: 'var(--danger)' }, failed: { label: 'Failed', c: 'var(--danger)' }, connection: { label: 'Connection', c: 'var(--build)' },
};
export const kindInfo = (k: string) => KIND[k] ?? { label: k, c: 'var(--ink3)' };

const invalidateAll = () => { void queryClient.invalidateQueries(); };

/** One inbox card: resolves the thing in place (answer, attach, approve, request changes) per spec 12.2. */
export function InboxCard({ item, compact = true, onOpen }: { item: InboxItem; compact?: boolean; onOpen?: (workItemId: string) => void }) {
  const now = useTick();
  const { isRole } = useApp();
  const nav = useNavigate();
  const k = kindInfo(item.kind);
  const [gone, setGone] = useState(false);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'idle' | 'changes'>('idle');
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const p = item.payload as { questionId?: string; options?: string[]; why?: string; agent?: string; harness?: string; gateId?: string; specExcerpt?: string; prUrl?: string; connectionId?: string; error?: string; runId?: string; gate?: string };
  const { data: qd } = useApi<{ question: Question | null }>(['inboxq', item.id], (item.kind === 'question' || item.kind === 'context_request') && !p.options ? `/inbox/${item.id}` : null);
  const options = p.options ?? qd?.question?.options ?? [];

  const done = (msg: string) => { setGone(true); toast(msg); setTimeout(invalidateAll, 420); };
  const answer = useAct((a: { answer?: string; url?: string }) => api(`/questions/${p.questionId}/answer`, { body: { answer: a.answer ?? '', url: a.url } }), { onSuccess: () => done('Answer sent · the agent resumes in the same session'), onError: toastError });
  const decide = useAct((a: { decision: 'approve' | 'changes'; reason?: string }) => api(`/gates/${p.gateId}/decision`, { body: { decision: a.decision, reason: a.reason, comments: a.reason ? [{ text: a.reason }] : [] } }), { onSuccess: (_r, a) => done(a.decision === 'approve' ? 'Approved · work continues' : 'Sent back with your comments'), onError: toastError });
  const resolve = useAct(() => api(`/inbox/${item.id}/resolve`, { method: 'POST' }), { onSuccess: () => done('Resolved'), onError: toastError });
  const retry = useAct(() => api(`/work-items/${item.workItemId}/retry`, { method: 'POST' }), { onSuccess: () => done('Retrying'), onError: toastError });
  const handoff = useAct(() => api(`/work-items/${item.workItemId}/handoff`, { method: 'POST' }), { onSuccess: () => done('Handed off · item complete'), onError: toastError });
  const test = useAct(() => api<{ ok: boolean; detail: string }>(`/connections/${p.connectionId}/test`, { method: 'POST' }), { onSuccess: (r) => { toast(r.ok ? 'Connection healthy' : r.detail, r.ok ? 'info' : 'error'); invalidateAll(); }, onError: toastError });
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append('file', f);
    try { await api(`/questions/${p.questionId}/answer-file`, { form: fd }); done(`${f.name} attached as context · the agent resumes`); } catch (e) { toastError(e); }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void upload(f); else { const u = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).trim(); if (/^https?:\/\//.test(u)) answer.mutate({ url: u }); } };
  const open = () => item.workItemId && (onOpen ? onOpen(item.workItemId) : void nav({ to: '/items/$id', params: { id: item.workItemId } }));
  const canApprove = isRole('approver');
  const excerpt = p.specExcerpt?.split('\n').filter((l) => /^(- |\+ |R\d|AC\d|\*\*|#{2,3} )/.test(l.trim())).slice(0, 3);

  return (
    <article className={`card${gone ? ' done' : ''}${item.read ? '' : ' unread'}`} style={{ ['--c' as string]: k.c }} data-item={item.workItemId ?? ''} data-kind={item.kind}>
      <div className="k">{k.label}<span className="ago">{fmtAgo(item.createdAt, now)}</span></div>
      <h3>{item.title}</h3>
      {item.body && (compact ? <p>{item.body.length > 220 ? item.body.slice(0, 219) + '…' : item.body}</p> : <Markdown text={item.body} />)}
      {item.kind === 'question' && p.agent && <div className="meta">asked by {p.agent}{p.harness ? ` · ${p.harness}` : ''}{p.why ? ` · ${p.why}` : ''}</div>}
      {item.kind === 'blocked' || item.kind === 'failed' ? p.error && <div className="specdiff">{p.error}</div> : null}
      {item.kind === 'spec_approval' && excerpt && excerpt.length > 0 && <div className="specdiff">{excerpt.map((l, i) => <div key={i}><span className="a">{l.trim().startsWith('-') ? '+' : '·'}</span> {l.replace(/^[-+]\s*/, '')}</div>)}</div>}

      {item.kind === 'question' && (
        <>
          {options.length > 0 && <div className="opts">{options.map((o) => <Btn key={o} disabled={answer.isPending} onClick={() => answer.mutate({ answer: o })}>{o}</Btn>)}</div>}
          <form className="answer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) answer.mutate({ answer: text.trim() }); }}>
            <input placeholder={options.length ? 'Or type an answer…' : 'Type an answer…'} value={text} onChange={(e) => setText(e.target.value)} aria-label="Your answer" />
            <button type="submit" disabled={!text.trim() || answer.isPending}>SEND</button>
          </form>
        </>
      )}
      {item.kind === 'context_request' && (
        <>
          <div className={`drop${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} onClick={() => fileRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}>
            Drop a file here, paste a link, or <u>browse</u>
            <input ref={fileRef} type="file" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          </div>
          <form className="answer" onSubmit={(e) => { e.preventDefault(); const v = text.trim(); if (/^https?:\/\//.test(v)) answer.mutate({ url: v }); else if (v) answer.mutate({ answer: v }); }}>
            <input placeholder="Paste a link or write the answer" value={text} onChange={(e) => setText(e.target.value)} aria-label="Link or answer" />
            <button type="submit" disabled={!text.trim() || answer.isPending}>SEND</button>
          </form>
        </>
      )}
      {(item.kind === 'spec_approval' || item.kind === 'gate') && (
        mode === 'changes' ? (
          <div className="inlineform">
            <textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What should change?" aria-label="Requested changes" />
            <div className="opts"><Btn pri small disabled={!reason.trim() || decide.isPending} onClick={() => decide.mutate({ decision: 'changes', reason })}>Send back</Btn><Btn small onClick={() => setMode('idle')}>Cancel</Btn></div>
          </div>
        ) : (
          <div className="opts">
            <Btn pri disabled={!canApprove || decide.isPending} title={canApprove ? undefined : 'Approving requires the approver role'} onClick={() => decide.mutate({ decision: 'approve' })}>{item.kind === 'spec_approval' ? 'Approve spec' : 'Approve'}</Btn>
            <Btn disabled={!canApprove} onClick={() => setMode('changes')}>Request changes</Btn>
            {!compact && item.workItemId ? <Btn onClick={open}>Open work item</Btn> : <Btn onClick={open}>Open</Btn>}
          </div>
        )
      )}
      {item.kind === 'pr_review' && (
        <div className="opts">
          {p.prUrl && !p.prUrl.startsWith('local://') && <a className="btn pri" href={p.prUrl} target="_blank" rel="noreferrer">Open pull request</a>}
          <Btn pri={!!p.prUrl?.startsWith('local://') || !p.prUrl} onClick={() => handoff.mutate(undefined)} disabled={handoff.isPending}>Mark handed off</Btn>
          <Btn onClick={open}>Open</Btn>
        </div>
      )}
      {(item.kind === 'blocked' || item.kind === 'failed') && <div className="opts"><Btn pri onClick={() => retry.mutate(undefined)} disabled={retry.isPending}>Retry</Btn>{p.runId && <Link className="btn" to="/runs/$id" params={{ id: p.runId }}>View run</Link>}<Btn onClick={open}>Open</Btn></div>}
      {item.kind === 'connection' && <div className="opts"><Btn pri onClick={() => test.mutate(undefined)} disabled={test.isPending}>Test now</Btn><Link className="btn" to="/connections">Open connections</Link><Btn small onClick={() => resolve.mutate(undefined)}>Dismiss</Btn></div>}
      {(item.kind === 'question' || item.kind === 'context_request') && <div className="opts mini"><Btn small onClick={open}>Open work item</Btn><Btn small onClick={() => resolve.mutate(undefined)} title="Mark resolved without answering">Dismiss</Btn></div>}
    </article>
  );
}
