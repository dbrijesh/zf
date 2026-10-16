import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Btn, Chip, Empty, HARNESS_LABEL, PhaseChip, Spinner, fmtMoney, fmtDur, fmtTokens, harnessVar, phaseVar } from '@zerovity/ui-kit';
import { api, useAct, useApi, queryClient, type AgentView, type Connection, type Issue } from '../api';
import { toast, toastError, useApp } from '../state';
import { CodeEditor } from '../ui/Editor';

const HARNESSES = ['claude-code', 'codex', 'copilot'];
const MODELS: Record<string, string[]> = { 'claude-code': ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], codex: ['gpt-5-codex'], copilot: [''] };
const PHASES = ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP', 'CUSTOM'];
const SCOPES = ['org', 'factory', 'repo', 'workItem', 'phase'];

export function AgentsPage() {
  const { factoryId, isRole } = useApp();
  const search = useSearch({ strict: false }) as { name?: string };
  const nav = useNavigate();
  const { data: agents, isLoading } = useApi<AgentView[]>(['agents', factoryId], `/factories/${factoryId}/agents`);
  const [newOpen, setNewOpen] = useState(false);
  const sel = agents?.find((a) => a.name === search.name) ?? agents?.[0];
  return (
    <div className="studio">
      <div className="slist">
        <div className="phead"><h1>Agents</h1><div className="grow" />{isRole('factory_owner') && <Btn small onClick={() => setNewOpen(true)}>New agent</Btn>}</div>
        {isLoading && <Spinner />}
        {(agents ?? []).map((a) => (
          <button key={a.name} className={`srow${sel?.name === a.name ? ' sel' : ''}`} style={{ ['--c' as string]: phaseVar(a.phase) }} onClick={() => void nav({ to: '/agents', search: { name: a.name } as never })}>
            <b>{a.name}</b>
            <span><PhaseChip phase={a.phase} /> <span className="hxdot" style={{ background: harnessVar(a.effectiveHarness) }} />{HARNESS_LABEL[a.effectiveHarness] ?? a.effectiveHarness}</span>
            <small>{a.skills.length} skills · {fmtTokens(a.weight.total)} tokens always loaded{a.stats ? ` · ${Math.round(a.stats.successRate * 100)}% ok` : ''}</small>
          </button>
        ))}
      </div>
      <div className="sdetail">{sel ? <AgentEditor key={sel.name + JSON.stringify(sel.harness) + sel.body.length} a={sel} /> : <Empty>No agents. Install a pack (zerovity-core) or create one.</Empty>}</div>
      {newOpen && <NewAgent onClose={() => setNewOpen(false)} agents={agents ?? []} />}
    </div>
  );
}

function NewAgent({ onClose, agents }: { onClose: () => void; agents: AgentView[] }) {
  const { factoryId } = useApp();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', description: '', phase: 'BUILD', copyFrom: '' });
  const create = useAct(() => api<{ ok: boolean; issues: Issue[] }>(`/factories/${factoryId}/agents`, { body: { ...f, copyFrom: f.copyFrom || undefined } }), { invalidate: [['agents'], ['floor']], onSuccess: (r) => { if (!r.ok) return toast(r.issues.find((i) => i.severity === 'error')?.message ?? 'Invalid', 'error'); toast('Agent created'); onClose(); void nav({ to: '/agents', search: { name: f.name } as never }); }, onError: toastError });
  return (
    <><div className="scrim on" onClick={onClose} /><div className="modal small" role="dialog" aria-modal="true" aria-label="New agent">
      <div className="mhead"><h2>New agent</h2></div>
      <div className="mbody">
        <label className="fld">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} placeholder="acme-api-reviewer" /></label>
        <label className="fld">Description<input value={f.description} maxLength={200} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="One sentence: what this agent is responsible for" /></label>
        <div className="row2"><label className="fld">Phase<select value={f.phase} onChange={(e) => setF({ ...f, phase: e.target.value })}>{PHASES.map((p) => <option key={p}>{p}</option>)}</select></label>
          <label className="fld">Start from<select value={f.copyFrom} onChange={(e) => setF({ ...f, copyFrom: e.target.value })}><option value="">Empty agent</option>{agents.map((a) => <option key={a.name}>{a.name}</option>)}</select></label></div>
        <div className="mfoot"><span /><Btn pri disabled={!f.name || !f.description || create.isPending} onClick={() => create.mutate(undefined)}>Create</Btn></div>
      </div>
    </div></>
  );
}

function AgentEditor({ a }: { a: AgentView }) {
  const { factoryId, isRole } = useApp();
  const nav = useNavigate();
  const owner = isRole('factory_owner');
  const isPack = a.source.startsWith('pack:');
  const { data: lib } = useApi<{ skills: Array<{ name: string; scope: string; tokens: { description: number; body: number } }> }>(['skills', factoryId], `/factories/${factoryId}/skills`);
  const { data: conns } = useApi<Connection[]>(['connections'], '/connections');
  const { data: settings } = useApi<{ runners: Array<{ name: string }>; mcpServers: Record<string, unknown> }>(['settings', factoryId], `/factories/${factoryId}/settings`);
  const [d, setD] = useState({ description: a.description, phase: a.phase, harnessType: a.harness.type, model: a.harness.model ?? '', reasoning: a.harness.reasoning ?? '', runner: a.runner, credential: a.credential ?? '', mcp: a.mcpServers, scopes: a.contextScopes, outputs: a.outputs.join(', '), maxRun: a.maxRunMinutes ? String(a.maxRunMinutes) : '', skills: a.skills.filter((s) => s.layer !== 'agent').map((s) => s.name), body: a.body });
  const [fork, setFork] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const dirty = JSON.stringify(d) !== JSON.stringify({ description: a.description, phase: a.phase, harnessType: a.harness.type, model: a.harness.model ?? '', reasoning: a.harness.reasoning ?? '', runner: a.runner, credential: a.credential ?? '', mcp: a.mcpServers, scopes: a.contextScopes, outputs: a.outputs.join(', '), maxRun: a.maxRunMinutes ? String(a.maxRunMinutes) : '', skills: a.skills.filter((s) => s.layer !== 'agent').map((s) => s.name), body: a.body });
  const credConns = (conns ?? []).filter((c) => c.type === 'harness' && (d.harnessType === 'claude-code' ? ['anthropic', 'bedrock', 'vertex'].includes(c.provider) : d.harnessType === 'codex' ? c.provider === 'openai' : c.provider === 'copilot'));
  const save = useAct(() => api<{ ok: boolean; issues: Issue[] }>(`/factories/${factoryId}/agents/${a.name}`, { method: 'PUT', body: { description: d.description, phase: d.phase, harness: { type: d.harnessType, model: d.model || undefined, reasoning: d.reasoning || undefined }, runner: d.runner || undefined, credential: d.credential || null, mcpServers: d.mcp, contextScopes: d.scopes, outputs: d.outputs.split(',').map((x) => x.trim()).filter(Boolean), maxRunMinutes: d.maxRun ? Number(d.maxRun) : undefined, skills: d.skills, ...(d.body !== a.body || fork ? { body: d.body, fork: true } : {}) } }), {
    invalidate: [['agents'], ['floor'], ['skills']], onSuccess: (r) => { setIssues(r.issues); r.ok ? toast('Saved · the next run uses this configuration') : toast(r.issues.find((i) => i.severity === 'error')?.message ?? 'Not saved', 'error'); }, onError: toastError });
  const [sample, setSample] = useState('Add a health check endpoint that returns the build version.');
  const test = useAct(() => api<{ runId: string }>(`/factories/${factoryId}/agents/${a.name}/test`, { body: { title: 'Sample request', body: sample } }), { onSuccess: (r) => void nav({ to: '/runs/$id', params: { id: r.runId } }), onError: toastError });
  const del = useAct(() => api(`/factories/${factoryId}/agents/${a.name}`, { method: 'DELETE' }), { invalidate: [['agents']], onSuccess: () => { toast('Agent removed'); void nav({ to: '/agents', search: {} as never }); }, onError: toastError });
  const bodyLines = d.body.replace(/\n+$/, '').split('\n').length;
  const [addSkill, setAddSkill] = useState('');
  const sk = useMemo(() => new Map(a.skills.map((s) => [s.name, s])), [a.skills]);
  useEffect(() => { void queryClient; }, []);

  return (
    <div className="aedit">
      <div className="phead"><div><h1 style={{ ['--c' as string]: phaseVar(a.phase) }}>{a.name}</h1><div className="sub"><Chip>{isPack ? `from pack ${a.source.slice(5)}` : 'defined in this factory'}</Chip>{a.overridden.length > 0 && <Chip c="var(--build)">overrides: {a.overridden.join(', ')}</Chip>}{a.forced && <Chip c="var(--gate)" title="ZF_FORCE_HARNESS is set on this deployment">running on {HARNESS_LABEL[a.effectiveHarness]}</Chip>}</div></div><div className="grow" />
        {owner && <Btn pri onClick={() => save.mutate(undefined)} disabled={!dirty && !fork || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Btn>}
        {owner && !isPack && <Btn danger onClick={() => confirm(`Delete agent ${a.name}?`) && del.mutate(undefined)}>Delete</Btn>}</div>

      <div className="weight">
        <div><small>Role text</small><b>{fmtTokens(a.weight.body)}</b></div><div><small>Skill descriptions (always loaded)</small><b>{fmtTokens(a.weight.skillDescriptions)}</b></div><div className="total"><small>Weight this agent adds</small><b>{fmtTokens(a.weight.total)}</b></div><div><small>On demand (skill bodies)</small><b>{fmtTokens(a.weight.onDemand)}</b></div>
        {a.stats && <><div><small>Runs / success</small><b>{a.stats.runs} · {Math.round(a.stats.successRate * 100)}%</b></div><div><small>Avg cost · time</small><b>{fmtMoney(a.stats.avgCostUsd, 3)} · {fmtDur(a.stats.avgMinutes)}</b></div></>}
      </div>

      <fieldset disabled={!owner} className="form">
        <label className="fld">Description <em className={d.description.length > 200 ? 'over' : ''}>{d.description.length}/200</em><input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></label>
        <div className="row3">
          <label className="fld">Phase<select value={d.phase} onChange={(e) => setD({ ...d, phase: e.target.value })}>{PHASES.map((p) => <option key={p}>{p}</option>)}</select></label>
          <label className="fld">Harness<select value={d.harnessType} onChange={(e) => setD({ ...d, harnessType: e.target.value, model: MODELS[e.target.value]?.[0] ?? '' })}>{HARNESSES.map((h) => <option key={h} value={h}>{HARNESS_LABEL[h]}</option>)}{!HARNESSES.includes(d.harnessType) && <option>{d.harnessType}</option>}</select></label>
          <label className="fld">Model<input list="models" value={d.model} onChange={(e) => setD({ ...d, model: e.target.value })} placeholder="harness default" /><datalist id="models">{(MODELS[d.harnessType] ?? []).map((m) => <option key={m} value={m} />)}</datalist></label>
        </div>
        <div className="row3">
          <label className="fld">Reasoning<select value={d.reasoning} onChange={(e) => setD({ ...d, reasoning: e.target.value })}><option value="">default</option><option>low</option><option>medium</option><option>high</option></select></label>
          <label className="fld">Runner<select value={d.runner} onChange={(e) => setD({ ...d, runner: e.target.value })}>{['default', ...(settings?.runners.map((r) => r.name) ?? [])].filter((x, i, arr) => arr.indexOf(x) === i).map((r) => <option key={r}>{r}</option>)}</select></label>
          <label className="fld">Credential<select value={d.credential} onChange={(e) => setD({ ...d, credential: e.target.value })}><option value="">Factory / organisation default</option>{credConns.map((c) => <option key={c.id} value={c.displayName}>{c.displayName} ({c.status})</option>)}</select></label>
        </div>
        <div className="row2">
          <div className="fld"><span>Context layers it receives</span><div className="checks">{SCOPES.map((s) => <label key={s}><input type="checkbox" checked={d.scopes.includes(s)} onChange={(e) => setD({ ...d, scopes: e.target.checked ? [...d.scopes, s] : d.scopes.filter((x) => x !== s) })} />{s}</label>)}</div></div>
          <div className="fld"><span>MCP servers it may use</span><div className="checks">{Object.keys(settings?.mcpServers ?? {}).map((s) => <label key={s}><input type="checkbox" checked={d.mcp.includes(s)} onChange={(e) => setD({ ...d, mcp: e.target.checked ? [...d.mcp, s] : d.mcp.filter((x) => x !== s) })} />{s}</label>)}{!Object.keys(settings?.mcpServers ?? {}).length && <small>none declared in the factory</small>}</div></div>
        </div>
        <div className="row2"><label className="fld">Files it must produce<input value={d.outputs} onChange={(e) => setD({ ...d, outputs: e.target.value })} placeholder="spec.md, review.md" /></label><label className="fld">Max run minutes<input inputMode="numeric" value={d.maxRun} onChange={(e) => setD({ ...d, maxRun: e.target.value.replace(/\D/g, '') })} placeholder="factory default" /></label></div>
      </fieldset>

      <div className="sect">Skills it loads <small>(effective set: pack, then factory, then agent layer; later wins)</small></div>
      <ul className="skills">
        {a.skills.map((s) => (
          <li key={s.name}><Link to="/skills" search={{ name: s.name, scope: s.layer === 'pack' ? `pack:${s.source}` : s.layer === 'agent' ? s.source : 'factory' } as never}><b>{s.name}</b></Link><span className={`layer ${s.layer}`}>{s.layer}{s.layer === 'pack' ? ` · ${s.source}` : ''}</span>{s.overrides.length > 0 && <small>overrides {s.overrides.join(', ')}</small>}<span className="mono tokinfo">{fmtTokens(s.tokens.description)} always · {fmtTokens(s.tokens.body)} on demand</span>
            {owner && s.layer !== 'agent' && <button className="x" aria-label={`Remove ${s.name}`} onClick={() => setD({ ...d, skills: d.skills.filter((x) => x !== s.name) })}>×</button>}</li>
        ))}
        {a.missingSkills.map((m) => <li key={m} className="missing"><b>{m}</b><span className="layer bad">unresolved</span></li>)}
      </ul>
      {owner && <div className="opts"><select value={addSkill} onChange={(e) => setAddSkill(e.target.value)} aria-label="Skill to add"><option value="">Add a skill…</option>{[...new Set((lib?.skills ?? []).map((s) => s.name))].filter((n) => !d.skills.includes(n) && !sk.has(n)).map((n) => <option key={n}>{n}</option>)}</select><Btn small disabled={!addSkill} onClick={() => { setD({ ...d, skills: [...d.skills, addSkill] }); setAddSkill(''); }}>Add</Btn></div>}

      <div className="sect">Role text <em className={bodyLines > 60 ? 'over' : ''}>{bodyLines}/60 lines</em> {isPack && !fork && owner && <Btn small onClick={() => setFork(true)}>Fork to edit</Btn>}{isPack && fork && <Chip c="var(--gate)">will be saved as a factory agent that replaces the pack one</Chip>}</div>
      <div className="editorbox"><CodeEditor value={d.body} language="markdown" path={`agent-${a.name}.md`} readOnly={!owner || (isPack && !fork)} onChange={(v) => setD({ ...d, body: v })} height="260px" onSave={() => owner && save.mutate(undefined)} /></div>

      {issues.length > 0 && <ul className="issues">{issues.map((i, k) => <li key={k} className={i.severity}><b>{i.severity}</b> <span className="mono">{i.file}{i.line ? `:${i.line}` : ''}</span> {i.message}</li>)}</ul>}

      <div className="sect">Test run</div>
      <p className="hint">Runs this agent once against a sample request in a throwaway work item. It never changes the real line.</p>
      <textarea rows={2} value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Sample request" />
      <div className="opts"><Btn onClick={() => test.mutate(undefined)} disabled={!isRole('member') || test.isPending}>{test.isPending ? 'Starting…' : 'Run test'}</Btn><Link className="btn" to="/runs">All runs</Link></div>
    </div>
  );
}
