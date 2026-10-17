import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Btn, Chip, Empty, Seg, Spinner, fmtTokens } from '@zerovity/ui-kit';
import { api, useAct, useApi, type Issue } from '../api';
import { toast, toastError, useApp } from '../state';
import { CodeEditor } from '../ui/Editor';
import { Markdown } from '../ui/Markdown';

interface SkillRow { name: string; scope: string; source: string; description: string; version: string; phases: string[]; tokens: { body: number; description: number; total: number }; bodyLines: number; errors: number; warnings: number; usedBy: string[]; files: string[] }
interface Lint { issues: Issue[]; tokens: { body: number; description: number; total: number }; bodyLines: number }
const TEMPLATE = (n: string) => `---\nname: ${n}\ndescription: One sentence on what this skill does. Use when <the situation that should trigger it>.\nzerovity:\n  version: 1.0.0\n  phases: [BUILD]\n  consumes: [CONTEXT.md]\n  produces: []\n  escalate: Ask when <condition>.\n---\n\n# ${n}\n\n1. First step.\n2. Second step.\n\nRules:\n- Keep this under 150 lines. Put large material in references/*.md and say when to read each file.\n`;

export function SkillsPage() {
  const { factoryId, isRole } = useApp();
  const search = useSearch({ strict: false }) as { name?: string; scope?: string };
  const nav = useNavigate();
  const { data, isLoading } = useApi<{ skills: SkillRow[]; packs: Array<{ name: string; version: string; hash: string }> }>(['skills', factoryId], `/factories/${factoryId}/skills`);
  const [filter, setFilter] = useState<'all' | 'pack' | 'factory' | 'agent'>('all');
  const [q, setQ] = useState('');
  const [view, setView] = useState<'skills' | 'packs'>('skills');
  const rows = useMemo(() => (data?.skills ?? []).filter((s) => (filter === 'all' || s.scope.startsWith(filter)) && (!q || s.name.includes(q.toLowerCase()) || s.description.toLowerCase().includes(q.toLowerCase()))), [data, filter, q]);
  const selScope = search.scope ?? (search.name ? (data?.skills.find((s) => s.name === search.name && s.scope === 'factory') ? 'factory' : data?.skills.find((s) => s.name === search.name)?.scope) : undefined);
  const sel = rows.find((s) => s.name === search.name && s.scope === (selScope ?? s.scope)) ?? (search.name ? undefined : rows[0]);
  const [creating, setCreating] = useState(false);
  return (
    <div className="studio">
      <div className="slist">
        <div className="phead"><h1>Skills library</h1><div className="grow" />{isRole('factory_owner') && <Btn small onClick={() => setCreating(true)}>New skill</Btn>}</div>
        <Seg value={view} onChange={setView} options={[{ value: 'skills', label: 'Skills' }, { value: 'packs', label: 'Packs' }]} />
        {view === 'skills' && <>
          <input type="search" placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search skills" />
          <div className="chips">{(['all', 'pack', 'factory', 'agent'] as const).map((f) => <button key={f} className={`chip link${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>{f}</button>)}</div>
          {isLoading && <Spinner />}
          {rows.map((s) => (
            <button key={s.scope + s.name} className={`srow${sel?.name === s.name && sel.scope === s.scope ? ' sel' : ''}`} onClick={() => void nav({ to: '/skills', search: { name: s.name, scope: s.scope } as never })}>
              <b>{s.name}</b><span><span className={`layer ${s.scope.startsWith('pack') ? 'pack' : s.scope.startsWith('agent') ? 'agent' : 'factory'}`}>{s.scope === 'pack' ? `pack · ${s.source}` : s.scope}</span> {s.version && <small>v{s.version}</small>} {s.errors > 0 && <Chip c="var(--danger)">{s.errors} errors</Chip>}{s.warnings > 0 && <Chip c="var(--gate)">{s.warnings} warn</Chip>}</span>
              <small>{fmtTokens(s.tokens.description)} always · {fmtTokens(s.tokens.body)} on demand · used by {s.usedBy.length || 'no agent'}</small>
            </button>))}
        </>}
      </div>
      <div className="sdetail">
        {view === 'packs' ? <Packs packs={data?.packs ?? []} /> : sel ? <SkillEditor key={sel.scope + sel.name} s={sel} /> : <Empty>Select a skill, or create one.</Empty>}
      </div>
      {creating && <NewSkill onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewSkill({ onClose }: { onClose: () => void }) {
  const { factoryId } = useApp();
  const nav = useNavigate();
  const [n, setN] = useState('');
  const save = useAct(() => api<{ ok: boolean; issues: Issue[] }>(`/factories/${factoryId}/skills/${n}`, { method: 'PUT', body: { scope: 'factory', files: { 'SKILL.md': TEMPLATE(n) } } }), { invalidate: [['skills'], ['agents']], onSuccess: (r) => { if (!r.ok) return toast(r.issues.find((i) => i.severity === 'error')?.message ?? 'Invalid', 'error'); onClose(); void nav({ to: '/skills', search: { name: n, scope: 'factory' } as never }); }, onError: toastError });
  return (<><div className="scrim on" onClick={onClose} /><div className="modal small" role="dialog" aria-modal="true" aria-label="New skill"><div className="mhead"><h2>New skill</h2></div><div className="mbody"><label className="fld">Name<input autoFocus value={n} onChange={(e) => setN(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="acme-api-guidelines" /></label><p className="hint">One job per skill. It starts from a template that already passes lint.</p><div className="mfoot"><span /><Btn pri disabled={!n || save.isPending} onClick={() => save.mutate(undefined)}>Create</Btn></div></div></div></>);
}

function SkillEditor({ s }: { s: SkillRow }) {
  const { factoryId, isRole } = useApp();
  const nav = useNavigate();
  const owner = isRole('factory_owner');
  const editable = !s.scope.startsWith('pack');
  const { data, isLoading } = useApi<{ files: Record<string, string>; lint: Lint }>(['skill', factoryId, s.name, s.scope], `/factories/${factoryId}/skills/${s.name}`, { scope: s.scope === 'pack' ? `pack:${s.source}` : s.scope });
  const [files, setFiles] = useState<Record<string, string>>({});
  const [file, setFile] = useState('SKILL.md');
  const [lint, setLint] = useState<Lint | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { if (data) { setFiles(data.files); setLint(data.lint); } }, [data]);
  const dirty = data ? JSON.stringify(files) !== JSON.stringify(data.files) : false;
  const onChange = (v: string) => {
    const next = { ...files, [file]: v };
    setFiles(next);
    clearTimeout(t.current);
    t.current = setTimeout(() => { void api<Lint>('/skills/lint', { body: { name: s.name, files: next } }).then(setLint).catch(() => undefined); }, 350);
  };
  const save = useAct(() => api<{ ok: boolean; issues: Issue[] }>(`/factories/${factoryId}/skills/${s.name}`, { method: 'PUT', body: { scope: s.scope, files } }), { invalidate: [['skills'], ['skill'], ['agents']], onSuccess: (r) => { setIssues(r.issues); r.ok ? toast('Saved · the next run loads this version') : toast(r.issues.find((i) => i.severity === 'error')?.message ?? 'Not saved: fix the lint errors', 'error'); }, onError: toastError });
  const fork = useAct(() => api<{ ok: boolean }>(`/factories/${factoryId}/skills/${s.name}/fork`, { body: { from: `pack:${s.source}` } }), { invalidate: [['skills'], ['agents']], onSuccess: () => { toast('Forked into this factory: it now overrides the pack version'); void nav({ to: '/skills', search: { name: s.name, scope: 'factory' } as never }); }, onError: toastError });
  const del = useAct(() => api(`/factories/${factoryId}/skills/${s.name}`, { method: 'DELETE', query: { scope: s.scope } }), { invalidate: [['skills'], ['agents']], onSuccess: () => { toast('Skill removed'); void nav({ to: '/skills', search: {} as never }); }, onError: toastError });
  if (isLoading || !data) return <div className="pageload"><Spinner /></div>;
  const names = Object.keys(files).sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
  const body = (files['SKILL.md'] ?? '').replace(/^---[\s\S]*?\n---\n?/, '');
  const errs = lint?.issues.filter((i) => i.severity === 'error').length ?? 0;
  return (
    <div className="skedit">
      <div className="phead"><div><h1>{s.name}</h1><div className="sub"><span className={`layer ${s.scope.startsWith('pack') ? 'pack' : s.scope.startsWith('agent') ? 'agent' : 'factory'}`}>{s.scope === 'pack' ? `pack · ${s.source}` : s.scope}</span>{s.usedBy.map((u) => <Chip key={u}>{u}</Chip>)}</div></div><div className="grow" />
        {editable && owner && <Btn pri onClick={() => save.mutate(undefined)} disabled={!dirty || save.isPending}>Save</Btn>}
        {!editable && owner && <Btn pri onClick={() => fork.mutate(undefined)} disabled={fork.isPending}>Fork into this factory to edit</Btn>}
        {editable && owner && <Btn danger onClick={() => confirm(`Delete skill ${s.name}?`) && del.mutate(undefined)}>Delete</Btn>}</div>
      <div className="lintbar"><Chip c={errs ? 'var(--danger)' : 'var(--ok)'}>{errs ? `${errs} lint error${errs > 1 ? 's' : ''}` : 'lint clean'}</Chip><span className="mono">{lint?.bodyLines ?? 0}/150 lines</span><span className="mono">{fmtTokens(lint?.tokens.body ?? 0)}/2k tokens body</span><span className="mono">{fmtTokens(lint?.tokens.description ?? 0)} tokens always loaded (description)</span></div>
      <div className="filetabs">{names.map((n) => <button key={n} className={n === file ? 'on' : ''} onClick={() => setFile(n)}>{n}</button>)}{editable && owner && <button onClick={() => { const n = prompt('New file path (references/notes.md or scripts/check.sh)'); if (n && /^(references|scripts)\/[\w.\-/]+$/.test(n)) { setFiles({ ...files, [n]: '' }); setFile(n); } }}>+ file</button>}</div>
      <div className="split">
        <div className="editorbox"><CodeEditor value={files[file] ?? ''} language={file.endsWith('.md') ? 'markdown' : file.endsWith('.py') ? 'python' : file.endsWith('.js') ? 'javascript' : 'shell'} path={`skill-${s.name}/${file}`} readOnly={!editable || !owner} onChange={onChange} height="100%" onSave={() => editable && owner && save.mutate(undefined)}
          markers={(lint?.issues ?? []).filter((i) => i.file.endsWith(file) && i.line).map((i) => ({ line: i.line!, message: i.message, severity: i.severity }))} /></div>
        <div className="preview"><div className="sect">Preview</div>{file === 'SKILL.md' ? <Markdown text={body} /> : <pre className="logbox">{files[file]}</pre>}</div>
      </div>
      <ul className="issues">{[...(lint?.issues ?? []), ...issues].map((i, k) => <li key={k} className={i.severity}><b>{i.severity}</b> <span className="mono">{i.file}{i.line ? `:${i.line}` : ''}</span> {i.message} <small>{i.code}</small></li>)}</ul>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ packs */
function Packs({ packs }: { packs: Array<{ name: string; version: string; hash: string }> }) {
  const { factoryId, isRole, me } = useApp();
  const { data: all } = useApi<Array<{ name: string; version: string; description: string; skillCount: number; agentCount: number; source: string | null; hash: string }>>(['packs'], '/packs');
  const [git, setGit] = useState({ url: '', ref: '', subdir: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const [up, setUp] = useState<{ name: string; current: string | null; target: string; available: string[]; diff: { added: string[]; removed: string[]; changed: string[]; agentsAdded: string[]; agentsRemoved: string[]; agentsChanged: string[] } | null } | null>(null);
  const imp = useAct((a: { gitUrl?: string; file?: File }) => { if (a.file) { const fd = new FormData(); fd.append('file', a.file); return api<{ name: string; version: string; lintErrors: unknown[] }>('/packs/import', { form: fd }); } return api<{ name: string; version: string; lintErrors: unknown[] }>('/packs/import', { method: 'POST', query: { gitUrl: a.gitUrl, ref: git.ref || undefined, subdir: git.subdir || undefined } }); }, { invalidate: [['packs']], onSuccess: (r) => toast(`Imported ${r.name}@${r.version}${r.lintErrors.length ? ` (${r.lintErrors.length} skill(s) have lint errors)` : ''}`), onError: toastError });
  const preview = async (name: string, version?: string) => { try { setUp({ ...(await api<NonNullable<typeof up>>(`/factories/${factoryId}/packs/preview-upgrade`, { body: { name, version } })), name }); } catch (e) { toastError(e); } };
  const apply = useAct(() => api<{ ok: boolean; issues: Issue[] }>(`/factories/${factoryId}/packs/upgrade`, { body: { name: up!.name, version: up!.target } }), { invalidate: [['skills'], ['agents'], ['floor']], onSuccess: (r) => { if (r.ok) { toast(`Upgraded ${up!.name} to ${up!.target}`); setUp(null); } else toast(r.issues.find((i) => i.severity === 'error')?.message ?? 'Upgrade rejected', 'error'); }, onError: toastError });
  const installed = new Map(packs.map((p) => [p.name, p]));
  return (
    <div className="packs">
      <div className="phead"><h1>Skill packs</h1></div>
      <p className="hint">A pack is a versioned bundle of skills and agents. A factory pins exact versions and content hashes in zerovity.lock; upgrading shows a diff first.</p>
      <table className="grid"><thead><tr><th>Pack</th><th>Version</th><th>Skills</th><th>Agents</th><th>Source</th><th>In this factory</th><th /></tr></thead>
        <tbody>{(all ?? []).map((p) => { const inst = installed.get(p.name); return (
          <tr key={p.name + p.version}><td><b>{p.name}</b><small> {p.description}</small></td><td className="mono">{p.version}</td><td>{p.skillCount}</td><td>{p.agentCount}</td><td>{p.source}</td>
            <td>{inst ? (inst.version === p.version ? <Chip c="var(--ok)">pinned {inst.version}</Chip> : <Chip>pinned {inst.version}</Chip>) : ''}</td>
            <td>{isRole('factory_owner') && (!inst || inst.version !== p.version) && <Btn small onClick={() => void preview(p.name, p.version)}>{inst ? 'Preview upgrade' : 'Install'}</Btn>}</td></tr>); })}</tbody></table>
      {me.role === 'org_admin' && (
        <div className="importbox"><div className="sect">Import a pack</div>
          <div className="row3"><input placeholder="https://github.com/acme/skills.git" value={git.url} onChange={(e) => setGit({ ...git, url: e.target.value })} aria-label="Git URL" /><input placeholder="ref (optional)" value={git.ref} onChange={(e) => setGit({ ...git, ref: e.target.value })} aria-label="Git ref" /><input placeholder="subfolder (optional)" value={git.subdir} onChange={(e) => setGit({ ...git, subdir: e.target.value })} aria-label="Subfolder" /></div>
          <div className="opts"><Btn onClick={() => imp.mutate({ gitUrl: git.url })} disabled={!git.url || imp.isPending}>Import from Git</Btn><Btn onClick={() => fileRef.current?.click()}>Upload tarball (.tgz)</Btn><input ref={fileRef} hidden type="file" accept=".tgz,.tar.gz" onChange={(e) => e.target.files?.[0] && imp.mutate({ file: e.target.files[0] })} /></div></div>)}
      {up && (<><div className="scrim on" onClick={() => setUp(null)} /><div className="modal" role="dialog" aria-modal="true" aria-label="Pack upgrade"><div className="mhead"><h2>{up.current ? `Upgrade ${up.name}` : `Install ${up.name}`}</h2></div><div className="mbody">
        <p>{up.current ? <>From <b className="mono">{up.current}</b> to </> : 'Version '}<b className="mono">{up.target}</b></p>
        {up.diff ? (<div className="diffsum2">
          {(['added', 'changed', 'removed'] as const).map((k) => up.diff![k].length > 0 && <div key={k}><b>{k} skills:</b> {up.diff![k].join(', ')}</div>)}
          {(['agentsAdded', 'agentsChanged', 'agentsRemoved'] as const).map((k) => up.diff![k].length > 0 && <div key={k}><b>{k.replace('agents', 'agents ').toLowerCase()}:</b> {up.diff![k].join(', ')}</div>)}
          {!Object.values(up.diff).some((v) => v.length) && <div>No content changes.</div>}
        </div>) : <p>This adds the pack's skills and agents to the factory.</p>}
        <div className="mfoot"><span className="hint">The lockfile is regenerated and the definition re-validated. If validation fails nothing changes.</span><Btn pri onClick={() => apply.mutate(undefined)} disabled={apply.isPending}>{up.current ? 'Upgrade' : 'Install'}</Btn></div></div></div></>)}
    </div>
  );
}
