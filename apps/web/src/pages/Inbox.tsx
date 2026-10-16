import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Btn, Chip, Empty, Seg, fmtAgo, Spinner, useTick } from '@zerovity/ui-kit';
import { api, useAct, useApi, type InboxItem, type Question, type Gate, type WorkItem } from '../api';
import { useApp, toast, toastError } from '../state';
import { InboxCard, kindInfo } from './InboxCard';
import { Markdown } from '../ui/Markdown';
import { SpecReview, type SpecComment } from './SpecReview';

const KINDS = ['all', 'question', 'context_request', 'spec_approval', 'gate', 'pr_review', 'blocked', 'failed', 'connection'];

/** Global inbox: filter by kind, factory, read state; the side pane resolves the selected item in place (spec 12.2). */
export function InboxPage() {
  const { factoryId, me, isRole } = useApp();
  const search = useSearch({ strict: false }) as { kind?: string; sel?: string };
  const nav = useNavigate();
  const [kind, setKind] = useState(search.kind ?? 'all');
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'factory' | 'all'>('factory');
  const [unread, setUnread] = useState(false);
  const now = useTick();
  const { data, isLoading } = useApi<InboxItem[]>(['inbox', 'page', kind, status, q, scope, unread, factoryId], '/inbox', { kind: kind === 'all' ? undefined : kind, status, q: q || undefined, factoryId: scope === 'factory' ? factoryId : undefined, unread: unread || undefined }, { placeholderData: (p) => p });
  const [sel, setSel] = useState<string | null>(search.sel ?? null);
  const list = useMemo(() => data ?? [], [data]);
  const cur = useMemo(() => list.find((i) => i.id === sel) ?? null, [list, sel]);
  useEffect(() => { if (!cur && list[0] && !sel) setSel(list[0].id); }, [list, cur, sel]);
  const read = useAct((a: { id: string; read: boolean }) => api(`/inbox/${a.id}/read`, { body: { read: a.read } }), { invalidate: [['inbox'], ['inboxCounts']] });
  const resolve = useAct((id: string) => api(`/inbox/${id}/resolve`, { method: 'POST' }), { invalidate: [['inbox'], ['inboxCounts']], onSuccess: (_r, id) => { toast('Resolved', 'info', () => reopen.mutate(id)); }, onError: toastError });
  const reopen = useAct((id: string) => api(`/inbox/${id}/reopen`, { method: 'POST' }), { invalidate: [['inbox'], ['inboxCounts']] });
  useEffect(() => { if (cur && !cur.read) read.mutate({ id: cur.id, read: true }); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      const i = list.findIndex((x) => x.id === sel);
      if (e.key === 'j') setSel(list[Math.min(list.length - 1, i + 1)]?.id ?? null);
      if (e.key === 'k') setSel(list[Math.max(0, i - 1)]?.id ?? null);
      if (e.key === 'e' && sel && isRole('member')) resolve.mutate(sel);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [list, sel, isRole, resolve]);

  return (
    <div className="inboxpage">
      <div className="ilistcol">
        <div className="filters">
          <Seg value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]} />
          <input type="search" placeholder="Search the inbox" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the inbox" />
          <div className="chips">{KINDS.map((k) => <button key={k} className={`chip link${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>{k === 'all' ? 'All kinds' : kindInfo(k).label}</button>)}</div>
          <label className="chk"><input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} />Unread only</label>
          {me.factories.length > 1 && <label className="chk"><input type="checkbox" checked={scope === 'all'} onChange={(e) => setScope(e.target.checked ? 'all' : 'factory')} />All factories</label>}
        </div>
        <ul className="rows" role="listbox" aria-label="Inbox items">
          {isLoading && <li className="pageload"><Spinner /></li>}
          {list.map((it) => { const k = kindInfo(it.kind); return (
            <li key={it.id} role="option" aria-selected={it.id === sel} className={`${it.id === sel ? 'sel' : ''}${it.read ? '' : ' unread'}`} style={{ ['--c' as string]: k.c }} onClick={() => { setSel(it.id); void nav({ to: '.', search: { kind: kind === 'all' ? undefined : kind, sel: it.id } as never, replace: true }); }}>
              <span className="kk">{k.label}</span><b>{it.title}</b><small>{fmtAgo(it.createdAt, now)} · {it.status === 'resolved' ? 'resolved' : it.body.slice(0, 80)}</small>
            </li>); })}
          {!isLoading && !list.length && <li className="emptyrow"><Empty>{status === 'open' ? 'Nothing is waiting on you. The line is moving.' : 'Nothing here.'}</Empty></li>}
        </ul>
        <div className="kbdhint">J / K move · E resolve</div>
      </div>
      <div className="idetail">{cur ? <Detail key={cur.id} item={cur} onResolve={() => resolve.mutate(cur.id)} /> : <Empty>Select an item to resolve it here.</Empty>}</div>
    </div>
  );
}

/** Side pane: the full context needed to decide, without leaving the inbox. */
function Detail({ item, onResolve }: { item: InboxItem; onResolve: () => void }) {
  const nav = useNavigate();
  const { isRole } = useApp();
  const { data } = useApi<{ workItem?: WorkItem; question: Question | null; gate: Gate | null; spec: string | null }>(['inboxDetail', item.id], `/inbox/${item.id}`);
  const { data: specData } = useApi<{ text: string | null; previous: string | null }>(['spec', item.workItemId], item.kind === 'spec_approval' && item.workItemId ? `/work-items/${item.workItemId}/spec` : null);
  const [comments, setComments] = useState<SpecComment[]>([]);
  const [reason, setReason] = useState('');
  const gateId = (item.payload as { gateId?: string }).gateId;
  const decide = useAct((a: { decision: 'approve' | 'changes' }) => api(`/gates/${gateId}/decision`, { body: { decision: a.decision, reason: reason || undefined, comments: comments.map((c) => ({ line: c.line, text: c.text })) } }), { invalidate: [['inbox'], ['inboxCounts'], ['floor'], ['spec', item.workItemId]], onSuccess: (_r, a) => toast(a.decision === 'approve' ? 'Approved · work continues' : 'Sent back with your comments'), onError: toastError });
  const k = kindInfo(item.kind);
  if (item.kind === 'spec_approval' && item.status === 'open') {
    return (
      <div className="dpane">
        <div className="k" style={{ color: k.c }}>{k.label}</div>
        <h2>{item.title}</h2>
        {data?.workItem && <p className="meta mono">{data.workItem.shortId} · {data.workItem.prUrl ?? ''}</p>}
        {specData?.text ? <SpecReview text={specData.text} previous={specData.previous} comments={comments} onComments={setComments} readOnly={!isRole('approver')} /> : <Spinner />}
        <div className="approvebar">
          <textarea rows={2} placeholder="Reason (optional unless required by policy)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          <div className="opts">
            <Btn pri disabled={!isRole('approver') || decide.isPending} onClick={() => decide.mutate({ decision: 'approve' })}>Approve spec</Btn>
            <Btn disabled={!isRole('approver') || decide.isPending || (!comments.length && !reason.trim())} onClick={() => decide.mutate({ decision: 'changes' })}>Request changes{comments.length ? ` (${comments.length})` : ''}</Btn>
            {item.workItemId && <Btn onClick={() => void nav({ to: '/items/$id', params: { id: item.workItemId! } })}>Open work item</Btn>}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="dpane">
      <InboxCard item={item} compact={false} />
      {item.status === 'open' && <Btn small onClick={onResolve} style={{ marginTop: 10 }}>Resolve without acting</Btn>}
      {item.status === 'resolved' && <Chip>{item.refKey ? 'resolved' : ''} {String((item as unknown as { resolution?: string }).resolution ?? '')}</Chip>}
      {data?.workItem && <div className="relitem"><b>{data.workItem.shortId}</b> {data.workItem.title}<Markdown text={data.workItem.body.slice(0, 600)} /></div>}
    </div>
  );
}
