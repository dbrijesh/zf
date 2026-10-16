import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Btn, Chip, Empty, Spinner, fmtAgo, fmtTokens, downloadHref } from './shared';
import { api, downloadUrl, useAct, useApi, type ContextItem } from '../api';
import { toast, toastError, useApp } from '../state';
import { CodeEditor } from '../ui/Editor';

const LAYERS = ['all', 'org', 'factory', 'repo', 'workItem', 'phase'];

/** Context library (spec 9.5): list, search, tag filter, editor, upload, URL snapshot, version history. */
export function ContextPage() {
  const { factoryId, me, isRole } = useApp();
  const search = useSearch({ strict: false }) as { id?: string };
  const nav = useNavigate();
  const [layer, setLayer] = useState('all');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const { data, isLoading } = useApi<ContextItem[]>(['context', factoryId, layer, q, tag], '/context', { factoryId, layer: layer === 'all' ? undefined : layer, q: q || undefined, tag: tag || undefined }, { placeholderData: (p) => p });
  const tags = useMemo(() => [...new Set((data ?? []).flatMap((i) => i.tags))].sort(), [data]);
  const sel = data?.find((i) => i.id === search.id) ?? undefined;
  const [adding, setAdding] = useState<null | 'note' | 'url'>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<'factory' | 'org'>('factory');
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append('file', f);
    try { const r = await api<ContextItem>('/context/file', { form: fd, query: { layer: scope, scopeId: scope === 'factory' ? factoryId : '' } }); toast(`${f.name} added (${fmtTokens(r.tokenCount)} tokens)`); void nav({ to: '/context', search: { id: r.id } as never }); await refetchAll(); } catch (e) { toastError(e); }
  };
  const refetchAll = async () => { const { queryClient } = await import('../api'); await queryClient.invalidateQueries({ queryKey: ['context'] }); };
  return (
    <div className="studio">
      <div className="slist">
        <div className="phead"><h1>Context library</h1><div className="grow" /></div>
        <p className="hint">Everything agents know beyond the code: standards, glossaries, ADRs, documents, links. Layers merge org, factory, repo, work item, phase.</p>
        <input type="search" placeholder="Search title, text, tags" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search context" />
        <div className="chips">{LAYERS.map((l) => <button key={l} className={`chip link${layer === l ? ' on' : ''}`} onClick={() => setLayer(l)}>{l}</button>)}</div>
        {tags.length > 0 && <div className="chips">{tags.slice(0, 14).map((t) => <button key={t} className={`chip link${tag === t ? ' on' : ''}`} onClick={() => setTag(tag === t ? '' : t)}>#{t}</button>)}</div>}
        {isRole('member') && (
          <div className="opts"><select value={scope} onChange={(e) => setScope(e.target.value as 'factory' | 'org')} aria-label="Layer for new items"><option value="factory">Factory layer</option>{me.role === 'org_admin' && <option value="org">Organisation layer</option>}</select>
            <Btn small onClick={() => setAdding('note')}>Note</Btn><Btn small onClick={() => setAdding('url')}>URL snapshot</Btn><Btn small onClick={() => fileRef.current?.click()}>Upload file</Btn>
            <input ref={fileRef} hidden type="file" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} /></div>)}
        {isLoading && <Spinner />}
        {(data ?? []).map((i) => (
          <button key={i.id} className={`srow${sel?.id === i.id ? ' sel' : ''}`} onClick={() => void nav({ to: '/context', search: { id: i.id } as never })}>
            <b>{i.title}</b><span><Chip>{i.layer}</Chip> <Chip>{i.kind}</Chip> <small>{i.priority}</small></span><small>{fmtTokens(i.tokenCount)} tokens · v{i.version} · {fmtAgo(i.updatedAt)}{!i.enabled ? ' · disabled' : ''}</small>
          </button>))}
        {!isLoading && !data?.length && <Empty>No context items. Add a note, upload a document or snapshot a URL.</Empty>}
      </div>
      <div className="sdetail">{sel ? <ItemEditor key={sel.id + sel.version} item={sel} /> : <Empty>Select an item to edit it, or add one.</Empty>}</div>
      {adding && <AddModal kind={adding} scope={scope} onClose={() => setAdding(null)} onDone={(id) => { setAdding(null); void nav({ to: '/context', search: { id } as never }); }} />}
    </div>
  );
}

function AddModal({ kind, scope, onClose, onDone }: { kind: 'note' | 'url'; scope: 'factory' | 'org'; onClose: () => void; onDone: (id: string) => void }) {
  const { factoryId } = useApp();
  const [f, setF] = useState({ title: '', body: '', url: '', k: 'note', priority: 'always', tags: '' });
  const save = useAct(() => kind === 'url'
    ? api<ContextItem>('/context/url', { body: { layer: scope, scopeId: scope === 'factory' ? factoryId : '', url: f.url, title: f.title || undefined, priority: f.priority, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) } })
    : api<ContextItem>('/context', { body: { layer: scope, scopeId: scope === 'factory' ? factoryId : '', title: f.title, body: f.body, kind: f.k, priority: f.priority, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) } }), { invalidate: [['context']], onSuccess: (r) => { toast('Added'); onDone(r.id); }, onError: toastError });
  return (<><div className="scrim on" onClick={onClose} /><div className="modal" role="dialog" aria-modal="true" aria-label="Add context"><div className="mhead"><h2>{kind === 'url' ? 'Snapshot a URL' : 'New context item'}</h2></div><div className="mbody">
    <label className="fld">Title<input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={kind === 'url' ? 'optional: taken from the page' : 'Payments security policy'} /></label>
    {kind === 'url' ? <label className="fld">URL<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://wiki.example.com/refund-policy" /></label> : <>
      <label className="fld">Type<select value={f.k} onChange={(e) => setF({ ...f, k: e.target.value })}><option value="note">Note (Markdown)</option><option value="glossary">Glossary entry</option><option value="adr">ADR</option><option value="repoPointer">Repo path pointer</option></select></label>
      <label className="fld">Body<textarea rows={8} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="Markdown" /></label></>}
    <div className="row2"><label className="fld">Priority<select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="always">always: in CONTEXT.md</option><option value="relevant">relevant: if it fits the budget</option><option value="on_request">on request: index only</option></select></label><label className="fld">Tags<input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="security, payments" /></label></div>
    <div className="mfoot"><span className="hint">Saved to the {scope} layer</span><Btn pri disabled={save.isPending || (kind === 'url' ? !f.url : !f.title)} onClick={() => save.mutate(undefined)}>Add</Btn></div></div></div></>);
}

function ItemEditor({ item }: { item: ContextItem }) {
  const { me, isRole } = useApp();
  const can = item.layer === 'org' ? me.role === 'org_admin' : isRole(item.layer === 'workItem' ? 'member' : 'factory_owner');
  const [d, setD] = useState({ title: item.title, body: item.body, tags: item.tags.join(', '), priority: item.priority, enabled: item.enabled, phases: item.appliesTo.phases.join(', '), agents: item.appliesTo.agents.join(', ') });
  const dirty = d.title !== item.title || d.body !== item.body || d.tags !== item.tags.join(', ') || d.priority !== item.priority || d.enabled !== item.enabled || d.phases !== item.appliesTo.phases.join(', ') || d.agents !== item.appliesTo.agents.join(', ');
  const { data: versions } = useApi<Array<{ id: string; version: number; title: string; changedBy: string | null; createdAt: string }>>(['ctxver', item.id], `/context/${item.id}/versions`);
  const nav = useNavigate();
  const save = useAct(() => api(`/context/${item.id}`, { method: 'PATCH', body: { title: d.title, body: d.body, tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean), priority: d.priority, enabled: d.enabled, appliesTo: { phases: d.phases.split(',').map((x) => x.trim()).filter(Boolean), agents: d.agents.split(',').map((x) => x.trim()).filter(Boolean) } } }), { invalidate: [['context'], ['ctxver'], ['ctxPreview']], onSuccess: () => toast('Saved'), onError: toastError });
  const del = useAct(() => api(`/context/${item.id}`, { method: 'DELETE' }), { invalidate: [['context']], onSuccess: () => { toast('Deleted'); void nav({ to: '/context', search: {} as never }); }, onError: toastError });
  const refresh = useAct(() => api(`/context/${item.id}/refresh`, { method: 'POST' }), { invalidate: [['context'], ['ctxver']], onSuccess: () => toast('Snapshot refreshed'), onError: toastError });
  const restore = useAct((version: number) => api(`/context/${item.id}/restore`, { body: { version } }), { invalidate: [['context'], ['ctxver']], onSuccess: () => toast('Restored as a new version'), onError: toastError });
  useEffect(() => undefined, []);
  const meta = item.meta as { url?: string; originalName?: string; fetchedAt?: string; convertedAs?: string; described?: boolean };
  return (
    <div className="aedit">
      <div className="phead"><div><h1>{item.title}</h1><div className="sub"><Chip>{item.layer}</Chip><Chip>{item.kind}</Chip><Chip>{fmtTokens(item.tokenCount)} tokens</Chip><Chip>v{item.version}</Chip>{!can && <Chip c="var(--gate)">read-only for your role</Chip>}</div></div><div className="grow" />
        {can && <Btn pri onClick={() => save.mutate(undefined)} disabled={!dirty || save.isPending}>Save</Btn>}
        {item.kind === 'url' && can && <Btn onClick={() => refresh.mutate(undefined)} disabled={refresh.isPending}>Refresh snapshot</Btn>}
        {item.kind === 'file' && <a className="btn" href={downloadUrl(`/context/${item.id}/original`)}>Download original</a>}
        {can && <Btn danger onClick={() => confirm('Delete this item?') && del.mutate(undefined)}>Delete</Btn>}</div>
      {meta.url && <p className="hint">Snapshot of <a href={meta.url} target="_blank" rel="noreferrer">{meta.url}</a>{meta.fetchedAt ? ` taken ${new Date(meta.fetchedAt).toLocaleString()}` : ''}</p>}
      {meta.originalName && <p className="hint">Converted from <b>{meta.originalName}</b> as {meta.convertedAs}{meta.described ? ' (described, not extracted: check the text)' : ''}. The original is stored.</p>}
      <fieldset disabled={!can} className="form">
        <label className="fld">Title<input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></label>
        <div className="row3"><label className="fld">Priority<select value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value })}><option value="always">always</option><option value="relevant">relevant</option><option value="on_request">on request</option></select></label>
          <label className="fld">Tags<input value={d.tags} onChange={(e) => setD({ ...d, tags: e.target.value })} /></label>
          <label className="fld chk"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />Enabled</label></div>
        <div className="row2"><label className="fld">Only for phases<input value={d.phases} onChange={(e) => setD({ ...d, phases: e.target.value })} placeholder="all, or e.g. BUILD, VERIFY" /></label><label className="fld">Only for agents<input value={d.agents} onChange={(e) => setD({ ...d, agents: e.target.value })} placeholder="all, or e.g. zerovity-executor" /></label></div>
      </fieldset>
      <div className="editorbox"><CodeEditor value={d.body} language="markdown" path={`context-${item.id}.md`} readOnly={!can} onChange={(v) => setD({ ...d, body: v })} height="320px" onSave={() => can && save.mutate(undefined)} /></div>
      <div className="sect">Version history</div>
      <ul className="versions">{(versions ?? []).map((v) => <li key={v.id}><b>v{v.version}</b> {v.title} <small>{v.changedBy ?? ''} · {new Date(v.createdAt).toLocaleString()}</small>{can && v.version !== item.version && <Btn small onClick={() => restore.mutate(v.version)}>Restore</Btn>}</li>)}</ul>
    </div>
  );
}
export { downloadHref };
