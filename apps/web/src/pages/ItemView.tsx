import { useState, useRef, type DragEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { Btn, Chip, Empty, KV, Meter, PhaseChip, Tabs, fmtAgo, fmtDur, fmtMoney, fmtTokens, harnessVar, HARNESS_LABEL, phaseVar, useTick, Spinner } from '@zerovity/ui-kit';
import { api, downloadUrl, useAct, useApi, queryClient, type ItemDetail, type Message, type TimelineEntry } from '../api';
import { toast, toastError, useApp } from '../state';
import { Markdown } from '../ui/Markdown';
import { DiffView } from '../ui/Diff';
import { SpecReview, type SpecComment } from './SpecReview';
import { ContextPanel } from './ContextPanel';

type Tab = 'overview' | 'conversation' | 'timeline' | 'spec' | 'changes' | 'evidence' | 'context' | 'audit';
const TRACK = ['INTENT', 'SPEC', 'GATE', 'BUILD', 'VERIFY', 'SHIP'] as const;
const STATE_IDX: Record<string, number> = { INTAKE: 0, INTENT: 0, SPEC: 1, AWAITING_SPEC_APPROVAL: 2, AWAITING_GATE: 2, BUILD: 3, VERIFY: 4, SHIP: 5, AWAITING_HANDOFF: 5, COMPLETE: 6 };
const STATE_LABEL: Record<string, string> = { INTAKE: 'Intake', INTENT: 'Investigating', SPEC: 'Writing the spec', AWAITING_SPEC_APPROVAL: 'Waiting for spec approval', BUILD: 'Building', VERIFY: 'Verifying', AWAITING_GATE: 'Waiting for approval', SHIP: 'Preparing handoff', AWAITING_HANDOFF: 'Ready for a person', NEEDS_INPUT: 'Needs an answer', BLOCKED: 'Blocked', COMPLETE: 'Complete', CANCELLED: 'Cancelled', FAILED: 'Failed' };
const SRC: Record<string, string> = { github: 'GitHub issue', jira: 'Jira ticket', web: 'Web request', mcp: 'Local agent (MCP)', schedule: 'Schedule', webhook: 'Webhook', factory: 'Automation', test: 'Test run' };

export function ItemView({ id, variant, initialTab }: { id: string; variant: 'drawer' | 'page'; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'overview');
  const { data: d, isLoading, error } = useApi<ItemDetail>(['item', id], `/work-items/${id}`, undefined, { refetchInterval: 15_000 });
  const [over, setOver] = useState(false);
  const { isRole } = useApp();
  if (isLoading) return <div className="pageload"><Spinner /></div>;
  if (error || !d) return <Empty>Could not load this work item.</Empty>;
  const w = d.workItem;
  const idx = STATE_IDX[w.state] ?? (w.pausedState ? STATE_IDX[w.pausedState] ?? 0 : 0);
  const pending = d.questions.filter((q) => q.answer === null).length;

  const onDrop = async (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    if (!isRole('member')) return;
    const f = e.dataTransfer.files[0];
    try {
      if (f) { const fd = new FormData(); fd.append('file', f); await api('/context/file', { form: fd, query: { layer: 'workItem', scopeId: id } }); toast(`${f.name} attached as context`); }
      else { const u = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).trim(); if (/^https?:\/\//.test(u)) { await api('/context/url', { body: { layer: 'workItem', scopeId: id, url: u } }); toast('Link attached as context'); } else return; }
      void queryClient.invalidateQueries({ queryKey: ['ctxPreview', id] });
    } catch (err) { toastError(err); }
  };

  return (
    <div className={`itemview v-${variant}${over ? ' dropping' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }} onDrop={onDrop}>
      <div className="dh">
        <div className="id" style={{ ['--c' as string]: phaseVar(TRACK[Math.min(idx, 5)]) }}>{w.shortId} · {SRC[w.sourceType] ?? w.sourceType}{w.sourceRef ? ` ${w.sourceRef}` : ''}</div>
        <h2>{w.title}</h2>
        <div className="statusline">
          <Chip c={w.state === 'BLOCKED' || w.state === 'FAILED' ? 'var(--danger)' : w.state === 'NEEDS_INPUT' || w.state.startsWith('AWAITING') ? 'var(--gate)' : w.state === 'COMPLETE' ? 'var(--ok)' : 'var(--spec)'}>{STATE_LABEL[w.state] ?? w.state}</Chip>
          {w.loops > 0 && <Chip c="var(--build)">revision {w.loops} of {d.maxLoops}</Chip>}
          {w.prUrl && (w.prUrl.startsWith('local://') ? <Chip>PR (local) {w.prUrl.split('/').pop()}</Chip> : <a className="chip link" href={w.prUrl} target="_blank" rel="noreferrer">Pull request #{w.prNumber}</a>)}
          {w.branch && <Chip title="Branch"><span className="mono">{w.branch}</span></Chip>}
          {variant === 'drawer' && <Link className="chip link" to="/items/$id" params={{ id }}>Open full page</Link>}
        </div>
        <div className="track" role="list" aria-label="Phase progress">{TRACK.map((p, i) => <div role="listitem" key={p} className={i < idx ? 'done' : i === idx && w.state !== 'COMPLETE' ? 'cur' : ''} style={{ ['--c2' as string]: phaseVar(p) }}><span /><small>{p === 'GATE' ? 'GATE' : p}</small></div>)}</div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'conversation', label: 'Conversation', badge: pending || undefined }, { id: 'timeline', label: 'Timeline', badge: d.runs.length }, { id: 'spec', label: 'Spec' }, { id: 'changes', label: 'Changes' }, { id: 'evidence', label: 'Evidence' }, { id: 'context', label: 'Context' }, { id: 'audit', label: 'Audit' }]} />
      <div className="db">
        {tab === 'overview' && <Overview d={d} go={setTab} />}
        {tab === 'conversation' && <Conversation d={d} />}
        {tab === 'timeline' && <TimelineTab d={d} />}
        {tab === 'spec' && <SpecTab d={d} />}
        {tab === 'changes' && <ChangesTab d={d} />}
        {tab === 'evidence' && <EvidenceTab id={id} />}
        {tab === 'context' && <ContextPanel itemId={id} detail={d} />}
        {tab === 'audit' && <AuditTab d={d} />}
      </div>
      {over && <div className="dropveil">Drop to attach as context</div>}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------ overview */
function Overview({ d, go }: { d: ItemDetail; go: (t: Tab) => void }) {
  const w = d.workItem;
  const { isRole } = useApp();
  const now = useTick();
  const tokens = w.tokensIn + w.tokensOut;
  const cap = w.budgetUsd ?? 25;
  const live = [...d.runs].reverse().find((r) => r.status === 'running' || r.status === 'queued') ?? d.runs[d.runs.length - 1];
  const useWiAct = (path: string, msg: string) => useAct(() => api(`/work-items/${w.id}/${path}`, { method: 'POST' }), { invalidate: [['item', w.id], ['floor']], onSuccess: () => toast(msg), onError: toastError });
  const cancel = useWiAct('cancel', 'Work item cancelled');
  const retry = useWiAct('retry', 'Retrying');
  const handoff = useWiAct('handoff', 'Handed off');
  const finished = ['COMPLETE', 'CANCELLED', 'FAILED'].includes(w.state);
  return (
    <>
      <KV items={[['Elapsed', fmtDur((now - new Date(w.createdAt).getTime()) / 60000)], ['Cost', fmtMoney(w.costUsd)], ['Tokens', fmtTokens(tokens)], ['Runs', d.runs.length]]} />
      <div className="sect">Budget</div>
      <div className="budget"><span>{fmtMoney(w.costUsd)} of <b>{fmtMoney(cap)}</b></span><span>{Math.round((w.costUsd / cap) * 100)}%</span></div>
      <Meter value={w.costUsd} max={cap} mark={0.8} />
      <div className="sect" style={{ marginTop: 22 }}>Timeline</div>
      <MiniTimeline d={d} />
      {w.body && <><div className="sect">Request</div><Markdown text={w.body} /></>}
      <div className="opts" style={{ marginTop: 18 }}>
        {live && <Link to="/runs/$id" params={{ id: live.id }} className="btn pri">View live run</Link>}
        <Btn onClick={() => go('conversation')}>Message the foreman</Btn>
        <Btn onClick={() => go('context')}>Attach context</Btn>
        {w.state === 'AWAITING_HANDOFF' && <Btn pri onClick={() => handoff.mutate(undefined)} disabled={!isRole('member')}>Mark handed off</Btn>}
        {(w.state === 'BLOCKED') && <Btn pri onClick={() => retry.mutate(undefined)} disabled={!isRole('member')}>Retry</Btn>}
        {!finished && <Btn danger onClick={() => { if (confirm(`Cancel ${w.shortId}? Queued runs stop and its inbox items clear.`)) cancel.mutate(undefined); }} disabled={!isRole('member')}>Cancel</Btn>}
      </div>
    </>
  );
}

function MiniTimeline({ d }: { d: ItemDetail }) {
  const rows = d.timeline.slice(-8);
  if (!rows.length) return <Empty>Nothing has run yet.</Empty>;
  return (
    <div className="tl">
      {rows.map((e, i) => e.kind === 'run'
        ? <div className="e" key={i} style={{ ['--c' as string]: phaseVar(e.phase) }}><b>{e.agent} {e.status === 'running' ? 'is working' : e.status === 'queued' ? 'is queued' : e.status === 'needs_input' ? 'asked a question' : e.status === 'done' ? 'finished' : e.status}</b><span>{HARNESS_LABEL[e.harness] ?? e.harness} · {e.phase} · {fmtDur(e.durationMin)} · {fmtMoney(e.costUsd)}</span></div>
        : <div className="e" key={i} style={{ ['--c' as string]: 'var(--gate)' }}><b>{e.status === 'pending' ? `Waiting on ${e.gate}` : `${e.gate} ${e.status.replace('_', ' ')}${e.decidedBy ? ` by ${e.decidedBy}` : ''}`}</b><span>{e.reason ? `reason: ${e.reason}` : ''}{e.subjectHash ? ` · sha ${e.subjectHash.slice(0, 8)}…` : ''}</span></div>)}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------ conversation */
function Conversation({ d }: { d: ItemDetail }) {
  const w = d.workItem;
  const { isRole } = useApp();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const send = useAct((b: string) => api(`/work-items/${w.id}/messages`, { body: { body: b } }), { invalidate: [['item', w.id]], onSuccess: () => setText(''), onError: toastError });
  const open = d.questions.filter((q) => q.answer === null);
  const ans = useAct((a: { id: string; answer: string }) => api(`/questions/${a.id}/answer`, { body: { answer: a.answer } }), { invalidate: [['item', w.id], ['inbox']], onError: toastError });
  const msgs = d.messages.filter((m) => m.channel !== 'internal' || m.authorKind === 'agent');
  return (
    <div className="convo">
      {msgs.map((m) => <Bubble key={m.id} m={m} />)}
      {open.map((q) => (
        <div key={q.id} className="bubble waiting">
          <div className="who">Waiting for you · {q.askedBy}</div>
          <div>{q.text}</div>
          {q.options?.length ? <div className="opts">{q.options.map((o) => <Btn key={o} small onClick={() => ans.mutate({ id: q.id, answer: o })} disabled={!isRole('member')}>{o}</Btn>)}</div> : null}
        </div>
      ))}
      {!msgs.length && !open.length && <Empty>No messages yet. The foreman will post here, and in the GitHub or Jira thread when the item came from there.</Empty>}
      <div ref={end} />
      <form className="composer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(text.trim()); }}>
        <textarea rows={2} placeholder={open.length ? 'Reply here to answer the first open question…' : 'Message the foreman…'} value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) send.mutate(text.trim()); }} />
        <Btn pri type="submit" disabled={!text.trim() || send.isPending || !isRole('member')}>Send</Btn>
      </form>
    </div>
  );
}
function Bubble({ m }: { m: Message }) {
  const kind = m.authorKind;
  return (
    <div className={`bubble ${kind}`}>
      <div className="who">{kind === 'foreman' ? 'Foreman' : kind === 'agent' ? m.authorName : m.authorName ?? (kind === 'requester' ? 'Requester' : 'You')} <span>{m.channel !== 'web' && m.channel !== 'internal' ? `via ${m.channel} · ` : ''}{fmtAgo(m.createdAt)}</span></div>
      <Markdown text={m.body} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------ timeline tab */
function TimelineTab({ d }: { d: ItemDetail }) {
  if (!d.timeline.length) return <Empty>No runs yet.</Empty>;
  return (
    <table className="grid">
      <thead><tr><th>Agent</th><th>Phase</th><th>Harness · model</th><th>Status</th><th>Duration</th><th>Tokens</th><th>Cost</th></tr></thead>
      <tbody>
        {d.timeline.map((e, i) => e.kind === 'run' ? (
          <tr key={i}>
            <td><Link to="/runs/$id" params={{ id: e.runId }}>{e.agent}</Link>{e.attempt > 1 && <small> attempt {e.attempt}</small>}</td>
            <td><PhaseChip phase={e.phase} /></td>
            <td><span className="hxdot" style={{ background: harnessVar(e.harness) }} />{HARNESS_LABEL[e.harness] ?? e.harness}<small> {e.model}</small></td>
            <td><span className={`st ${e.status}`}>{e.status.replace('_', ' ')}</span></td>
            <td className="mono">{fmtDur(e.durationMin)}</td><td className="mono">{fmtTokens(e.tokens)}</td><td className="mono">{fmtMoney(e.costUsd)}</td>
          </tr>
        ) : (
          <tr key={i} className="gaterow"><td colSpan={3}>◆ {e.gate}</td><td><span className={`st ${e.status}`}>{e.status.replace('_', ' ')}</span></td><td colSpan={3}>{e.decidedBy ? `${e.decidedBy}` : 'waiting'}{e.reason ? ` · ${e.reason}` : ''}{e.subjectHash ? <small className="mono"> sha {e.subjectHash.slice(0, 10)}…</small> : null}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------------------------------------------ spec tab */
function SpecTab({ d }: { d: ItemDetail }) {
  const w = d.workItem;
  const { isRole } = useApp();
  const { data } = useApi<{ text: string | null; previous: string | null; pendingGate: { id: string; type: string } | null; approvedHash: string | null }>(['spec', w.id], `/work-items/${w.id}/spec`);
  const [comments, setComments] = useState<SpecComment[]>([]);
  const [reason, setReason] = useState('');
  const decide = useAct((a: { decision: 'approve' | 'changes' }) => api(`/gates/${data!.pendingGate!.id}/decision`, { body: { decision: a.decision, reason: reason || undefined, comments: comments.map((c) => ({ line: c.line, text: c.text })) } }), { invalidate: [['item', w.id], ['spec', w.id], ['inbox'], ['floor']], onSuccess: (_r, a) => { toast(a.decision === 'approve' ? 'Spec approved · build starts' : 'Sent back to the spec writer'); setComments([]); }, onError: toastError });
  if (!data) return <div className="pageload"><Spinner /></div>;
  if (!data.text) return <Empty>The spec is not written yet.</Empty>;
  const gate = data.pendingGate;
  return (
    <>
      {data.approvedHash && !gate && <Chip c="var(--ok)">approved · sha {data.approvedHash.slice(0, 12)}…</Chip>}
      <SpecReview text={data.text} previous={data.previous} comments={comments} onComments={setComments} readOnly={!gate || !isRole('approver')} />
      {gate && (
        <div className="approvebar">
          <textarea rows={2} placeholder="Reason (optional unless your policy requires it)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          <div className="opts">
            <Btn pri disabled={!isRole('approver') || decide.isPending} onClick={() => decide.mutate({ decision: 'approve' })} title={isRole('approver') ? undefined : 'Approving requires the approver role'}>Approve spec</Btn>
            <Btn disabled={!isRole('approver') || decide.isPending || (!comments.length && !reason.trim())} onClick={() => decide.mutate({ decision: 'changes' })}>Request changes{comments.length ? ` (${comments.length})` : ''}</Btn>
          </div>
          {!isRole('approver') && <small>You can read the spec but need the approver role to decide.</small>}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------------ changes, evidence, audit */
function ChangesTab({ d }: { d: ItemDetail }) {
  const { data, isLoading } = useApi<{ diff: string; runId: string | null; files: string[] }>(['changes', d.workItem.id], `/work-items/${d.workItem.id}/changes`);
  if (isLoading) return <div className="pageload"><Spinner /></div>;
  return (
    <>
      {d.workItem.prUrl && !d.workItem.prUrl.startsWith('local://') && <p><a href={d.workItem.prUrl} target="_blank" rel="noreferrer">Open the pull request ↗</a></p>}
      <DiffView diff={data?.diff ?? ''} />
    </>
  );
}

function EvidenceTab({ id }: { id: string }) {
  const { data } = useApi<{ evidence: Array<{ type: string; command?: string; exitCode?: number; logPath?: string; phase: string; agent: string; runId: string }>; findings: Array<{ severity: string; file?: string; line?: number; text: string; phase: string; agent: string }>; files: Array<{ runId: string; phase: string; name: string }>; recommendation: string | null }>(['evidence', id], `/work-items/${id}/evidence`);
  const [open, setOpen] = useState<{ runId: string; name: string } | null>(null);
  const { data: content } = useApi<string>(['artifact', open?.runId, open?.name], open ? `/artifacts` : null, open ? { runId: open.runId, name: open.name } : undefined, { enabled: !!open, queryFn: async () => (await fetch(downloadUrl('/artifacts', { runId: open!.runId, name: open!.name }), { credentials: 'include' })).text() });
  if (!data) return <div className="pageload"><Spinner /></div>;
  const sev = ['critical', 'high', 'medium', 'low'];
  return (
    <>
      {data.recommendation && <p>Verification recommends <Chip c={data.recommendation === 'accept' ? 'var(--ok)' : data.recommendation === 'revise' ? 'var(--build)' : 'var(--gate)'}>{data.recommendation}</Chip></p>}
      <div className="sect">Checks and test runs</div>
      {data.evidence.length ? <table className="grid"><thead><tr><th>Check</th><th>Command</th><th>Exit</th><th>By</th></tr></thead><tbody>{data.evidence.map((e, i) => <tr key={i}><td>{e.type}</td><td className="mono">{e.command ?? ''}</td><td className={e.exitCode === 0 ? 'ok' : 'bad'}>{e.exitCode ?? ''}</td><td>{e.agent} <PhaseChip phase={e.phase} /></td></tr>)}</tbody></table> : <Empty>No test evidence recorded yet.</Empty>}
      <div className="sect">Findings</div>
      {data.findings.length ? <ul className="findings">{[...data.findings].sort((a, b) => sev.indexOf(a.severity) - sev.indexOf(b.severity)).map((f, i) => <li key={i}><span className={`sev ${f.severity}`}>{f.severity}</span> <span className="mono">{f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : ''}</span> {f.text}</li>)}</ul> : <Empty>No findings.</Empty>}
      <div className="sect">Files</div>
      <div className="files">{data.files.map((f) => <button key={f.runId + f.name} className="chip link" onClick={() => setOpen({ runId: f.runId, name: f.name })}>{f.name} <small>{f.phase}</small></button>)}</div>
      {open && <div className="artifact"><div className="sect">{open.name} <button className="x" onClick={() => setOpen(null)} aria-label="Close file"><span>×</span></button></div>{/\.(png|jpe?g)$/i.test(open.name) ? <img alt={open.name} src={downloadUrl('/artifacts', { runId: open.runId, name: open.name })} /> : /\.md$/i.test(open.name) ? <Markdown text={content ?? ''} /> : <pre className="logbox">{content}</pre>}</div>}
    </>
  );
}

function AuditTab({ d }: { d: ItemDetail }) {
  const v = d.audit.verified;
  return (
    <>
      <div className={`verif ${v.ok ? 'ok' : 'bad'}`}>{v.ok ? `✓ Hash chain verified (${v.checked} entries)` : `✗ Chain broken at entry ${v.brokenAt} (${v.reason})`}
        <a className="btn small" href={downloadUrl(`/factories/${d.factory.id}/audit/export`, { format: 'csv' })}>Export CSV</a><a className="btn small" href={downloadUrl(`/factories/${d.factory.id}/audit/export`, { format: 'jsonl' })}>Export JSONL</a></div>
      <table className="grid audit"><thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Hash</th></tr></thead>
        <tbody>{[...d.audit.entries].reverse().map((e) => <tr key={e.id}><td className="mono">{e.seq}</td><td className="mono">{new Date(e.ts).toLocaleString()}</td><td>{e.actor}</td><td>{e.action}<small className="mono"> {summ(e.payload)}</small></td><td className="mono" title={e.hash}>{e.hash.slice(0, 10)}…</td></tr>)}</tbody></table>
    </>
  );
}
const summ = (p: unknown) => { const s = JSON.stringify(p ?? {}); return s.length > 110 ? s.slice(0, 109) + '…' : s; };

export type { TimelineEntry };
