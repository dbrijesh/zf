import { useEffect, useState } from 'react';
import { Btn, Chip, Empty, Spinner, fmtAgo } from '@zerovity/ui-kit';
import { api, useAct, useApi, queryClient, type ConnType, type Connection } from '../api';
import { toast, toastError, useApp } from '../state';

const STATUS: Record<string, { label: string; c: string }> = { connected: { label: 'Connected', c: 'var(--ok)' }, needs_attention: { label: 'Needs attention', c: 'var(--gate)' }, expired: { label: 'Expired', c: 'var(--danger)' }, not_connected: { label: 'Not connected', c: 'var(--ink3)' } };
interface Mapped { mapped: Array<Connection & { mapping: Record<string, unknown> }>; repositories: Array<{ owner: string; name: string; defaultBranch: string }>; jira: Array<{ connection: string; project: string; label: string; statusMap?: Record<string, string> }>; agents: Array<{ name: string; credential: string | null; mcpServers: string[]; harness: string }>; mcpServers: string[] }

/** Connections (spec 12.3): catalogue, connect flows, tests, per-factory mapping, webhooks, health. */
export function ConnectionsPage() {
  const { factoryId, me, isRole } = useApp();
  const admin = me.role === 'org_admin';
  const { data: cat } = useApi<ConnType[]>(['static', 'catalogue'], '/connections/catalogue');
  const { data: conns, isLoading } = useApi<Connection[]>(['connections'], '/connections', undefined, { refetchInterval: 30_000 });
  const [adding, setAdding] = useState<ConnType | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const groups = [...new Set((cat ?? []).map((c) => c.group))];
  const check = useAct(() => api<{ checked: number; failing: number }>('/connections/check-all', { method: 'POST' }), { invalidate: [['connections'], ['floor'], ['inbox']], onSuccess: (r) => toast(r.failing ? `${r.failing} of ${r.checked} need attention` : `All ${r.checked} healthy`, r.failing ? 'error' : 'info'), onError: toastError });
  useEffect(() => { const h = (e: MessageEvent) => { if (e.data?.type === 'zf-oauth') { void queryClient.invalidateQueries({ queryKey: ['connections'] }); toast(e.data.ok ? 'Connected' : 'Authorisation did not complete', e.data.ok ? 'info' : 'error'); } }; window.addEventListener('message', h); return () => window.removeEventListener('message', h); }, []);
  const bad = (conns ?? []).filter((c) => c.status !== 'connected');
  return (
    <div className="conpage">
      <div className="phead"><h1>Connections</h1><div className="grow" />{admin && <Btn onClick={() => check.mutate(undefined)} disabled={check.isPending}>Check all now</Btn>}</div>
      {bad.length > 0 && <div className="banner warn">{bad.length} connection{bad.length > 1 ? 's' : ''} need attention: {bad.map((b) => b.displayName).join(', ')}. Factories using them may stall.</div>}
      {isLoading && <Spinner />}
      {groups.map((g) => (
        <section key={g} className="cgroup"><h2>{g}</h2>
          <div className="cards">
            {(conns ?? []).filter((c) => cat?.find((t) => t.id === c.typeId)?.group === g).map((c) => { const st = STATUS[c.status] ?? STATUS.not_connected; return (
              <article key={c.id} className="ccard" style={{ ['--c' as string]: st.c }}>
                <div className="k">{cat?.find((t) => t.id === c.typeId)?.title ?? c.provider}<Chip c={st.c}>{st.label}</Chip></div>
                <h3>{c.displayName}</h3>
                <p className="meta">{c.lastError ? c.lastError : c.lastCheckedAt ? `checked ${fmtAgo(c.lastCheckedAt)} ago` : 'not checked yet'}</p>
                <p className="meta">{c.secrets.map((s) => `${s.name} ••••${s.last4}`).join(' · ')}{c.expiresAt ? ` · expires ${new Date(c.expiresAt).toLocaleDateString()}` : ''}</p>
                <div className="opts"><Btn small onClick={() => setDetail(c.id)}>Manage</Btn></div>
              </article>); })}
            {(cat ?? []).filter((t) => t.group === g).map((t) => (
              <article key={t.id} className={`ccard ghost${t.v1 ? '' : ' soon'}`}>
                <div className="k">{t.title}{!t.v1 && <Chip>coming soon</Chip>}</div><p className="meta">{t.description}</p>
                {t.v1 && <div className="opts"><Btn small onClick={() => setAdding(t)} disabled={!admin} title={admin ? undefined : 'Organisation admins connect tools'}>Connect</Btn></div>}
              </article>))}
          </div>
        </section>
      ))}
      {factoryId && isRole('factory_owner') && <FactoryMapping />}
      <Webhooks />
      {adding && <ConnectModal t={adding} onClose={() => setAdding(null)} onDone={(c) => { setAdding(null); setDetail(c.id); }} />}
      {detail && <ManageModal id={detail} types={cat ?? []} onClose={() => setDetail(null)} />}
    </div>
  );
}

function ConnectModal({ t, onClose, onDone }: { t: ConnType; onClose: () => void; onDone: (c: Connection) => void }) {
  const [name, setName] = useState(t.title);
  const [v, setV] = useState<Record<string, string>>({});
  const create = useAct(() => api<Connection>('/connections', { body: { typeId: t.id, displayName: name, values: v } }), { invalidate: [['connections']], onSuccess: (c) => { toast(c.status === 'connected' ? 'Connected and tested' : c.lastError ?? 'Saved, but the test did not pass', c.status === 'connected' ? 'info' : 'error'); onDone(c); }, onError: toastError });
  const ok = t.fields.filter((f) => f.required).every((f) => v[f.name]?.trim()) && name.trim();
  return (<><div className="scrim on" onClick={onClose} /><div className="modal" role="dialog" aria-modal="true" aria-label={`Connect ${t.title}`}><div className="mhead"><h2>Connect {t.title}</h2></div><div className="mbody">
    <p className="hint">{t.description} Secrets go straight into the encrypted store and are shown only as ••••last4 afterwards.</p>
    <label className="fld">Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
    {t.fields.map((f) => <label className="fld" key={f.name}>{f.label}{f.required ? '' : ' (optional)'}{f.kind === 'textarea' ? <textarea rows={5} value={v[f.name] ?? ''} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} placeholder={f.placeholder} /> : <input type={f.secret ? 'password' : 'text'} autoComplete="off" value={v[f.name] ?? ''} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} placeholder={f.placeholder} />}{f.help && <small>{f.help}</small>}</label>)}
    <div className="mfoot"><span className="hint">{t.flow === 'popup-oauth' ? 'Next: authorise in a popup.' : 'A real call is made to test it.'}</span><Btn pri disabled={!ok || create.isPending} onClick={() => create.mutate(undefined)}>{create.isPending ? 'Connecting…' : 'Connect'}</Btn></div></div></div></>);
}

function ManageModal({ id, types, onClose }: { id: string; types: ConnType[]; onClose: () => void }) {
  const { data: c } = useApi<Connection>(['connection', id], `/connections/${id}`);
  const t = types.find((x) => x.id === c?.typeId);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [res, setRes] = useState<{ ok: boolean; detail: string } | null>(null);
  const [confirm, setConfirm] = useState<Connection['dependents'] | null>(null);
  const test = useAct(() => api<{ ok: boolean; detail: string }>(`/connections/${id}/test`, { method: 'POST' }), { invalidate: [['connections'], ['connection', id], ['floor'], ['inbox']], onSuccess: setRes, onError: toastError });
  const rotate = useAct(() => api(`/connections/${id}/rotate`, { body: { values: Object.fromEntries(Object.entries(vals).filter(([, x]) => x)) } }), { invalidate: [['connections'], ['connection', id]], onSuccess: () => { toast('Updated and re-tested'); setVals({}); }, onError: toastError });
  const del = useAct((force: boolean) => api<{ removed: boolean; dependents: NonNullable<Connection['dependents']> }>(`/connections/${id}`, { method: 'DELETE', query: { force } }), { invalidate: [['connections']], onSuccess: (r) => { if (r.removed) { toast('Disconnected'); onClose(); } else setConfirm(r.dependents); }, onError: toastError });
  const authorize = useAct(() => api<{ url: string }>(`/connections/${id}/authorize`, { method: 'POST' }), { onSuccess: (r) => { window.open(r.url, 'zf-oauth', 'width=620,height=760'); }, onError: toastError });
  if (!c || !t) return <><div className="scrim on" onClick={onClose} /><div className="modal"><Spinner /></div></>;
  const st = STATUS[c.status] ?? STATUS.not_connected;
  return (<><div className="scrim on" onClick={onClose} /><div className="modal" role="dialog" aria-modal="true" aria-label={c.displayName}><div className="mhead"><h2>{c.displayName}</h2><Chip c={st.c}>{st.label}</Chip></div><div className="mbody">
    <p className="meta">{t.title} · connected by {c.createdBy ?? 'unknown'} {fmtAgo(c.createdAt)} ago{c.scopes.length ? ` · scopes: ${c.scopes.join(', ')}` : ''}</p>
    {c.lastError && <div className="banner warn">{c.lastError}</div>}
    <div className="opts"><Btn pri onClick={() => test.mutate(undefined)} disabled={test.isPending}>{test.isPending ? 'Testing…' : 'Test'}</Btn>{(t.flow === 'popup-oauth' || (c.provider === 'github' && c.authKind === 'app')) && <Btn onClick={() => authorize.mutate(undefined)}>{t.flow === 'popup-oauth' ? 'Authorise in a popup' : 'Install the App'}</Btn>}</div>
    {res && <div className={`testres ${res.ok ? 'ok' : 'bad'}`}>{res.ok ? '✓' : '✗'} {res.detail}</div>}
    <div className="sect">Rotate or change</div>
    {t.fields.map((f) => <label className="fld" key={f.name}>{f.label}<input type={f.secret ? 'password' : 'text'} autoComplete="off" placeholder={f.secret ? (c.secrets.find((s) => s.name === f.name) ? `••••${c.secrets.find((s) => s.name === f.name)!.last4} (leave empty to keep)` : '') : String(c.config[f.name] ?? '')} value={vals[f.name] ?? ''} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} /></label>)}
    <div className="opts"><Btn onClick={() => rotate.mutate(undefined)} disabled={!Object.values(vals).some(Boolean) || rotate.isPending}>Save changes</Btn></div>
    {confirm && <div className="banner warn"><b>Still in use:</b> {[...confirm.factories.map((f) => `factory ${f.name}`), ...confirm.agents.map((a) => `${a.factory}/${a.agent}`), ...confirm.automations.map((a) => `automation ${a.automation}`)].join(', ')}. Disconnecting breaks them. <Btn danger small onClick={() => del.mutate(true)}>Disconnect anyway</Btn></div>}
    <div className="mfoot"><Btn danger onClick={() => del.mutate(false)}>Disconnect</Btn><Btn onClick={onClose}>Close</Btn></div></div></div></>);
}

function FactoryMapping() {
  const { factoryId } = useApp();
  const { data: m } = useApi<Mapped>(['mapping', factoryId], `/factories/${factoryId}/connections`);
  const { data: conns } = useApi<Connection[]>(['connections'], '/connections');
  const [forgeId, setForgeId] = useState('');
  const [q, setQ] = useState('');
  const forges = (conns ?? []).filter((c) => c.type === 'forge');
  const trackers = (conns ?? []).filter((c) => c.type === 'tracker');
  const fid = forgeId || forges[0]?.id || '';
  const { data: repos, isFetching } = useApi<Array<{ owner: string; name: string; fullName: string; defaultBranch: string }>>(['repos', fid, q], fid ? `/connections/${fid}/repos` : null, { q: q || undefined }, { enabled: !!fid });
  const sel = new Set((m?.repositories ?? []).map((r) => `${r.owner}/${r.name}`));
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const cur = picked ?? sel;
  const saveRepos = useAct(() => api<{ applied: boolean; pr?: { url: string }; issues?: Array<{ message: string; severity: string }> }>(`/factories/${factoryId}/connections/${fid}`, { method: 'PUT', body: { mapping: { repos: [...cur].map((s) => { const [owner, name] = s.split('/'); return { owner, name, defaultBranch: repos?.find((r) => r.fullName === s)?.defaultBranch ?? m?.repositories.find((r) => r.owner === owner && r.name === name)?.defaultBranch ?? 'main' }; }) } } }), { invalidate: [['mapping'], ['factory'], ['floor'], ['definition']], onSuccess: (r) => { setPicked(null); toast(r.pr ? `Opened a PR on the definition repo: ${r.pr.url}` : r.applied ? 'Mapped. The definition was updated.' : r.issues?.find((i) => i.severity === 'error')?.message ?? 'Not applied', r.applied || r.pr ? 'info' : 'error'); }, onError: toastError });
  const [jiraConn, setJiraConn] = useState('');
  const tid = jiraConn || trackers[0]?.id || '';
  const { data: projects } = useApi<Array<{ key: string; name: string }>>(['projects', tid], tid ? `/connections/${tid}/projects` : null, undefined, { enabled: !!tid });
  const [jp, setJp] = useState({ project: '', label: 'zerovity', status: '' });
  const saveJira = useAct(() => api(`/factories/${factoryId}/connections/${tid}`, { method: 'PUT', body: { mapping: { jira: [...(m?.jira.filter((j) => j.connection === trackers.find((t) => t.id === tid)?.displayName).map((j) => ({ project: j.project, label: j.label, statusMap: j.statusMap })) ?? []).filter((j) => j.project !== jp.project), { project: jp.project, label: jp.label, statusMap: jp.status ? { AWAITING_HANDOFF: jp.status } : undefined }] } } }), { invalidate: [['mapping'], ['definition']], onSuccess: () => toast('Jira project mapped'), onError: toastError });
  const assign = useAct((a: { agent: string; credential?: string | null; mcpServers?: string[] }) => api(`/factories/${factoryId}/agents/${a.agent}/assignment`, { method: 'PUT', body: { credential: a.credential, mcpServers: a.mcpServers } }), { invalidate: [['mapping'], ['agents']], onSuccess: () => toast('Assignment saved'), onError: toastError });
  if (!m) return null;
  return (
    <section className="cgroup mapping"><h2>This factory uses</h2>
      <p className="hint">Changes here are written back into the factory definition, so the definition stays the source of truth. Git-backed factories get a pull request instead.</p>
      <div className="mapgrid">
        <div className="mapbox"><h3>Repositories</h3>
          {forges.length === 0 ? <Empty>Connect GitHub first.</Empty> : <>
            {forges.length > 1 && <select value={fid} onChange={(e) => setForgeId(e.target.value)} aria-label="GitHub connection">{forges.map((f) => <option key={f.id} value={f.id}>{f.displayName}</option>)}</select>}
            <input type="search" placeholder="Search repositories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search repositories" />
            <ul className="picklist">{isFetching && <li><Spinner /></li>}{[...new Map([...(repos ?? []).map((r) => [r.fullName, r.fullName] as const), ...[...sel].map((s) => [s, s] as const)]).keys()].map((n) => <li key={n}><label><input type="checkbox" checked={cur.has(n)} onChange={(e) => { const nx = new Set(cur); e.target.checked ? nx.add(n) : nx.delete(n); setPicked(nx); }} />{n}</label></li>)}</ul>
            <Btn pri small onClick={() => saveRepos.mutate(undefined)} disabled={!picked || saveRepos.isPending}>Save repositories</Btn></>}
        </div>
        <div className="mapbox"><h3>Jira projects</h3>
          {trackers.length === 0 ? <Empty>Connect Jira first.</Empty> : <>
            <ul className="picklist">{m.jira.map((j) => <li key={j.connection + j.project}>{j.project} · label <b>{j.label}</b>{j.statusMap ? ` · handoff → ${Object.values(j.statusMap)[0]}` : ''}</li>)}</ul>
            <div className="row2"><select value={jp.project} onChange={(e) => setJp({ ...jp, project: e.target.value })} aria-label="Jira project"><option value="">Pick a project…</option>{projects?.map((p) => <option key={p.key} value={p.key}>{p.key} · {p.name}</option>)}</select><input value={jp.label} onChange={(e) => setJp({ ...jp, label: e.target.value })} aria-label="Intake label" /></div>
            <input placeholder="Optional: move to this status at handoff (e.g. In Review)" value={jp.status} onChange={(e) => setJp({ ...jp, status: e.target.value })} aria-label="Handoff status" />
            {trackers.length > 1 && <select value={tid} onChange={(e) => setJiraConn(e.target.value)} aria-label="Jira connection">{trackers.map((f) => <option key={f.id} value={f.id}>{f.displayName}</option>)}</select>}
            <Btn pri small onClick={() => saveJira.mutate(undefined)} disabled={!jp.project || saveJira.isPending}>Add project</Btn></>}
        </div>
        <div className="mapbox wide"><h3>Agents: credentials and MCP servers</h3>
          <table className="grid"><thead><tr><th>Agent</th><th>Harness</th><th>Credential</th><th>MCP servers</th></tr></thead><tbody>{m.agents.map((a) => (
            <tr key={a.name}><td>{a.name}</td><td>{a.harness}</td>
              <td><select value={a.credential ?? ''} onChange={(e) => assign.mutate({ agent: a.name, credential: e.target.value || null })} aria-label={`Credential for ${a.name}`}><option value="">default</option>{(conns ?? []).filter((c) => c.type === 'harness').map((c) => <option key={c.id} value={c.displayName}>{c.displayName}</option>)}</select></td>
              <td className="checks">{m.mcpServers.map((s) => <label key={s}><input type="checkbox" checked={a.mcpServers.includes(s)} onChange={(e) => assign.mutate({ agent: a.name, mcpServers: e.target.checked ? [...a.mcpServers, s] : a.mcpServers.filter((x) => x !== s) })} />{s}</label>)}{!m.mcpServers.length && <small>none declared</small>}</td></tr>))}</tbody></table>
        </div>
      </div>
    </section>
  );
}

function Webhooks() {
  const { factoryId, isRole } = useApp();
  const { data } = useApi<{ inbound: Array<{ id: string; name: string; url: string; secretLast4: string; factoryId: string }>; github: { url: string; events: string[] }; jira: Array<{ connection: string; url: string; events: string[] }> }>(['webhooks'], '/webhooks');
  const { data: dl } = useApi<Array<{ id: string; provider: string; event: string | null; status: string; detail: string | null; createdAt: string }>>(['deliveries'], '/webhooks/deliveries', { limit: 12 }, { refetchInterval: 20_000 });
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const create = useAct(() => api<{ url: string; secret: string }>('/webhooks', { body: { name, factoryId } }), { invalidate: [['webhooks']], onSuccess: (r) => { setSecret(r); setName(''); }, onError: toastError });
  const rotate = useAct((id: string) => api<{ url: string; secret: string }>(`/webhooks/${id}/rotate`, { method: 'POST' }), { invalidate: [['webhooks']], onSuccess: setSecret, onError: toastError });
  const del = useAct((id: string) => api(`/webhooks/${id}`, { method: 'DELETE' }), { invalidate: [['webhooks']] });
  if (!data) return null;
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); toast('Copied'); };
  return (
    <section className="cgroup"><h2>Webhooks</h2>
      <div className="mapgrid">
        <div className="mapbox"><h3>GitHub</h3><p className="hint">Point the App or repository webhook here. Events: {data.github.events.join(', ')}.</p><code className="urlbox" onClick={() => copy(data.github.url)}>{data.github.url}</code></div>
        <div className="mapbox"><h3>Jira</h3>{data.jira.length ? data.jira.map((j) => <div key={j.url}><b>{j.connection}</b><code className="urlbox" onClick={() => copy(j.url)}>{j.url}</code></div>) : <p className="hint">Connect Jira to get a webhook URL.</p>}<p className="hint">Events: jira:issue_created, jira:issue_updated, comment_created.</p></div>
        <div className="mapbox"><h3>Inbound automation webhooks</h3>
          <ul className="picklist">{data.inbound.map((h) => <li key={h.id}><b>{h.name}</b> <code className="urlbox" onClick={() => copy(h.url)}>{h.url}</code> secret ••••{h.secretLast4}{isRole('factory_owner') && <><Btn small onClick={() => rotate.mutate(h.id)}>Rotate</Btn><Btn small danger onClick={() => del.mutate(h.id)}>Delete</Btn></>}</li>)}</ul>
          {isRole('factory_owner') && <div className="row2"><input placeholder="name, matches the automation trigger" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} aria-label="Webhook name" /><Btn small pri disabled={!name} onClick={() => create.mutate(undefined)}>Create</Btn></div>}
          {secret && <div className="banner warn">Copy this secret now: <code>{secret.secret}</code> (send as the <code>x-zerovity-secret</code> header)<Btn small onClick={() => copy(secret.secret)}>Copy</Btn><Btn small onClick={() => setSecret(null)}>Done</Btn></div>}
        </div>
      </div>
      <div className="sect">Recent deliveries</div>
      <table className="grid mini"><tbody>{(dl ?? []).map((d) => <tr key={d.id}><td>{fmtAgo(d.createdAt)}</td><td>{d.provider}</td><td>{d.event}</td><td><span className={`st ${d.status === 'processed' ? 'done' : 'failed'}`}>{d.status}</span></td><td className="mono">{d.detail}</td></tr>)}</tbody></table>
    </section>
  );
}
