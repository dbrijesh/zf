import { useEffect, useMemo, useState } from 'react';
import { Btn, Chip, Empty, Spinner, fmtAgo } from '@zerovity/ui-kit';
import { api, useAct, useApi, type Issue } from '../api';
import { toast, toastError, useApp } from '../state';
import { CodeEditor } from '../ui/Editor';

interface Def { commit: string | null; source: string; repo: { owner: string; name: string; branch: string; path: string } | null; readOnly: boolean; files: Record<string, string>; valid: boolean; issues: Issue[]; latestCommit?: string; latestValid: boolean; history: Array<{ commit: string; seq: number; message: string; valid: boolean; appliedAt: string | null; appliedBy: string | null; createdAt: string; issues: Issue[] }> }

const langOf = (p: string) => (/\.ya?ml$|zerovity\.lock$/.test(p) ? 'yaml' : p.endsWith('.md') ? 'markdown' : p.endsWith('.json') ? 'json' : p.endsWith('.sh') ? 'shell' : 'plaintext');

/** Factory-as-code editor (spec 12.2 #8): file tree, Monaco with JSON Schema completion, validate on save, commit with a message. */
export function DefinitionPage() {
  const { factoryId, isRole } = useApp();
  const { data, isLoading } = useApi<Def>(['definition', factoryId], `/factories/${factoryId}/definition`);
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [file, setFile] = useState('zerovity.factory.yaml');
  const [msg, setMsg] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [tab, setTab] = useState<'issues' | 'history'>('issues');
  useEffect(() => { if (data) { setIssues(data.latestValid ? [] : data.issues); } }, [data]);
  const files = useMemo(() => { const m: Record<string, string> = { ...(data?.files ?? {}) }; for (const [k, v] of Object.entries(draft)) { if (v === null) delete m[k]; else m[k] = v; } return m; }, [data, draft]);
  const paths = Object.keys(files).sort((a, b) => (a === 'zerovity.factory.yaml' ? -1 : b === 'zerovity.factory.yaml' ? 1 : a.localeCompare(b)));
  const dirty = Object.keys(draft).length > 0;
  const owner = isRole('factory_owner') && !data?.readOnly;
  const validate = useAct(() => api<{ ok: boolean; issues: Issue[] }>(`/factories/${factoryId}/definition/validate`, { body: { files: draft } }), { onSuccess: (r) => { setIssues(r.issues); setTab('issues'); toast(r.ok ? 'Definition is valid' : `${r.issues.filter((i) => i.severity === 'error').length} problem(s) found`, r.ok ? 'info' : 'error'); }, onError: toastError });
  const save = useAct(() => api<{ ok: boolean; commit: string; issues: Issue[]; applied: boolean }>(`/factories/${factoryId}/definition`, { method: 'PUT', body: { files: draft, message: msg || 'Edit definition' } }), {
    invalidate: [['definition'], ['agents'], ['skills'], ['floor'], ['context']], onSuccess: (r) => { setIssues(r.issues); setTab('issues'); if (r.applied) { toast(`Applied as ${r.commit}`); setDraft({}); setMsg(''); } else toast('Not applied: the factory keeps its last valid definition', 'error'); }, onError: toastError });
  const rollback = useAct((commit: string) => api(`/factories/${factoryId}/definition/rollback`, { body: { commit } }), { invalidate: [['definition'], ['agents'], ['skills'], ['floor']], onSuccess: () => { toast('Rolled back'); setDraft({}); }, onError: toastError });
  const sync = useAct(() => api(`/factories/${factoryId}/definition/sync`, { method: 'POST' }), { invalidate: [['definition']], onSuccess: () => toast('Synced from Git'), onError: toastError });
  if (isLoading || !data) return <div className="pageload"><Spinner /></div>;
  const markers = issues.filter((i) => i.file === file && i.line).map((i) => ({ line: i.line!, col: i.col, message: i.message, severity: i.severity }));
  const addFile = () => { const p = prompt('New file path, e.g. agents/my-agent/agent.md, skills/my-skill/SKILL.md, runners/node.yaml, context/standards.md'); if (!p) return; if (p.includes('..') || p.startsWith('/')) return toast('Invalid path', 'error'); setDraft({ ...draft, [p]: '' }); setFile(p); };
  return (
    <div className="defpage">
      <div className="phead"><div><h1>Definition</h1><div className="sub"><Chip>{data.source === 'git' ? 'Git-backed' : 'stored in Zerovity'}</Chip><Chip c={data.valid ? 'var(--ok)' : 'var(--danger)'}>commit {data.commit ?? 'none'}</Chip>{!data.latestValid && <Chip c="var(--gate)" title="The last save was rejected; the factory runs on the previous valid commit">latest save rejected</Chip>}</div></div><div className="grow" />
        {data.readOnly && data.repo && <><a className="btn" href={`https://github.com/${data.repo.owner}/${data.repo.name}/tree/${data.repo.branch}/${data.repo.path}`} target="_blank" rel="noreferrer">Open the repository ↗</a>{isRole('factory_owner') && <Btn onClick={() => sync.mutate(undefined)} disabled={sync.isPending}>Sync now</Btn>}</>}
        {owner && <><Btn onClick={() => validate.mutate(undefined)} disabled={!dirty || validate.isPending}>Validate</Btn><Btn pri onClick={() => save.mutate(undefined)} disabled={!dirty || save.isPending}>{save.isPending ? 'Validating…' : 'Save and apply'}</Btn></>}</div>
      {data.readOnly && <div className="banner">This factory's definition lives in <b>{data.repo?.owner}/{data.repo?.name}</b>. Changes arrive by pull request; the <span className="mono">zerovity/factory-config</span> check validates them. Edits here are read-only.</div>}
      <div className="defgrid">
        <div className="tree" role="tree">
          {paths.map((p) => (
            <button key={p} role="treeitem" aria-selected={p === file} className={`${p === file ? 'sel' : ''}${draft[p] !== undefined ? ' dirty' : ''}${issues.some((i) => i.file === p && i.severity === 'error') ? ' bad' : ''}`} onClick={() => setFile(p)} title={p}>
              <span className="mono">{p}</span>{draft[p] !== undefined && <i title="unsaved">●</i>}
            </button>))}
          {owner && <Btn small onClick={addFile}>+ New file</Btn>}
        </div>
        <div className="defedit">
          <div className="filetabs"><button className="on mono">{file}</button>{owner && file !== 'zerovity.factory.yaml' && <button onClick={() => { if (confirm(`Delete ${file}?`)) { setDraft({ ...draft, [file]: null }); setFile('zerovity.factory.yaml'); } }}>delete file</button>}{draft[file] !== undefined && <button onClick={() => { const { [file]: _, ...rest } = draft; setDraft(rest); }}>revert file</button>}</div>
          <div className="editorbox grow"><CodeEditor key={file} value={files[file] ?? ''} language={langOf(file)} path={file} readOnly={!owner} height="100%" markers={markers} onChange={(v) => setDraft({ ...draft, [file]: v })} onSave={() => owner && dirty && save.mutate(undefined)} /></div>
          {owner && <div className="commitbar"><input placeholder="Commit message" value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Commit message" /><span className="hint">Every save is a commit. Invalid definitions are stored but never applied.</span></div>}
        </div>
      </div>
      <div className="defbottom">
        <div className="filetabs"><button className={tab === 'issues' ? 'on' : ''} onClick={() => setTab('issues')}>Problems {issues.filter((i) => i.severity === 'error').length || ''}</button><button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button></div>
        {tab === 'issues' ? (issues.length ? <ul className="issues">{issues.map((i, k) => <li key={k} className={i.severity} onClick={() => paths.includes(i.file) && setFile(i.file)}><b>{i.severity}</b> <span className="mono">{i.file}{i.line ? `:${i.line}` : ''}</span> {i.message} <small>{i.code}</small></li>)}</ul> : <Empty>No problems.</Empty>)
          : <ul className="versions">{data.history.map((h) => <li key={h.commit}><b className="mono">{h.commit}</b> {h.message || '(no message)'} <Chip c={h.valid ? 'var(--ok)' : 'var(--danger)'}>{h.valid ? (h.commit === data.commit ? 'active' : 'valid') : 'rejected'}</Chip><small>{h.appliedBy ?? ''} · {fmtAgo(h.createdAt)} ago</small>{owner && h.valid && h.commit !== data.commit && <Btn small onClick={() => confirm(`Roll back to ${h.commit}?`) && rollback.mutate(h.commit)}>Roll back</Btn>}</li>)}</ul>}
      </div>
    </div>
  );
}
