import { useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Btn, Seg, Spinner, fmtMoney, fmtTokens, harnessVar, HARNESS_LABEL, phaseVar } from '@zerovity/ui-kit';
import { downloadUrl, useApi } from '../api';
import { useApp } from '../state';

interface Dash {
  completed: number; autonomyRate: number | null; costPerCompleted: number | null; totalCost: number; failureRate: number;
  cycleTimeByPhase: Array<{ phase: string; medianMin: number; p90Min: number; n: number }>;
  tokensByHarness: Array<{ harness: string; model: string; tokensIn: number; tokensOut: number; tokensCached: number; costUsd: number; runs: number }>;
  gateWaitMedianMin: number; gateWaitByGate: Array<{ gate: string; medianMin: number; n: number }>; revisionLoopsPerItem: number; revisionHistogram: Record<string, number>;
  scorerPassRates: Array<{ scorer: string; total: number; pass: number; rate: number }>; daily: Array<{ day: string; completed: number; costUsd: number; runs: number }>; funnel: Array<{ state: string; n: number }>;
}

/** Every chart: one axis, thin marks with rounded data-ends, a hover readout, a legend when there are several series, and a table view. */
function Card({ title, sub, children, table }: { title: string; sub?: string; children: ReactNode; table?: ReactNode }) {
  const [t, setT] = useState(false);
  return (
    <section className="dcard">
      <header><div><h3>{title}</h3>{sub && <small>{sub}</small>}</div>{table && <button className="linkbtn" onClick={() => setT(!t)} aria-pressed={t}>{t ? 'Chart' : 'Table'}</button>}</header>
      {t && table ? <div className="dtable">{table}</div> : children}
    </section>
  );
}
const Tip = ({ x, y, children }: { x: number; y: number; children: ReactNode }) => <div className="ctip" style={{ left: x, top: y }} role="status">{children}</div>;

function HBars({ rows, unit, fmt = (n: number) => String(n) }: { rows: Array<{ label: string; value: number; color: string; note?: string }>; unit: string; fmt?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  return (
    <div className="hbars" onMouseLeave={() => setHover(null)}>
      {rows.map((r, i) => (
        <div key={r.label} className="hrow" onMouseMove={(e) => { const b = e.currentTarget.getBoundingClientRect(); setHover({ i, x: e.clientX - b.left + 12, y: i * 30 }); }}>
          <span className="hl">{r.label}</span>
          <span className="htrack"><span style={{ width: `${(r.value / max) * 100}%`, background: r.color }} /></span>
          <span className="hv mono">{fmt(r.value)}{unit}</span>
        </div>
      ))}
      {hover && <Tip x={hover.x + 90} y={hover.y}><b>{rows[hover.i].label}</b> {fmt(rows[hover.i].value)}{unit}{rows[hover.i].note ? <><br />{rows[hover.i].note}</> : null}</Tip>}
    </div>
  );
}

function DailyChart({ data, metric, color, fmt }: { data: Array<{ day: string; v: number }>; metric: string; color: string; fmt: (n: number) => string }) {
  const W = 560, H = 150, pl = 34, pb = 20, pt = 8;
  const max = Math.max(1e-9, ...data.map((d) => d.v)) * 1.1;
  const x = (i: number) => pl + (i / Math.max(1, data.length - 1)) * (W - pl - 8);
  const y = (v: number) => pt + (1 - v / max) * (H - pt - pb);
  const [h, setH] = useState<number | null>(null);
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.v).toFixed(1)}`).join(' ');
  return (
    <div className="linechart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${metric} per day`} onMouseMove={(e) => { const b = e.currentTarget.getBoundingClientRect(); const rel = ((e.clientX - b.left) / b.width) * W; setH(Math.max(0, Math.min(data.length - 1, Math.round(((rel - pl) / (W - pl - 8)) * (data.length - 1))))); }} onMouseLeave={() => setH(null)}>
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={pl} x2={W - 8} y1={y(max * f / 1.1)} y2={y(max * f / 1.1)} className="grid" /><text x={pl - 6} y={y(max * f / 1.1) + 3} textAnchor="end" className="axis">{fmt(max * f / 1.1)}</text></g>)}
        <path d={`${path} L${x(data.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={color} opacity=".12" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {data.length > 1 && [0, Math.floor(data.length / 2), data.length - 1].map((i) => <text key={i} x={x(i)} y={H - 4} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} className="axis">{data[i].day.slice(5)}</text>)}
        {h !== null && <g><line x1={x(h)} x2={x(h)} y1={pt} y2={H - pb} className="cross" /><circle cx={x(h)} cy={y(data[h].v)} r="4" fill={color} stroke="var(--panel)" strokeWidth="2" /></g>}
      </svg>
      {h !== null && <Tip x={Math.min(70, (x(h) / W) * 100) > 60 ? 330 : (x(h) / W) * 560 * 0.9 + 10} y={4}><b>{data[h].day}</b><br />{metric}: {fmt(data[h].v)}</Tip>}
    </div>
  );
}

function StackedBar({ rows }: { rows: Dash['tokensByHarness'] }) {
  const total = Math.max(1, rows.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0));
  const [h, setH] = useState<string | null>(null);
  const hs = [...new Set(rows.map((r) => r.harness))];
  const byH = hs.map((k) => ({ k, t: rows.filter((r) => r.harness === k).reduce((a, r) => a + r.tokensIn + r.tokensOut, 0), cost: rows.filter((r) => r.harness === k).reduce((a, r) => a + r.costUsd, 0) }));
  return (
    <div>
      <div className="stack1" onMouseLeave={() => setH(null)}>{byH.map((b) => <span key={b.k} onMouseEnter={() => setH(b.k)} style={{ width: `${(b.t / total) * 100}%`, background: harnessVar(b.k) }} aria-label={`${HARNESS_LABEL[b.k] ?? b.k}: ${fmtTokens(b.t)} tokens`} />)}</div>
      <div className="legend2">{byH.map((b) => <span key={b.k} className={h === b.k ? 'on' : ''}><i style={{ background: harnessVar(b.k) }} />{HARNESS_LABEL[b.k] ?? b.k} <b className="mono">{fmtTokens(b.t)}</b> <small>{fmtMoney(b.cost)}</small></span>)}</div>
      <table className="grid mini"><thead><tr><th>Model</th><th>Runs</th><th>In</th><th>Out</th><th>Cached</th><th>Cost</th></tr></thead><tbody>{rows.map((r) => <tr key={r.harness + r.model}><td>{HARNESS_LABEL[r.harness] ?? r.harness} · {r.model || 'default'}</td><td>{r.runs}</td><td className="mono">{fmtTokens(r.tokensIn)}</td><td className="mono">{fmtTokens(r.tokensOut)}</td><td className="mono">{fmtTokens(r.tokensCached)}</td><td className="mono">{fmtMoney(r.costUsd)}</td></tr>)}</tbody></table>
    </div>
  );
}

export function DashboardPage() {
  const { factoryId } = useApp();
  const [days, setDays] = useState<'7' | '14' | '30'>('14');
  const { data: d, isLoading } = useApi<Dash>(['dashboard', factoryId, days], `/factories/${factoryId}/dashboard`, { days: Number(days) }, { placeholderData: (p) => p });
  const phaseRows = useMemo(() => (d?.cycleTimeByPhase ?? []).map((p) => ({ label: p.phase, value: p.medianMin, color: phaseVar(p.phase), note: `p90 ${p.p90Min} min · ${p.n} runs` })), [d]);
  if (isLoading || !d) return <div className="pageload"><Spinner /></div>;
  const hist = Object.entries(d.revisionHistogram).sort((a, b) => Number(a[0]) - Number(b[0]));
  return (
    <div className="dash">
      <div className="phead"><h1>Dashboard</h1><div className="grow" />
        <Seg value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' }]} />
        <a className="btn" href={downloadUrl(`/factories/${factoryId}/usage.csv`, { by: 'workItem', days })}>Export usage CSV</a></div>
      <div className="tiles">
        <div className="tile"><small>Completed</small><b>{d.completed}</b></div>
        <div className="tile"><small>Autonomy rate</small><b>{d.autonomyRate === null ? '–' : `${Math.round(d.autonomyRate * 100)}%`}</b><em>no human code push</em></div>
        <div className="tile"><small>Cost per completed item</small><b>{d.costPerCompleted === null ? '–' : fmtMoney(d.costPerCompleted)}</b></div>
        <div className="tile"><small>Total spend</small><b>{fmtMoney(d.totalCost)}</b></div>
        <div className="tile"><small>Gate wait (median)</small><b>{d.gateWaitMedianMin} min</b></div>
        <div className="tile"><small>Revision loops per item</small><b>{d.revisionLoopsPerItem.toFixed(2)}</b></div>
        <div className="tile"><small>Run failure rate</small><b>{Math.round(d.failureRate * 100)}%</b></div>
      </div>
      <div className="dgrid">
        <Card title="Cycle time by phase" sub="Median minutes per run" table={<table className="grid mini"><thead><tr><th>Phase</th><th>Median</th><th>p90</th><th>Runs</th></tr></thead><tbody>{d.cycleTimeByPhase.map((p) => <tr key={p.phase}><td>{p.phase}</td><td>{p.medianMin}</td><td>{p.p90Min}</td><td>{p.n}</td></tr>)}</tbody></table>}>
          <HBars rows={phaseRows} unit=" min" />
        </Card>
        <Card title="Completed per day" table={<table className="grid mini"><tbody>{d.daily.map((x) => <tr key={x.day}><td>{x.day}</td><td>{x.completed}</td></tr>)}</tbody></table>}>
          <DailyChart data={d.daily.map((x) => ({ day: x.day, v: x.completed }))} metric="completed" color="var(--verify)" fmt={(n) => String(Math.round(n * 10) / 10)} />
        </Card>
        <Card title="Spend per day" sub="USD" table={<table className="grid mini"><tbody>{d.daily.map((x) => <tr key={x.day}><td>{x.day}</td><td>{fmtMoney(x.costUsd)}</td></tr>)}</tbody></table>}>
          <DailyChart data={d.daily.map((x) => ({ day: x.day, v: x.costUsd }))} metric="spend" color="var(--spec)" fmt={(n) => fmtMoney(n, n < 10 ? 2 : 0)} />
        </Card>
        <Card title="Tokens by harness and model" sub="Share of input plus output tokens"><StackedBar rows={d.tokensByHarness} /></Card>
        <Card title="Gate wait" sub="Median minutes from request to decision" table={<table className="grid mini"><tbody>{d.gateWaitByGate.map((g) => <tr key={g.gate}><td>{g.gate}</td><td>{g.medianMin}</td><td>{g.n}</td></tr>)}</tbody></table>}>
          {d.gateWaitByGate.length ? <HBars rows={d.gateWaitByGate.map((g) => ({ label: g.gate, value: g.medianMin, color: 'var(--gate)', note: `${g.n} decisions` }))} unit=" min" /> : <p className="hint">No gate decisions in this range.</p>}
        </Card>
        <Card title="Revision loops per item" sub="Items completed after N verify-and-fix loops">
          {hist.length ? <HBars rows={hist.map(([k, v]) => ({ label: `${k} loop${k === '1' ? '' : 's'}`, value: v, color: 'var(--build)' }))} unit=" items" /> : <p className="hint">Nothing completed yet.</p>}
        </Card>
        <Card title="Scorer pass rates" sub="LLM judge on sampled runs" table={<table className="grid mini"><tbody>{d.scorerPassRates.map((s) => <tr key={s.scorer}><td>{s.scorer}</td><td>{s.pass}/{s.total}</td></tr>)}</tbody></table>}>
          {d.scorerPassRates.length ? <HBars rows={d.scorerPassRates.map((s) => ({ label: s.scorer, value: Math.round(s.rate * 100), color: 'var(--verify)', note: `${s.pass} of ${s.total} sampled runs` }))} unit="%" /> : <p className="hint">No scorers yet. <Link to="/scorers">Create one</Link>.</p>}
        </Card>
        <Card title="Work items by state"><HBars rows={d.funnel.map((f) => ({ label: f.state.replace(/_/g, ' ').toLowerCase(), value: f.n, color: 'var(--ink3)' }))} unit="" /></Card>
      </div>
      <Btn small onClick={() => window.print()}>Print</Btn>
    </div>
  );
}
