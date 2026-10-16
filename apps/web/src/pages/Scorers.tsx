import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Btn, Chip, Empty, Spinner, fmtAgo } from '@zerovity/ui-kit';
import { api, useAct, useApi } from '../api';
import { toast, toastError, useApp } from '../state';

interface Scorer { id: string; name: string; description: string; rubric: string; labels: string[]; passLabels: string[]; sampling: number; appliesTo: { phases: string[]; agents: string[] }; enabled: boolean; stats: { total: number; pass: number; rate: number; labels: Record<string, number> } | null }
interface Score { id: string; runId: string; workItemId: string; scorer: string; agent: string; phase: string; harness: string; label: string; score: number; pass: boolean; rationale: string; judge: string | null; createdAt: string }

/** Scorers (spec 12.2 #10): rubrics, sampling, recent results, drill into failing runs. */
export function ScorersPage() {
  const { factoryId, isRole } = useApp();
  const { data, isLoading } = useApi<Scorer[]>(['scorers', factoryId], `/factories/${factoryId}/scorers`);
  const [failing, setFailing] = useState(false);
  const { data: scores } = useApi<Score[]>(['scores', factoryId, failing], `/factories/${factoryId}/scores`, { limit: 60, failing: failing || undefined });
  const [sel, setSel] = useState<string | 'new'>('');
  const cur = data?.find((s) => s.name === sel);
  return (
    <div className="studio">
      <div className="slist">
        <div className="phead"><h1>Scorers</h1><div className="grow" />{isRole('factory_owner') && <Btn small onClick={() => setSel('new')}>New scorer</Btn>}</div>
        <p className="hint">An LLM judge classifies sampled runs against a rubric. Pass rates feed the dashboard.</p>
        {isLoading && <Spinner />}
        {(data ?? []).map((s) => (
          <button key={s.id} className={`srow${sel === s.name ? ' sel' : ''}`} onClick={() => setSel(s.name)}><b>{s.name}</b><span>{s.enabled ? '' : <Chip c="var(--gate)">disabled</Chip>} <small>sampling {Math.round(s.sampling * 100)}%</small></span><small>{s.stats?.total ? `${Math.round(s.stats.rate * 100)}% pass of ${s.stats.total}` : 'no results yet'}</small></button>))}
      </div>
      <div className="sdetail">
        {sel === 'new' || cur ? <Editor key={cur?.id ?? 'new'} s={cur} /> : <Empty>Select a scorer to edit it.</Empty>}
        <div className="sect">Recent results <label className="chk"><input type="checkbox" checked={failing} onChange={(e) => setFailing(e.target.checked)} />failing only</label></div>
        <table className="grid"><thead><tr><th>When</th><th>Scorer</th><th>Run</th><th>Result</th><th>Rationale</th></tr></thead>
          <tbody>{(scores ?? []).map((r) => <tr key={r.id}><td>{fmtAgo(r.createdAt)}</td><td>{r.scorer}</td><td><Link to="/runs/$id" params={{ id: r.runId }}>{r.agent} · {r.phase}</Link></td><td><span className={`st ${r.pass ? 'done' : 'failed'}`}>{r.label}</span></td><td>{r.rationale}<small> {r.judge}</small></td></tr>)}</tbody></table>
        {!scores?.length && <Empty>No scores yet. Runs are sampled as they finish.</Empty>}
      </div>
    </div>
  );
}

function Editor({ s }: { s?: Scorer }) {
  const { factoryId, isRole } = useApp();
  const [d, setD] = useState({ name: s?.name ?? '', description: s?.description ?? '', rubric: s?.rubric ?? 'Pass when ...\nPartial when ...\nFail when ...', labels: (s?.labels ?? ['pass', 'partial', 'fail']).join(', '), pass: (s?.passLabels ?? ['pass']).join(', '), sampling: Math.round((s?.sampling ?? 0.2) * 100), phases: (s?.appliesTo.phases ?? []).join(', '), agents: (s?.appliesTo.agents ?? []).join(', '), enabled: s?.enabled ?? true });
  const save = useAct(() => api(`/factories/${factoryId}/scorers/${d.name}`, { method: 'PUT', body: { description: d.description, rubric: d.rubric, labels: d.labels.split(',').map((x) => x.trim()).filter(Boolean), passLabels: d.pass.split(',').map((x) => x.trim()).filter(Boolean), sampling: d.sampling / 100, appliesTo: { phases: d.phases.split(',').map((x) => x.trim()).filter(Boolean), agents: d.agents.split(',').map((x) => x.trim()).filter(Boolean) }, enabled: d.enabled } }), { invalidate: [['scorers']], onSuccess: () => toast('Scorer saved'), onError: toastError });
  const del = useAct(() => api(`/factories/${factoryId}/scorers/${d.name}`, { method: 'DELETE' }), { invalidate: [['scorers']], onSuccess: () => toast('Scorer deleted'), onError: toastError });
  const owner = isRole('factory_owner');
  return (
    <div className="aedit"><div className="phead"><h1>{s ? s.name : 'New scorer'}</h1><div className="grow" />{owner && <Btn pri onClick={() => save.mutate(undefined)} disabled={!d.name || save.isPending}>Save</Btn>}{owner && s && <Btn danger onClick={() => confirm('Delete scorer?') && del.mutate(undefined)}>Delete</Btn>}</div>
      <fieldset disabled={!owner} className="form">
        {!s && <label className="fld">Name<input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} placeholder="spec-quality" /></label>}
        <label className="fld">Description<input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></label>
        <label className="fld">Rubric (what the judge applies)<textarea rows={7} value={d.rubric} onChange={(e) => setD({ ...d, rubric: e.target.value })} /></label>
        <div className="row3"><label className="fld">Labels<input value={d.labels} onChange={(e) => setD({ ...d, labels: e.target.value })} /></label><label className="fld">Labels that count as pass<input value={d.pass} onChange={(e) => setD({ ...d, pass: e.target.value })} /></label><label className="fld">Sampling {d.sampling}%<input type="range" min={0} max={100} value={d.sampling} onChange={(e) => setD({ ...d, sampling: Number(e.target.value) })} /></label></div>
        <div className="row3"><label className="fld">Phases<input value={d.phases} onChange={(e) => setD({ ...d, phases: e.target.value })} placeholder="all" /></label><label className="fld">Agents<input value={d.agents} onChange={(e) => setD({ ...d, agents: e.target.value })} placeholder="all" /></label><label className="fld chk"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />Enabled</label></div>
      </fieldset></div>
  );
}
