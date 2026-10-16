import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { LayoutGroup, motion } from 'motion/react';
import { Btn, HARNESS_LABEL, Ring, Seg, fmtMoney, fmtDur, harnessVar, phaseVar, useReducedMotion, useTick, Icon } from '@zerovity/ui-kit';
import { api, useApi, useAct, queryClient, type Floor, type FloorItem, type InboxItem } from '../api';
import { useApp, toast, toastError } from '../state';
import { InboxCard } from './InboxCard';

const LANES = ['INTENT', 'SPEC', 'GATE', 'BUILD', 'VERIFY', 'SHIP'] as const;
const TOK_H = 112;
const GAP = 10;
const SRC: Record<string, string> = { github: 'GH', jira: 'JIRA', web: 'WEB', mcp: 'MCP', schedule: 'CRON', webhook: 'HOOK', factory: 'AUTO', test: 'TEST' };

const statusLine = (it: FloorItem) => {
  switch (it.status) {
    case 'ask': return <span className="ask">◆ needs your answer</span>;
    case 'loop': return <span className="live"><i />revision {it.loops} of {it.maxLoops}</span>;
    case 'blocked': return <span className="ask" style={{ color: 'var(--danger)' }}>◆ blocked</span>;
    case 'handoff': return <span className="ask" style={{ color: 'var(--ship)' }}>◆ ready for a person</span>;
    case 'queued': return <span className="live"><i />queued</span>;
    case 'gate': return <span className="ask">◆ waiting for approval</span>;
    default: return <span className="live"><i />running</span>;
  }
};

const Token = memo(function Token({ it, animate, orbit, onOpen }: { it: FloorItem; animate: boolean; orbit: boolean; onOpen: (id: string) => void }) {
  const live = it.status === 'run' || it.status === 'loop';
  return (
    <motion.div
      layout={animate ? 'position' : false} layoutId={animate ? it.id : undefined} initial={animate ? { opacity: 0, x: -18 } : false} animate={{ opacity: 1, x: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 30, mass: 0.9 }}
      className={`tok cut${live && orbit ? ' run' : ''}`} style={{ ['--c' as string]: phaseVar(it.lane), height: TOK_H }} data-id={it.id} data-status={it.status}
      role="button" tabIndex={0} aria-label={`${it.shortId} ${it.title}, ${it.state.replace(/_/g, ' ').toLowerCase()}`} onClick={() => onOpen(it.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(it.id); } }}
    >
      <div className="in cut">
        <div className="r1"><span className="id">{it.shortId}</span><span className="src">{SRC[it.source] ?? it.source.toUpperCase()}</span><span className="ring"><Ring value={it.budgetUsed} color={phaseVar(it.lane)} /></span></div>
        <div className="t">{it.title}</div>
        <div className="r3"><span className="st">{statusLine(it)}</span><span>{fmtDur(it.elapsedMin)}</span><span>{fmtMoney(it.costUsd)}</span></div>
        {live && <div className="prog"><i /></div>}
        {(it.lastEvent || it.agent) && <div className="lastev"><b>{it.agent ?? 'foreman'}</b>{it.lastEvent ? ` · ${it.lastEvent}` : ''}</div>}
      </div>
    </motion.div>
  );
});

/** Windowed list: only the tokens near the viewport are in the DOM, so 200+ items stay smooth. */
function VirtualStack({ items, animate, onOpen }: { items: FloorItem[]; animate: boolean; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 600 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const upd = () => setView({ top: el.scrollTop, h: el.clientHeight });
    upd();
    el.addEventListener('scroll', upd, { passive: true });
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', upd); ro.disconnect(); };
  }, []);
  const step = TOK_H + GAP;
  const from = Math.max(0, Math.floor((view.top - 12) / step) - 3);
  const to = Math.min(items.length, Math.ceil((view.top + view.h) / step) + 3);
  return (
    <div className="stack" ref={ref} data-count={items.length}>
      <div style={{ height: from * step }} aria-hidden />
      {items.slice(from, to).map((it) => <Token key={it.id} it={it} animate={animate && items.length < 40} orbit={animate && items.length <= 12} onOpen={onOpen} />)}
      <div style={{ height: Math.max(0, (items.length - to) * step) }} aria-hidden />
    </div>
  );
}

function GateRail({ items, onOpen }: { items: FloorItem[]; onOpen: (id: string) => void }) {
  return (
    <div className="gate">
      <div className="lbl">HUMAN GATE</div>
      <div className="slots">
        {items.slice(0, 14).map((it) => <button key={it.id} className="gslot" title={`${it.shortId} · ${it.title}`} aria-label={`${it.shortId} waiting for approval`} onClick={() => onOpen(it.id)}>{it.shortId.replace(/^\D+-?/, '')}</button>)}
        {items.length > 14 && <span className="more">+{items.length - 14}</span>}
      </div>
    </div>
  );
}

export function FloorPage() {
  const { factoryId, me, isRole, factory } = useApp();
  const nav = useNavigate();
  const reduced = useReducedMotion();
  const [range, setRange] = useState<'live' | 'today' | '7d'>('live');
  const { data: floor } = useApi<Floor>(['floor', factoryId, range], factoryId ? `/factories/${factoryId}/floor` : null, { days: range === '7d' ? 7 : 1 }, { refetchInterval: 20_000, placeholderData: (p) => p });
  const { data: inbox } = useApi<InboxItem[]>(['inbox', 'open', factoryId], '/inbox', { status: 'open', factoryId }, { refetchInterval: 30_000 });
  const open = (id: string) => void nav({ to: '/', search: { item: id } as never });
  const byLane = useMemo(() => { const m: Record<string, FloorItem[]> = {}; for (const l of LANES) m[l] = []; for (const it of floor?.items ?? []) (m[it.lane] ??= []).push(it); const pri: Record<string, number> = { ask: 0, blocked: 0, gate: 0, handoff: 1, loop: 2, run: 3, queued: 3 }; for (const l of LANES) m[l].sort((a, b) => (pri[a.status] ?? 3) - (pri[b.status] ?? 3) || b.since.localeCompare(a.since)); return m; }, [floor]);
  const pause = useAct(() => api(`/factories/${factoryId}`, { method: 'PATCH', body: { paused: !floor?.factory.paused } }), { invalidate: [['floor']], onSuccess: () => toast(floor?.factory.paused ? 'Line resumed' : 'Line paused · no new runs will start'), onError: toastError });
  const now = useTick(10_000);
  void now;

  if (!me.factories.length) return <Onboarding />;
  const total = floor?.items.length ?? 0;
  const mixTotal = Math.max(0.0001, (floor?.mix ?? []).reduce((a, m) => a + m.costUsd + m.premiumRequests * 0.04, 0));
  const maxMed = Math.max(1, ...(floor?.medians ?? []).map((m) => m.minutes));
  const items = inbox ?? [];

  return (
    <div className="floorpage">
      <section className="floor" aria-label="The line">
        <div className="floorhead">
          <div><h1>The line</h1><p>Live view of every work item in this factory. Click any item to open it.{total > 0 && <> <span className="mono">{total} on the line.</span></>}</p></div>
          {floor?.factory.paused && <span className="pausedtag">PAUSED</span>}
          {isRole('factory_owner') && <Btn small onClick={() => pause.mutate(undefined)} aria-label={floor?.factory.paused ? 'Resume the line' : 'Pause the line'}>{floor?.factory.paused ? <><Icon.Play /> Resume</> : <><Icon.Pause /> Pause</>}</Btn>}
          <Seg value={range} onChange={setRange} options={[{ value: 'live', label: 'Live' }, { value: 'today', label: 'Today' }, { value: '7d', label: '7 days' }]} />
        </div>
        <LayoutGroup>
          <div className="line" id="line">
            {LANES.map((l) => {
              if (l === 'GATE') return <GateRail key={l} items={byLane.GATE ?? []} onOpen={open} />;
              const meta = floor?.lanes.find((x) => x.lane === l);
              const its = byLane[l] ?? [];
              return (
                <div key={l} className="lane" style={{ ['--c' as string]: phaseVar(l) }}>
                  <div className="lhead">
                    <div className="ph">{l}<span className="n">{its.length}</span></div>
                    <div className="who">{meta?.agent ?? 'no agent'}{meta?.harness && <span className="h">{HARNESS_LABEL[meta.harness] ?? meta.harness}</span>}</div>
                    <div className="bar"><i style={{ width: `${Math.min(100, (its.length / 4) * 100)}%` }} /></div>
                  </div>
                  <VirtualStack items={its} animate={!reduced} onOpen={open} />
                </div>
              );
            })}
          </div>
        </LayoutGroup>
        <div className="conveyor" aria-hidden>
          <svg preserveAspectRatio="none" viewBox="0 0 1000 6">
            <defs><linearGradient id="cg"><stop offset="0" style={{ stopColor: 'var(--intent)' }} /><stop offset=".3" style={{ stopColor: 'var(--spec)' }} /><stop offset=".5" style={{ stopColor: 'var(--build)' }} /><stop offset=".75" style={{ stopColor: 'var(--verify)' }} /><stop offset="1" style={{ stopColor: 'var(--ship)' }} /></linearGradient></defs>
            <line x1="0" y1="3" x2="1000" y2="3" stroke="url(#cg)" strokeOpacity=".25" strokeWidth="1" />
            <line x1="0" y1="3" x2="1000" y2="3" stroke="url(#cg)" strokeWidth="2" strokeDasharray="6 26"><animate attributeName="stroke-dashoffset" from="0" to="-64" dur="1.6s" repeatCount="indefinite" /></line>
          </svg>
        </div>
        {!total && floor && <div className="floorempty"><b>The line is empty.</b><span>Create a work item, label a GitHub issue, or tag a Jira ticket.</span><Btn pri onClick={() => queryClient.setQueryData(['noop'], 1)} style={{ display: 'none' }} /></div>}
      </section>

      <aside className="inbox" aria-label="Waiting on you">
        <div className="ihead"><h2>Waiting on you</h2><span className="c">{items.length}</span><Link to="/inbox">Open inbox →</Link></div>
        <div className="ilist" id="ilist">
          {items.slice(0, 12).map((it) => <InboxCard key={it.id} item={it} onOpen={open} />)}
          {!items.length && <div className="empty" style={{ display: 'block' }}>Nothing is waiting on you. The line is moving.</div>}
          {items.length > 12 && <Link to="/inbox" className="btn">{items.length - 12} more in the inbox</Link>}
        </div>
      </aside>

      <section className="strip" aria-label="Activity">
        <section><h4><i />Live events</h4>
          <div className="log" aria-live="off">{(floor?.recentEvents ?? []).map((e, i) => <div key={e.ts + i}><span className="ts">{new Date(e.ts).toTimeString().slice(0, 8)}</span>  <span className="ag" style={{ ['--c' as string]: phaseVar(e.phase) }}>{e.agent.padEnd(21, ' ')}</span> {e.workItem} · {e.text}</div>)}{!floor?.recentEvents.length && <div className="ts">Events appear here as agents work.</div>}</div>
        </section>
        <section><h4>Harness mix · today</h4>
          <div className="mix">{(floor?.mix ?? []).map((m) => <i key={m.harness} style={{ width: `${((m.costUsd + m.premiumRequests * 0.04) / mixTotal) * 100}%`, background: harnessVar(m.harness) }} />)}</div>
          <div className="legend">{(floor?.mix ?? []).length ? floor!.mix.map((m) => <FragmentRow key={m.harness} h={m.harness} cost={m.costUsd} req={m.premiumRequests} />) : <span style={{ gridColumn: '1/4' }}>No runs yet today.</span>}</div>
        </section>
        <section><h4>Median minutes in phase</h4>
          <div className="bars">{(floor?.medians ?? []).map((m) => <div key={m.phase} style={{ ['--c' as string]: phaseVar(m.phase) }}><em>{m.minutes || '–'}</em><span style={{ height: `${(m.minutes / maxMed) * 70}%` }} /><small>{m.phase}</small></div>)}</div>
        </section>
      </section>
      {!isRole('member') && factory && <span className="sr-only">Read-only access</span>}
    </div>
  );
}

function FragmentRow({ h, cost, req }: { h: string; cost: number; req: number }) {
  return (<><s style={{ background: harnessVar(h) }} /><span>{HARNESS_LABEL[h] ?? h}</span><b>{h === 'copilot' && req ? `${req} req` : fmtMoney(cost)}</b></>);
}

function Onboarding() {
  const { me } = useApp();
  const isAdmin = me.role === 'org_admin';
  const create = useAct((ex: string) => api<{ id: string; ok: boolean; issues: Array<{ message: string }> }>('/factories', { body: { example: ex } }), { onSuccess: (r) => { if (!r.ok) toast(r.issues[0]?.message ?? 'Definition invalid', 'error'); else { toast('Factory created'); location.reload(); } }, onError: toastError });
  return (
    <div className="onboard">
      <h1>Welcome to Zerovity Factory</h1>
      <p>A factory is a team of agents attached to your repositories. Work comes in, agents move it through intent, spec, build, verify and ship, people approve at the gates, and a pull request with evidence ends up in front of a person.</p>
      {isAdmin ? (
        <div className="opts">
          <Btn pri onClick={() => create.mutate('01-single-repo')} disabled={create.isPending}>Create a single-repository factory</Btn>
          <Btn onClick={() => create.mutate('02-issue-to-pr')} disabled={create.isPending}>Create the issue-to-PR example</Btn>
        </div>
      ) : <p>Ask an organisation admin to create a factory and add you to it.</p>}
    </div>
  );
}
