import { useState, useRef, type DragEvent } from 'react';
import { Btn, Chip, Empty, fmtTokens, Spinner } from '@zerovity/ui-kit';
import { api, useApi, useAct, queryClient, type CtxPreview, type ItemDetail } from '../api';
import { toast, toastError, useApp } from '../state';
import { Markdown } from '../ui/Markdown';

const LAYER_ORDER = ['org', 'factory', 'repo', 'workItem', 'phase'];
const FORM_LABEL: Record<string, string> = { full: 'in CONTEXT.md', index: 'index only', dropped: 'not included' };

/** "What the agent sees" (spec 9.5): the assembled context, token cost per item, on/off per work item. */
export function ContextPanel({ itemId, detail }: { itemId: string; detail: ItemDetail }) {
  const { isRole } = useApp();
  const phases = detail.phases;
  const [agent, setAgent] = useState<string>(() => phases.find((p) => p.phase === (detail.workItem.phase ?? 'INTENT'))?.name ?? phases[0]?.name ?? '');
  const [raw, setRaw] = useState(false);
  const { data, isFetching } = useApi<CtxPreview>(['ctxPreview', itemId, agent], `/work-items/${itemId}/context/preview`, { agent }, { enabled: !!agent });
  const toggle = useAct((a: { itemId: string; enabled: boolean }) => api(`/work-items/${itemId}/context/toggles`, { method: 'PUT', body: a }), { invalidate: [['ctxPreview', itemId]], onError: toastError });
  const [adding, setAdding] = useState<null | 'note' | 'url'>(null);
  const [form, setForm] = useState({ title: '', body: '', url: '' });
  const add = useAct(async () => {
    if (adding === 'url') return api('/context/url', { body: { layer: 'workItem', scopeId: itemId, url: form.url, title: form.title || undefined } });
    return api('/context', { body: { layer: 'workItem', scopeId: itemId, title: form.title, body: form.body, kind: 'note' } });
  }, { invalidate: [['ctxPreview', itemId]], onSuccess: () => { setAdding(null); setForm({ title: '', body: '', url: '' }); toast('Context attached'); }, onError: toastError });
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append('file', f);
    try { await api('/context/file', { form: fd, query: { layer: 'workItem', scopeId: itemId } }); toast(`${f.name} attached as context`); void queryClient.invalidateQueries({ queryKey: ['ctxPreview', itemId] }); } catch (e) { toastError(e); }
  };
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void upload(f); else { const u = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'); if (/^https?:\/\//.test(u.trim())) void api('/context/url', { body: { layer: 'workItem', scopeId: itemId, url: u.trim() } }).then(() => { toast('Link attached as context'); void queryClient.invalidateQueries({ queryKey: ['ctxPreview', itemId] }); }).catch(toastError); } };

  const rows = [...(data?.report ?? [])].sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer));
  const included = rows.filter((r) => r.form !== 'dropped');
  const max = Math.max(1, ...rows.map((r) => r.tokens));

  return (
    <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="ctxhead">
        <label>Agent <select value={agent} onChange={(e) => setAgent(e.target.value)}>{phases.map((p) => <option key={p.name} value={p.name}>{p.name} · {p.phase}</option>)}</select></label>
        {data && <span className="mono ctxtok">{fmtTokens(data.tokens)} of {fmtTokens(data.budget)} tokens{data.trimmed ? ' · trimmed' : ''}</span>}
        {isFetching && <Spinner />}
      </div>
      <div className="ctx">
        {rows.map((r) => (
          <label key={r.id} className={r.form === 'dropped' ? 'off' : ''}>
            <input type="checkbox" checked={r.form !== 'dropped' || r.reason === 'on_request'} disabled={!isRole('member') || r.reason === 'not_in_scope' || r.reason === 'filtered'} onChange={(e) => toggle.mutate({ itemId: r.id, enabled: e.target.checked })} aria-label={`Include ${r.title}`} />
            <span className="lyr">{r.layer === 'workItem' ? 'item' : r.layer}</span>
            <span title={r.title}>{r.title}<small>{r.form !== 'dropped' ? FORM_LABEL[r.form] : r.reason?.replace('_', ' ')}</small></span>
            <span className="tb"><span><i style={{ width: `${(r.tokens / max) * 100}%` }} /></span>{fmtTokens(r.tokens)}</span>
          </label>
        ))}
        {!rows.length && <Empty>No context items apply to this agent yet. Attach a note, a file or a link below.</Empty>}
      </div>
      <div className={`drop${over ? ' over' : ''}`} onClick={() => fileRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}>
        Drop a file here, paste a link, or <u>browse</u>
        <input ref={fileRef} type="file" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      </div>
      <div className="opts">
        <Btn small onClick={() => setAdding(adding === 'note' ? null : 'note')} disabled={!isRole('member')}>Add a note</Btn>
        <Btn small onClick={() => setAdding(adding === 'url' ? null : 'url')} disabled={!isRole('member')}>Add a link</Btn>
        <Btn small onClick={() => setRaw(!raw)}>{raw ? 'Hide' : 'Show'} what the agent reads</Btn>
      </div>
      {adding && (
        <div className="inlineform">
          <input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="Title" />
          {adding === 'url' ? <input placeholder="https://…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} aria-label="URL" /> : <textarea rows={4} placeholder="What should the agents know?" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} aria-label="Note" />}
          <Btn pri small onClick={() => add.mutate(undefined)} disabled={add.isPending || (adding === 'url' ? !form.url : !form.title)}>Attach</Btn>
        </div>
      )}
      {raw && data && <div className="rawctx"><div className="sect">CONTEXT.md · bundle {data.bundleHash.slice(0, 12)} · {included.length} items</div><Markdown text={data.contextMd} /></div>}
      {data && Object.keys(data.items).length > 0 && raw && <div className="sect">On-request items ({Object.keys(data.items).length}): the agent opens them from .zerovity/context/items/ when needed</div>}
      <Chip c="var(--ink3)">drop files or links anywhere on this panel</Chip>
    </div>
  );
}
