import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Btn, Chip, Empty, Tabs, fmtAgo } from '@zerovity/ui-kit';
import { api, useAct, useApi } from '../api';
import { toast, toastError, useApp } from '../state';
import { CodeEditor } from '../ui/Editor';

type Tab = 'factory' | 'runners' | 'gates' | 'prices' | 'members' | 'secrets' | 'tokens' | 'mcp';
interface S { identity: { name: string; alias: string | null; description: string; shortPrefix: string }; limits: { maxConcurrentRuns: number; maxRunsPerRepo: number }; budget: { maxTokensPerRun?: number; maxCostPerWorkItemUsd?: number }; agentDefaults: { harness: { type: string; model?: string; reasoning?: string } | null; runner: string; maxRunMinutes: number; idleTimeoutMinutes: number }; runners: Array<{ name: string; description?: string; image: string; setupCommands: string[]; resources: { cpus: number; memoryGb: number }; network: { egress: string; allow: string[] } }>; notifications: Record<string, unknown>; secretsDeclared: string[]; paused: boolean }

export function SettingsPage() {
  const search = useSearch({ strict: false }) as { tab?: Tab };
  const nav = useNavigate();
  const { me } = useApp();
  const tab = search.tab ?? 'factory';
  const set = (t: Tab) => void nav({ to: '/settings', search: { tab: t } as never });
  return (
    <div className="settings">
      <div className="phead"><h1>Settings</h1></div>
      <Tabs value={tab} onChange={set} tabs={[{ id: 'factory', label: 'Factory' }, { id: 'runners', label: 'Runners' }, { id: 'gates', label: 'Gates policy' }, { id: 'prices', label: 'Model prices' }, { id: 'members', label: 'Members' }, { id: 'secrets', label: 'Secrets' }, { id: 'tokens', label: 'Access tokens' }, { id: 'mcp', label: 'Local agents (MCP)' }]} />
      <div className="sbody">
        {tab === 'factory' && <FactoryTab />}{tab === 'runners' && <RunnersTab />}{tab === 'gates' && <GatesTab />}{tab === 'prices' && <PricesTab admin={me.role === 'org_admin'} />}
        {tab === 'members' && <MembersTab admin={me.role === 'org_admin'} />}{tab === 'secrets' && <SecretsTab />}{tab === 'tokens' && <TokensTab />}{tab === 'mcp' && <McpTab />}
      </div>
    </div>
  );
}

function useSettings() { const { factoryId } = useApp(); return useApi<S>(['settings', factoryId], `/factories/${factoryId}/settings`); }
function useSave() { const { factoryId } = useApp(); return useAct((body: Record<string, unknown>) => api<{ ok: boolean; issues: Array<{ message: string; severity: string }> }>(`/factories/${factoryId}/settings`, { method: 'PUT', body }), { invalidate: [['settings'], ['definition'], ['floor'], ['agents']], onSuccess: (r) => (r.ok ? toast('Saved') : toast(r.issues.find((i) => i.severity === 'error')?.message ?? 'Rejected', 'error')), onError: toastError }); }

function FactoryTab() {
  const { isRole } = useApp();
  const { data } = useSettings();
  const save = useSave();
  const [d, setD] = useState<null | { alias: string; description: string; conc: string; perRepo: string; maxCost: string; maxTokens: string; runMin: string; idle: string; notifyWeb: boolean; notifySource: boolean }>(null);
  useEffect(() => { if (data) setD({ alias: data.identity.alias ?? '', description: data.identity.description, conc: String(data.limits.maxConcurrentRuns), perRepo: String(data.limits.maxRunsPerRepo), maxCost: String(data.budget.maxCostPerWorkItemUsd ?? ''), maxTokens: String(data.budget.maxTokensPerRun ?? ''), runMin: String(data.agentDefaults.maxRunMinutes), idle: String(data.agentDefaults.idleTimeoutMinutes), notifyWeb: (data.notifications.web as boolean) ?? true, notifySource: (data.notifications.source as boolean) ?? true }); }, [data]);
  if (!data || !d) return null;
  const owner = isRole('factory_owner');
  const n = (s: string) => (s ? Number(s) : undefined);
  return (
    <fieldset disabled={!owner} className="form narrow">
      <div className="sect">Identity</div>
      <div className="row2"><label className="fld">Name<input value={data.identity.name} disabled /></label><label className="fld">Alias (used in @zerovity mentions and labels)<input value={d.alias} onChange={(e) => setD({ ...d, alias: e.target.value })} /></label></div>
      <label className="fld">Description<input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></label>
      <div className="sect">Concurrency and budgets</div>
      <div className="row2"><label className="fld">Concurrent runs per factory<input inputMode="numeric" value={d.conc} onChange={(e) => setD({ ...d, conc: e.target.value })} /></label><label className="fld">Concurrent runs per repository<input inputMode="numeric" value={d.perRepo} onChange={(e) => setD({ ...d, perRepo: e.target.value })} /></label></div>
      <div className="row2"><label className="fld">Max cost per work item (USD)<input inputMode="decimal" value={d.maxCost} onChange={(e) => setD({ ...d, maxCost: e.target.value })} /></label><label className="fld">Max tokens per run<input inputMode="numeric" value={d.maxTokens} onChange={(e) => setD({ ...d, maxTokens: e.target.value })} /></label></div>
      <div className="row2"><label className="fld">Max run minutes<input inputMode="numeric" value={d.runMin} onChange={(e) => setD({ ...d, runMin: e.target.value })} /></label><label className="fld">Idle timeout minutes<input inputMode="numeric" value={d.idle} onChange={(e) => setD({ ...d, idle: e.target.value })} /></label></div>
      <div className="sect">Notification routes</div>
      <label className="chk"><input type="checkbox" checked={d.notifyWeb} onChange={(e) => setD({ ...d, notifyWeb: e.target.checked })} />Inbox in the app</label>
      <label className="chk"><input type="checkbox" checked={d.notifySource} onChange={(e) => setD({ ...d, notifySource: e.target.checked })} />Reply in the source thread (GitHub or Jira comments)</label>
      <div className="opts"><Btn pri disabled={save.isPending} onClick={() => save.mutate({ alias: d.alias || undefined, description: d.description, limits: { maxConcurrentRuns: n(d.conc) ?? 4, maxRunsPerRepo: n(d.perRepo) ?? 2 }, budget: { maxCostPerWorkItemUsd: n(d.maxCost), maxTokensPerRun: n(d.maxTokens) }, agentDefaults: { maxRunMinutes: n(d.runMin), idleTimeoutMinutes: n(d.idle) }, notifications: { web: d.notifyWeb, source: d.notifySource } })}>Save</Btn></div>
      <p className="hint">Limits, budgets and defaults are written into zerovity.factory.yaml, so they appear in Definition history and the audit log.</p>
    </fieldset>
  );
}

function RunnersTab() {
  const { data } = useSettings();
  const { isRole } = useApp();
  const save = useSave();
  const [edit, setEdit] = useState<{ name: string; image: string; setup: string; cpus: string; mem: string; egress: string; allow: string } | null>(null);
  if (!data) return null;
  return (
    <>
      <p className="hint">Runners are container images and resource shapes. Network egress is an allowlist; the container is the real security boundary.</p>
      <table className="grid"><thead><tr><th>Name</th><th>Image</th><th>Resources</th><th>Egress</th><th /></tr></thead><tbody>{data.runners.map((r) => <tr key={r.name}><td><b>{r.name}</b></td><td className="mono">{r.image}</td><td>{r.resources.cpus} CPU · {r.resources.memoryGb} GB</td><td>{r.network.egress}{r.network.egress === 'allowlist' ? ` (${r.network.allow.length} hosts)` : ''}</td><td>{isRole('factory_owner') && <><Btn small onClick={() => setEdit({ name: r.name, image: r.image, setup: r.setupCommands.join('\n'), cpus: String(r.resources.cpus), mem: String(r.resources.memoryGb), egress: r.network.egress, allow: r.network.allow.join('\n') })}>Edit</Btn><Btn small danger onClick={() => confirm(`Delete runner ${r.name}?`) && save.mutate({ runners: { [r.name]: null } })}>Delete</Btn></>}</td></tr>)}</tbody></table>
      {!data.runners.length && <Empty>No runners defined: the built-in default runner is used.</Empty>}
      {isRole('factory_owner') && <Btn onClick={() => setEdit({ name: '', image: 'ghcr.io/hexaware/zerovity-runner-node:20', setup: 'corepack enable\npnpm install --frozen-lockfile', cpus: '4', mem: '8', egress: 'allowlist', allow: 'registry.npmjs.org\ngithub.com\napi.anthropic.com\napi.openai.com\napi.githubcopilot.com\ncursor.sh\ncursor.com' })}>New runner</Btn>}
      {edit && <><div className="scrim on" onClick={() => setEdit(null)} /><div className="modal" role="dialog" aria-modal="true" aria-label="Runner"><div className="mhead"><h2>Runner</h2></div><div className="mbody">
        <label className="fld">Name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></label>
        <label className="fld">Image<input value={edit.image} onChange={(e) => setEdit({ ...edit, image: e.target.value })} /></label>
        <label className="fld">Setup commands (one per line)<textarea rows={3} value={edit.setup} onChange={(e) => setEdit({ ...edit, setup: e.target.value })} /></label>
        <div className="row3"><label className="fld">CPUs<input value={edit.cpus} onChange={(e) => setEdit({ ...edit, cpus: e.target.value })} /></label><label className="fld">Memory GB<input value={edit.mem} onChange={(e) => setEdit({ ...edit, mem: e.target.value })} /></label><label className="fld">Egress<select value={edit.egress} onChange={(e) => setEdit({ ...edit, egress: e.target.value })}><option>allowlist</option><option>open</option><option>none</option></select></label></div>
        {edit.egress === 'allowlist' && <label className="fld">Allowed hosts (one per line)<textarea rows={4} value={edit.allow} onChange={(e) => setEdit({ ...edit, allow: e.target.value })} /></label>}
        <div className="mfoot"><span /><Btn pri disabled={!edit.name || !edit.image} onClick={() => { save.mutate({ runners: { [edit.name]: { image: edit.image, setupCommands: edit.setup.split('\n').map((x) => x.trim()).filter(Boolean), resources: { cpus: Number(edit.cpus) || 2, memoryGb: Number(edit.mem) || 4 }, network: { egress: edit.egress, allow: edit.allow.split('\n').map((x) => x.trim()).filter(Boolean) } } } }); setEdit(null); }}>Save runner</Btn></div></div></div></>}
    </>
  );
}

function GatesTab() {
  const { factoryId, isRole } = useApp();
  const { data } = useApi<{ files: Record<string, string> }>(['definition', factoryId], `/factories/${factoryId}/definition`);
  const [text, setText] = useState<string | null>(null);
  const save = useSave();
  const cur = text ?? data?.files['policies/gates.yaml'] ?? '# policies/gates.yaml\ngates:\n  specApproval:\n    when: phase_completed\n    phase: SPEC\n    required: true\n    approvers: { groups: [tech-leads] }\n  questionTimeoutHours: 48\n  handoff:\n    required: true\nmerge:\n  agentsMayMerge: false\n';
  return (
    <>
      <p className="hint">Gates are data, so you can tighten them without editing prompts. Risk overrides add gates from triage output or touched paths, e.g. <span className="mono">triage.risk == "high"</span> adds <span className="mono">buildApproval</span>. <b>Agents may never merge</b>: this is not configurable.</p>
      <div className="editorbox" style={{ height: 340 }}><CodeEditor value={cur} language="yaml" path="policies/gates.yaml" readOnly={!isRole('factory_owner')} onChange={setText} height="100%" /></div>
      {isRole('factory_owner') && <div className="opts"><Btn pri disabled={text === null || save.isPending} onClick={() => save.mutate({ gates: cur })}>Validate and apply</Btn></div>}
    </>
  );
}

function PricesTab({ admin }: { admin: boolean }) {
  const { data } = useApi<Array<{ id: string; model: string; inputPerMtok: number; outputPerMtok: number; cachedPerMtok: number; perPremiumRequest: number | null; effectiveFrom: string }>>(['prices'], '/settings/prices');
  const [f, setF] = useState({ model: '', i: '', o: '', c: '', p: '' });
  const put = useAct(() => api('/settings/prices', { method: 'PUT', body: { model: f.model, inputPerMtok: Number(f.i), outputPerMtok: Number(f.o), cachedPerMtok: Number(f.c || 0), perPremiumRequest: f.p ? Number(f.p) : null } }), { invalidate: [['prices']], onSuccess: () => { toast('Price added; new runs use it'); setF({ model: '', i: '', o: '', c: '', p: '' }); }, onError: toastError });
  const latest = new Map<string, NonNullable<typeof data>[number]>();
  for (const r of data ?? []) if (!latest.has(r.model)) latest.set(r.model, r);
  return (
    <>
      <div className="banner warn">The starter prices are approximations. Review them before trusting cost numbers. A cost reported by the harness always wins over this table.</div>
      <table className="grid"><thead><tr><th>Model</th><th>Input $/Mtok</th><th>Output $/Mtok</th><th>Cached $/Mtok</th><th>Per premium request</th><th>Effective</th></tr></thead><tbody>{[...latest.values()].map((r) => <tr key={r.id}><td className="mono">{r.model}</td><td>{r.inputPerMtok}</td><td>{r.outputPerMtok}</td><td>{r.cachedPerMtok}</td><td>{r.perPremiumRequest ?? ''}</td><td>{fmtAgo(r.effectiveFrom)} ago</td></tr>)}</tbody></table>
      {admin && <div className="row5"><input placeholder="model" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} aria-label="Model" /><input placeholder="input" value={f.i} onChange={(e) => setF({ ...f, i: e.target.value })} aria-label="Input price" /><input placeholder="output" value={f.o} onChange={(e) => setF({ ...f, o: e.target.value })} aria-label="Output price" /><input placeholder="cached" value={f.c} onChange={(e) => setF({ ...f, c: e.target.value })} aria-label="Cached price" /><input placeholder="per request" value={f.p} onChange={(e) => setF({ ...f, p: e.target.value })} aria-label="Premium request price" /><Btn pri disabled={!f.model || !f.i || !f.o} onClick={() => put.mutate(undefined)}>Add / change</Btn></div>}
    </>
  );
}

function MembersTab({ admin }: { admin: boolean }) {
  const { me } = useApp();
  const { data } = useApi<Array<{ id: string; email: string; name: string; groups: string[]; memberships: Array<{ factoryId: string | null; role: string }> }>>(['members'], '/members');
  const [f, setF] = useState({ email: '', name: '', role: 'member', groups: '', scope: '' });
  const add = useAct(() => api('/members', { body: { email: f.email, name: f.name || f.email.split('@')[0], role: f.role, groups: f.groups.split(',').map((g) => g.trim()).filter(Boolean), factoryId: f.scope || null } }), { invalidate: [['members']], onSuccess: () => { toast('Member saved'); setF({ email: '', name: '', role: 'member', groups: '', scope: '' }); }, onError: toastError });
  const del = useAct((id: string) => api(`/members/${id}`, { method: 'DELETE' }), { invalidate: [['members']], onError: toastError });
  return (
    <>
      <p className="hint">Roles: <b>org_admin</b>, <b>factory_owner</b>, <b>approver</b> (can approve gates), <b>member</b> (can create and answer), <b>viewer</b>. Groups feed gate policies like <span className="mono">approvers: groups: [tech-leads]</span>.</p>
      <table className="grid"><thead><tr><th>Person</th><th>Roles</th><th>Groups</th><th /></tr></thead><tbody>{(data ?? []).map((m) => <tr key={m.id}><td><b>{m.name}</b><small> {m.email}</small></td><td>{m.memberships.map((x, i) => <Chip key={i}>{x.role}{x.factoryId ? ' (factory)' : ''}</Chip>)}</td><td>{m.groups.join(', ')}</td><td>{admin && m.id !== me.id && <Btn small danger onClick={() => confirm(`Remove ${m.email}?`) && del.mutate(m.id)}>Remove</Btn>}</td></tr>)}</tbody></table>
      {admin && <div className="row5"><input placeholder="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-label="Email" /><input placeholder="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Name" /><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="Role">{['viewer', 'member', 'approver', 'factory_owner', 'org_admin'].map((r) => <option key={r}>{r}</option>)}</select><input placeholder="groups, comma separated" value={f.groups} onChange={(e) => setF({ ...f, groups: e.target.value })} aria-label="Groups" /><Btn pri disabled={!f.email} onClick={() => add.mutate(undefined)}>Add / update</Btn></div>}
    </>
  );
}

function SecretsTab() {
  const { me, factoryId, isRole } = useApp();
  const [scope, setScope] = useState<'org' | 'factory'>('factory');
  const { data } = useApi<Array<{ id: string; name: string; last4: string; updatedAt: string }>>(['secrets', scope, factoryId], '/secrets', { scope, factoryId: scope === 'factory' ? factoryId : undefined }, { enabled: scope === 'factory' ? isRole('factory_owner') : me.role === 'org_admin' });
  const { data: st } = useSettings();
  const [f, setF] = useState({ name: '', value: '' });
  const put = useAct(() => api(`/secrets/${f.name}`, { method: 'PUT', body: { value: f.value, scope, factoryId: scope === 'factory' ? factoryId : undefined } }), { invalidate: [['secrets']], onSuccess: () => { toast('Stored encrypted. It is never shown again.'); setF({ name: '', value: '' }); }, onError: toastError });
  const del = useAct((n: string) => api(`/secrets/${n}`, { method: 'DELETE', query: { scope, factoryId: scope === 'factory' ? factoryId : undefined } }), { invalidate: [['secrets']], onError: toastError });
  const have = new Set((data ?? []).map((s) => s.name));
  return (
    <>
      <p className="hint">Secrets are write-only. Definitions reference them as <span className="mono">{'${secret:NAME}'}</span>; values are injected into a run's environment and never stored in definitions, events or logs. Factory scope wins over organisation scope.</p>
      <div className="chips"><button className={`chip link${scope === 'factory' ? ' on' : ''}`} onClick={() => setScope('factory')}>This factory</button>{me.role === 'org_admin' && <button className={`chip link${scope === 'org' ? ' on' : ''}`} onClick={() => setScope('org')}>Organisation</button>}</div>
      {st && st.secretsDeclared.length > 0 && <p>Declared by this factory: {st.secretsDeclared.map((s) => <Chip key={s} c={have.has(s) ? 'var(--ok)' : 'var(--gate)'}>{s}{have.has(s) ? '' : ' (not set at this scope)'}</Chip>)}</p>}
      <table className="grid"><tbody>{(data ?? []).map((s) => <tr key={s.id}><td className="mono">{s.name}</td><td className="mono">••••{s.last4}</td><td>{fmtAgo(s.updatedAt)} ago</td><td><Btn small danger onClick={() => confirm(`Delete ${s.name}?`) && del.mutate(s.name)}>Delete</Btn></td></tr>)}</tbody></table>
      <div className="row3"><input placeholder="NAME_IN_UPPER_SNAKE" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} aria-label="Secret name" /><input type="password" autoComplete="off" placeholder="value" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} aria-label="Secret value" /><Btn pri disabled={!f.name || !f.value} onClick={() => put.mutate(undefined)}>Store</Btn></div>
    </>
  );
}

function TokensTab() {
  const { data } = useApi<Array<{ id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string; expiresAt: string | null }>>(['tokens'], '/tokens');
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const create = useAct(() => api<{ token: string }>('/tokens', { body: { name } }), { invalidate: [['tokens']], onSuccess: (r) => { setFresh(r.token); setName(''); }, onError: toastError });
  const del = useAct((id: string) => api(`/tokens/${id}`, { method: 'DELETE' }), { invalidate: [['tokens']] });
  return (
    <>
      <p className="hint">Personal access tokens let your local Claude Code, Codex, Copilot or Cursor CLI talk to the factory MCP server and the REST API as you.</p>
      <table className="grid"><thead><tr><th>Name</th><th>Token</th><th>Last used</th><th /></tr></thead><tbody>{(data ?? []).map((t) => <tr key={t.id}><td>{t.name}</td><td className="mono">{t.prefix}…</td><td>{t.lastUsedAt ? `${fmtAgo(t.lastUsedAt)} ago` : 'never'}</td><td><Btn small danger onClick={() => del.mutate(t.id)}>Revoke</Btn></td></tr>)}</tbody></table>
      <div className="row3"><input placeholder="Token name, e.g. laptop" value={name} onChange={(e) => setName(e.target.value)} aria-label="Token name" /><Btn pri disabled={!name} onClick={() => create.mutate(undefined)}>Create token</Btn></div>
      {fresh && <div className="banner warn">Copy it now, it is not shown again: <code>{fresh}</code> <Btn small onClick={() => { void navigator.clipboard?.writeText(fresh); toast('Copied'); }}>Copy</Btn></div>}
    </>
  );
}

function McpTab() {
  const { data } = useApi<{ url: string; snippets: Record<string, string>; note: string }>(['static', 'mcp'], '/mcp-setup');
  if (!data) return null;
  const names: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex CLI', copilot: 'GitHub Copilot CLI', cursor: 'Cursor CLI' };
  return (
    <>
      <p className="hint">Endpoint: <code>{data.url}</code> (streamable HTTP). {data.note}</p>
      {Object.entries(data.snippets).map(([k, v]) => <div key={k} className="snippet"><div className="sect">{names[k] ?? k}<Btn small onClick={() => { void navigator.clipboard?.writeText(v); toast('Copied'); }}>Copy</Btn></div><pre>{v}</pre></div>)}
    </>
  );
}
