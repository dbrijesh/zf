import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { phaseVar, useTheme } from '@zerovity/ui-kit';
import { api, useApi, queryClient, type AgentView } from '../api';
import { useApp, toast, toastError } from '../state';

interface Cmd { l: string; s: string; c?: string; f: () => void }

/** Command palette (Ctrl/Cmd+K): jump to an item, agent or skill, or run an action (spec 12.1). */
export function Palette() {
  const { palette, floor, factoryId, me, setFactoryId, composer, isRole } = useApp();
  const nav = useNavigate();
  const [, toggleTheme] = useTheme();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { data: agents } = useApi<AgentView[]>(['agents', factoryId], factoryId ? `/factories/${factoryId}/agents` : null, undefined, { enabled: palette.open });
  const { data: skills } = useApi<{ skills: Array<{ name: string; scope: string }> }>(['skills', factoryId], factoryId ? `/factories/${factoryId}/skills` : null, undefined, { enabled: palette.open });
  const close = () => palette.set(false);

  const cmds = useMemo<Cmd[]>(() => {
    const go = (to: string, search?: Record<string, unknown>) => () => { close(); void nav({ to, search: search as never }); };
    const items: Cmd[] = (floor?.items ?? []).map((x) => ({ l: `${x.shortId}  ${x.title}`, s: x.lane, c: phaseVar(x.lane), f: () => { close(); void nav({ to: '/', search: { item: x.id } as never }); } }));
    return [
      ...items,
      { l: 'New work item', s: 'N', f: () => { close(); composer.set(true); } },
      { l: 'Approve next waiting spec', s: 'A', f: async () => { close(); const inbox = await api<Array<{ id: string; kind: string; workItemId: string; payload: { gateId?: string } }>>('/inbox', { query: { kind: 'spec_approval' } }); const x = inbox[0]; if (!x) return toast('No specs waiting'); if (!isRole('approver')) return toast('Approving requires the approver role', 'error'); try { await api(`/gates/${x.payload.gateId}/decision`, { body: { decision: 'approve' } }); toast('Spec approved · build starts now'); void queryClient.invalidateQueries(); } catch (e) { toastError(e); } } },
      { l: 'Answer the next question', s: 'Q', f: go('/inbox', { kind: 'question' }) },
      { l: 'Attach context to an item', s: 'C', f: go('/context') },
      ...(agents ?? []).map((a) => ({ l: `Open agent: ${a.name}`, s: 'Agent', c: phaseVar(a.phase), f: go('/agents', { name: a.name }) })),
      ...(skills?.skills ?? []).filter((s) => s.scope !== 'pack' || true).slice(0, 80).map((s) => ({ l: `Open skill: ${s.name}`, s: s.scope.startsWith('pack') ? 'pack' : 'Skill', f: go('/skills', { name: s.name, scope: s.scope === 'pack' ? undefined : s.scope }) })),
      { l: 'Go to Floor', s: 'G F', f: go('/') }, { l: 'Go to Inbox', s: 'G I', f: go('/inbox') }, { l: 'Go to Work items', s: 'G W', f: go('/items') }, { l: 'Go to Runs', s: 'G R', f: go('/runs') },
      { l: 'Go to Dashboard', s: 'G D', f: go('/dashboard') }, { l: 'Go to Connections', s: 'G K', f: go('/connections') }, { l: 'Go to Definition', s: '', f: go('/definition') }, { l: 'Go to Settings', s: '', f: go('/settings') },
      { l: 'Check connections health', s: 'Connections', f: async () => { close(); try { const r = await api<{ checked: number; failing: number }>('/connections/check-all', { method: 'POST' }); toast(r.failing ? `${r.failing} of ${r.checked} connections need attention` : `All ${r.checked} connections healthy`, r.failing ? 'error' : 'info'); void queryClient.invalidateQueries(); } catch (e) { toastError(e); } } },
      ...me.factories.filter((f) => f.id !== factoryId).map((f) => ({ l: `Switch factory: ${f.name}`, s: 'Factory', f: () => { close(); setFactoryId(f.id); } })),
      { l: 'Switch light / slate theme', s: 'T', f: () => { close(); toggleTheme(); } },
      { l: floor?.factory.paused ? 'Resume the line' : 'Pause the line', s: 'P', f: async () => { close(); if (!isRole('factory_owner')) return toast('Pausing needs the factory owner role', 'error'); try { await api(`/factories/${factoryId}`, { method: 'PATCH', body: { paused: !floor?.factory.paused } }); toast(floor?.factory.paused ? 'Line resumed' : 'Line paused · no new runs will start'); void queryClient.invalidateQueries(); } catch (e) { toastError(e); } } },
    ];
  }, [floor, agents, skills, me, factoryId, isRole]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => { const n = q.toLowerCase().split(/\s+/).filter(Boolean); return cmds.filter((c) => n.every((t) => c.l.toLowerCase().includes(t))).slice(0, 12); }, [cmds, q]);
  useEffect(() => { if (palette.open) { setQ(''); setSel(0); setTimeout(() => input.current?.focus(), 20); } }, [palette.open]);
  useEffect(() => setSel(0), [q]);

  return (
    <>
      <div className={`scrim${palette.open ? ' on' : ''}`} style={{ zIndex: 59 }} onClick={close} />
      <div className={`pal${palette.open ? ' on' : ''}`} role="dialog" aria-label="Command palette" aria-modal="true">
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a command or search…" autoComplete="off" aria-label="Search commands"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(view.length - 1, sel + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, sel - 1)); }
            else if (e.key === 'Enter' && view[sel]) view[sel].f();
            else if (e.key === 'Escape') close();
          }} />
        <ul role="listbox">
          {view.map((c, i) => <li key={c.l + i} role="option" aria-selected={i === sel} className={i === sel ? 'sel' : ''} style={{ ['--c' as string]: c.c ?? '' }} onMouseEnter={() => setSel(i)} onClick={() => c.f()}><i />{c.l}<small>{c.s}</small></li>)}
          {!view.length && <li className="none">Nothing matches “{q}”</li>}
        </ul>
      </div>
    </>
  );
}
