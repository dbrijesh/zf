import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Btn, Icon, Seg } from '@zerovity/ui-kit';
import { api, useAct, useApi, queryClient } from '../api';
import { useApp, toast, toastError } from '../state';

interface Repo { id: string; owner: string; name: string; defaultBranch: string }
type Att = { title: string; body: string; kind: 'note' | 'url'; url?: string; file?: File };

/** "New work item" (spec 11.2): title, description, repo, attached context, starting phase, notification route. */
export function Composer() {
  const { composer, factoryId } = useApp();
  const nav = useNavigate();
  const [f, setF] = useState({ title: '', body: '', repoId: '', start: 'auto' as 'auto' | 'INTENT' | 'SPEC' | 'BUILD', notify: 'web' as 'web' | 'email', budget: '' });
  const [atts, setAtts] = useState<Att[]>([]);
  const [link, setLink] = useState('');
  const [over, setOver] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const { data: fac } = useApi<{ repositories: Repo[] }>(['factory', factoryId], factoryId ? `/factories/${factoryId}` : null, undefined, { enabled: composer.open });
  useEffect(() => { if (composer.open) setTimeout(() => first.current?.focus(), 30); }, [composer.open]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && composer.open) composer.set(false); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [composer]);

  const reset = () => { setF({ title: '', body: '', repoId: '', start: 'auto', notify: 'web', budget: '' }); setAtts([]); setLink(''); };
  const create = useAct(async () => {
    const wi = await api<{ id: string; shortId: string }>('/work-items', { body: { factoryId, title: f.title.trim(), body: f.body, repoId: f.repoId || undefined, startPhase: f.start, budgetUsd: f.budget ? Number(f.budget) : undefined, context: atts.filter((a) => !a.file).map((a) => ({ title: a.title, body: a.body, kind: a.kind, url: a.url })) } });
    for (const a of atts.filter((x) => x.file)) { const fd = new FormData(); fd.append('file', a.file!); await api('/context/file', { form: fd, query: { layer: 'workItem', scopeId: wi.id } }).catch(toastError); }
    return wi;
  }, { onSuccess: (wi) => { toast(`${wi.shortId} created · the foreman is starting it`); composer.set(false); reset(); void queryClient.invalidateQueries(); void nav({ to: '/', search: { item: wi.id } as never }); }, onError: toastError });

  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); const files = [...e.dataTransfer.files]; if (files.length) setAtts((a) => [...a, ...files.map((file) => ({ title: file.name, body: '', kind: 'note' as const, file }))]); else { const u = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).trim(); if (/^https?:\/\//.test(u)) setAtts((a) => [...a, { title: u, body: '', kind: 'url', url: u }]); } };
  if (!composer.open) return null;
  const valid = f.title.trim().length >= 3;
  return (
    <>
      <div className="scrim on" onClick={() => composer.set(false)} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="New work item" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
        <div className="mhead"><h2>New work item</h2><button className="x" onClick={() => composer.set(false)} aria-label="Close"><Icon.Close /></button></div>
        <form className="mbody" onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(undefined); }}>
          <label className="fld">Title<input ref={first} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Two-step approval for refunds over $10k" maxLength={300} /></label>
          <label className="fld">Description<textarea rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="What do you need, and why? Link tickets, paste errors, name the system." /></label>
          <div className="row2">
            <label className="fld">Repository<select value={f.repoId} onChange={(e) => setF({ ...f, repoId: e.target.value })}><option value="">Factory default</option>{fac?.repositories.map((r) => <option key={r.id} value={r.id}>{r.owner}/{r.name}</option>)}</select></label>
            <label className="fld">Budget (USD)<input inputMode="decimal" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="factory default" /></label>
          </div>
          <div className="fld"><span>Starting phase</span><Seg value={f.start} onChange={(v) => setF({ ...f, start: v })} options={[{ value: 'auto', label: 'Auto (foreman decides)' }, { value: 'INTENT', label: 'Intent' }, { value: 'SPEC', label: 'Spec' }, { value: 'BUILD', label: 'Build' }]} /></div>
          <div className="fld"><span>Notify me by</span><Seg value={f.notify} onChange={(v) => setF({ ...f, notify: v })} options={[{ value: 'web', label: 'Inbox in the app' }, { value: 'email', label: 'Source thread (GitHub / Jira) when linked' }]} /></div>
          <div className={`drop${over ? ' over' : ''}`}>Attach context: drop files or links here{' '}
            <input className="linkin" value={link} placeholder="or paste a link and press Enter" onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (/^https?:\/\//.test(link.trim())) { setAtts([...atts, { title: link.trim(), body: '', kind: 'url', url: link.trim() }]); setLink(''); } } }} aria-label="Link to attach" />
          </div>
          {atts.length > 0 && <ul className="atts">{atts.map((a, i) => <li key={i}><Icon.File />{a.title}<button type="button" aria-label={`Remove ${a.title}`} onClick={() => setAtts(atts.filter((_, j) => j !== i))}>×</button></li>)}</ul>}
          <div className="mfoot"><span className="hint">Agents never merge. A person always receives the pull request.</span><Btn type="submit" pri disabled={!valid || create.isPending}>{create.isPending ? 'Creating…' : 'Create work item'}</Btn></div>
        </form>
      </div>
    </>
  );
}
