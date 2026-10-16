import { useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Btn, Chip, Empty, PhaseChip, Seg, Spinner, fmtAgo, fmtMoney, fmtTokens, fmtDur, useTick, HARNESS_LABEL, harnessVar } from '@zerovity/ui-kit';
import { useApi, type Run, type WorkItem } from '../api';
import { useApp } from '../state';
import { ItemView } from './ItemView';

const GROUPS: Record<string, string[]> = { active: ['INTAKE', 'INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'], waiting: ['NEEDS_INPUT', 'AWAITING_SPEC_APPROVAL', 'AWAITING_GATE', 'AWAITING_HANDOFF', 'BLOCKED'], done: ['COMPLETE', 'CANCELLED', 'FAILED'] };

export function ItemsPage() {
  const { factoryId, composer, isRole } = useApp();
  const [g, setG] = useState<'all' | 'active' | 'waiting' | 'done'>('all');
  const [q, setQ] = useState('');
  const now = useTick();
  const nav = useNavigate();
  const { data, isLoading } = useApi<WorkItem[]>(['items', factoryId, g, q], '/work-items', { factoryId, state: g === 'all' ? undefined : GROUPS[g].join(','), q: q || undefined, limit: 200 }, { placeholderData: (p) => p });
  return (
    <div className="listpage">
      <div className="phead"><h1>Work items</h1><div className="grow" />
        <input type="search" placeholder="Search by title, ID or text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search work items" />
        <Seg value={g} onChange={setG} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Running' }, { value: 'waiting', label: 'Waiting' }, { value: 'done', label: 'Done' }]} />
        <Btn pri onClick={() => composer.set(true)} disabled={!isRole('member')}>New work item</Btn></div>
      {isLoading ? <div className="pageload"><Spinner /></div> : !data?.length ? <Empty>No work items match. Create one, or label an issue in GitHub or Jira.</Empty> : (
        <table className="grid">
          <thead><tr><th>ID</th><th>Title</th><th>State</th><th>Source</th><th>Cost</th><th>Tokens</th><th>Updated</th></tr></thead>
          <tbody>{data.map((w) => (
            <tr key={w.id} className="click" tabIndex={0} onClick={() => void nav({ to: '/items/$id', params: { id: w.id } })} onKeyDown={(e) => e.key === 'Enter' && void nav({ to: '/items/$id', params: { id: w.id } })}>
              <td className="mono">{w.shortId}</td><td>{w.title}</td><td><span className={`st ${w.state}`}>{w.state.replace(/_/g, ' ').toLowerCase()}</span>{w.loops > 0 && <small> · rev {w.loops}</small>}</td>
              <td>{w.sourceType}</td><td className="mono">{fmtMoney(w.costUsd)}</td><td className="mono">{fmtTokens(w.tokensIn + w.tokensOut)}</td><td>{fmtAgo(w.stateSince, now)}</td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  );
}

export function ItemPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const s = useSearch({ strict: false }) as { tab?: string };
  return <div className="itempage"><ItemView key={id} id={id} variant="page" initialTab={s.tab as never} /></div>;
}

/* ----------------------------------------------------------------------------------------------------- runs */
export function RunsPage() {
  const { factoryId } = useApp();
  const [st, setSt] = useState<'all' | 'running' | 'failed'>('all');
  const now = useTick();
  const { data, isLoading } = useApi<Run[]>(['runs', factoryId, st], '/runs', { factoryId, status: st === 'running' ? 'queued,running' : st === 'failed' ? 'failed,timeout,blocked' : undefined, limit: 200 }, { refetchInterval: 10_000, placeholderData: (p) => p });
  return (
    <div className="listpage">
      <div className="phead"><h1>Runs</h1><div className="grow" /><Seg value={st} onChange={setSt} options={[{ value: 'all', label: 'All' }, { value: 'running', label: 'Running' }, { value: 'failed', label: 'Failed' }]} /></div>
      {isLoading ? <div className="pageload"><Spinner /></div> : !data?.length ? <Empty>No runs yet.</Empty> : (
        <table className="grid">
          <thead><tr><th>Item</th><th>Agent</th><th>Phase</th><th>Harness · model</th><th>Status</th><th>Duration</th><th>Tokens</th><th>Cost</th><th>Started</th></tr></thead>
          <tbody>{data.map((r) => (
            <tr key={r.id}>
              <td className="mono"><Link to="/items/$id" params={{ id: r.workItemId }}>{r.shortId}</Link></td>
              <td><Link to="/runs/$id" params={{ id: r.id }}>{r.agentName}</Link>{r.kind !== 'phase' && <small> {r.kind}</small>}</td>
              <td><PhaseChip phase={r.phase} /></td>
              <td><span className="hxdot" style={{ background: harnessVar(r.harness) }} />{HARNESS_LABEL[r.harness] ?? r.harness}<small> {r.model}</small></td>
              <td><span className={`st ${r.status}`}>{r.status.replace('_', ' ')}</span>{r.exitReason && <small> {r.exitReason}</small>}</td>
              <td className="mono">{r.startedAt ? fmtDur(((r.endedAt ? new Date(r.endedAt).getTime() : now) - new Date(r.startedAt).getTime()) / 60000) : ''}</td>
              <td className="mono">{fmtTokens(r.tokensIn + r.tokensOut)}</td><td className="mono">{fmtMoney(r.costUsd, 3)}</td><td>{fmtAgo(r.startedAt ?? r.createdAt, now)}</td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  );
}
export { Chip };
