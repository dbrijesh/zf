import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Btn, Chip, HARNESS_LABEL, Icon, PhaseChip, Spinner, fmtMoney, fmtTokens, harnessVar } from '@zerovity/ui-kit';
import { api, downloadUrl, useAct, useApi, type Run, type WorkItem } from '../api';
import { toast, toastError, useApp } from '../state';
import { Markdown } from '../ui/Markdown';
import { fmtElapsed, pendingCalls } from '../lib/pending';

interface Ev { seq: number; ts: string; kind: string; [k: string]: unknown }
interface RunState { status: string; tokensIn: number; tokensOut: number; tokensCached: number; costUsd: number; eventCount: number; sessionId: string | null; exitReason: string | null }

/** Live run view: normalised events over SSE (spec 12.2 #4). Tool calls collapsed, commands with exit codes, usage ticker. */
export function RunPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { isRole } = useApp();
  const { data: base } = useApi<{ run: Run; workItem: WorkItem }>(['run', id], `/runs/${id}`);
  const [events, setEvents] = useState<Ev[]>([]);
  const [live, setLive] = useState<RunState | null>(null);
  const [ended, setEnded] = useState(false);
  const [follow, setFollow] = useState(true);
  const [msg, setMsg] = useState('');
  const [filter, setFilter] = useState<'all' | 'messages' | 'commands' | 'files'>('all');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEvents([]); setEnded(false);
    const es = new EventSource(`/api/v1/runs/${id}/stream`, { withCredentials: true });
    es.addEventListener('event', (e) => { const ev = JSON.parse((e as MessageEvent).data) as Ev; setEvents((p) => (p.length && p[p.length - 1].seq >= ev.seq ? p : [...p, ev])); });
    es.addEventListener('run', (e) => setLive(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('end', () => { setEnded(true); es.close(); });
    es.onerror = () => { /* the browser reconnects with Last-Event-ID */ };
    return () => es.close();
  }, [id]);
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [events, follow]);

  const stop = useAct(() => api(`/runs/${id}/stop`, { method: 'POST' }), { invalidate: [['run', id]], onSuccess: () => toast('Stop requested'), onError: toastError });
  const send = useAct((m: string) => api<{ mode: string; runId: string }>(`/runs/${id}/followup`, { body: { message: m } }), { onSuccess: (r) => { setMsg(''); toast(r.mode === 'live' ? 'Message will reach the agent in this session' : 'Follow-up queued in the same session'); }, onError: toastError });

  const r = base?.run;
  const st = live?.status ?? r?.status ?? 'queued';
  const running = st === 'running' || st === 'queued';
  // what the agent is in the middle of: the harness only reports a tool call's result when it finishes, so a long command is silent
  const open = useMemo(() => (running ? pendingCalls(events) : []), [events, running]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!open.length) return; setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [open.length]);
  const rows = useMemo(() => events.filter((e) => filter === 'all' ? true : filter === 'messages' ? e.kind === 'message.assistant' || e.kind === 'system.followup' : filter === 'commands' ? e.kind === 'command.run' : e.kind === 'file.changed'), [events, filter]);
  const tin = live?.tokensIn ?? r?.tokensIn ?? 0, tout = live?.tokensOut ?? r?.tokensOut ?? 0, cost = live?.costUsd ?? r?.costUsd ?? 0;
  if (!r) return <div className="pageload"><Spinner /></div>;
  return (
    <div className="runpage">
      <div className="phead">
        <div><div className="crumb"><Link to="/runs">Runs</Link> / <Link to="/items/$id" params={{ id: r.workItemId }}>{base!.workItem.shortId}</Link></div><h1>{r.agentName} <PhaseChip phase={r.phase} /></h1></div>
        <div className="grow" />
        <Chip c={harnessVar(r.harness)}>{HARNESS_LABEL[r.harness] ?? r.harness}{r.model ? ` · ${r.model}` : ''}</Chip>
        <span className={`st ${st}`}>{st.replace('_', ' ')}</span>
        {running && isRole('member') && <Btn danger onClick={() => stop.mutate(undefined)} disabled={stop.isPending}>Stop</Btn>}
        <a className="btn" href={downloadUrl(`/runs/${id}/transcript`)}>Download transcript</a>
      </div>
      <div className="ticker mono" aria-live="off">
        <span>in <b>{fmtTokens(tin)}</b></span><span>out <b>{fmtTokens(tout)}</b></span><span>cached <b>{fmtTokens(live?.tokensCached ?? r.tokensCached)}</b></span><span>cost <b>{fmtMoney(cost, 4)}</b></span><span>events <b>{events.length}</b></span>
        {r.contextBundleHash && <span title="The exact context this agent was given">context <Link to="/items/$id" params={{ id: r.workItemId }} search={{ tab: 'context' } as never}>{r.contextBundleHash.slice(0, 10)}</Link></span>}
        {(live?.sessionId ?? r.sessionId) && <span title="Harness session id">session <b>{(live?.sessionId ?? r.sessionId)!.slice(0, 12)}</b></span>}
      </div>
      {open.length > 0 && (
        <div className="nowrunning mono" role="status" aria-live="off" title="This step has started and has not returned yet; output appears when it finishes">
          <i className="pulse" aria-hidden="true" />
          <span className="nr-label">running: <code>{open[0].label}</code></span>
          <b>{fmtElapsed(now - Date.parse(open[0].since))}</b>
          {open.length > 1 && <span className="nr-more">+{open.length - 1} more</span>}
        </div>
      )}
      <div className="runfilters"><div className="chips">{(['all', 'messages', 'commands', 'files'] as const).map((f) => <button key={f} className={`chip link${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>{f}</button>)}</div>
        <label className="chk"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />Follow</label></div>
      <div className="events" ref={box} onScroll={(e) => { const el = e.currentTarget; if (follow && el.scrollHeight - el.scrollTop - el.clientHeight > 80) setFollow(false); }}>
        {rows.map((e) => <EventRow key={e.seq} e={e} />)}
        {!rows.length && <div className="emptyblock"><div>{running ? 'Waiting for the agent to start…' : 'No events recorded.'}</div></div>}
        {running && <div className="typing"><i /><i /><i /></div>}
      </div>
      {r.resultJson && <div className="resultbox"><div className="sect">Result · {r.resultJson.status}{r.resultJson.recommendation ? ` · ${r.resultJson.recommendation}` : ''}</div><Markdown text={r.resultJson.summary} />{r.resultJson.findings?.length ? <ul className="findings">{r.resultJson.findings.map((f, i) => <li key={i}><span className={`sev ${f.severity}`}>{f.severity}</span> <span className="mono">{f.file}{f.line ? `:${f.line}` : ''}</span> {f.text}</li>)}</ul> : null}</div>}
      {r.exitReason && !running && <div className="resultbox bad">Exit reason: <b>{r.exitReason}</b></div>}
      {isRole('member') && (
        <form className="composer" onSubmit={(e) => { e.preventDefault(); if (msg.trim()) send.mutate(msg.trim()); }}>
          <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={running ? 'Send a follow-up into this session (delivered when the current step ends)' : 'Send a follow-up: resumes the same session'} aria-label="Follow-up message" />
          <Btn pri type="submit" disabled={!msg.trim() || send.isPending}>Send</Btn>
        </form>
      )}
      {ended && <div className="endmark"><Icon.Check /> run finished</div>}
    </div>
  );
}

function EventRow({ e }: { e: Ev }) {
  const [open, setOpen] = useState(false);
  const t = new Date(e.ts).toTimeString().slice(0, 8);
  switch (e.kind) {
    case 'message.assistant': return <div className="ev msg"><time>{t}</time><div><Markdown text={String(e.text)} /></div></div>;
    case 'system.status': return <div className="ev sys"><time>{t}</time><span>{String(e.text)}</span></div>;
    case 'system.followup': return <div className="ev follow"><time>{t}</time><span>You: {String(e.text)}</span></div>;
    case 'tool.call': return <div className="ev tool"><time>{t}</time><button onClick={() => setOpen(!open)} aria-expanded={open}>▸ {String(e.tool)}</button>{open && <pre>{JSON.stringify(e.input, null, 2)}</pre>}</div>;
    case 'tool.result': return <div className={`ev toolres ${e.ok ? '' : 'bad'}`}><time>{t}</time><span className="mono">{e.ok ? '✓' : '✗'} {String(e.summary).slice(0, 220)}</span></div>;
    case 'command.run': return <div className="ev cmd"><time>{t}</time><code>$ {String(e.command)}</code>{e.exitCode !== undefined && <span className={`exit ${e.exitCode === 0 ? 'ok' : 'bad'}`}>exit {String(e.exitCode)}</span>}</div>;
    case 'file.changed': return <div className="ev file"><time>{t}</time><span className="mono">{e.op === 'add' ? '+' : e.op === 'delete' ? '−' : '~'} {String(e.path)}</span></div>;
    case 'usage': return <div className="ev usage"><time>{t}</time><span className="mono">usage · in {fmtTokens(Number(e.inputTokens))} · out {fmtTokens(Number(e.outputTokens))}{e.costUsd !== undefined ? ` · ${fmtMoney(Number(e.costUsd), 4)}` : ''}</span></div>;
    case 'error': return <div className="ev err"><time>{t}</time><span>{String(e.message)}</span></div>;
    case 'session.started': return <div className="ev sys"><time>{t}</time><span>session {String(e.sessionId).slice(0, 12)}{e.model ? ` · ${String(e.model)}` : ''}</span></div>;
    case 'session.ended': return <div className="ev sys"><time>{t}</time><span>session ended: {String(e.status)}</span></div>;
    default: return null;
  }
}
