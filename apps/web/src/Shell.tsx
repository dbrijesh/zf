import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Icon, Spinner, useTheme, fmtMoney } from '@zerovity/ui-kit';
import { useApi, api, type Floor, type InboxItem } from './api';
import { useApp, useAuthRedirect, Toaster, logout, toast, toastError } from './state';
import { Drawer } from './pages/Drawer';
import { Palette } from './pages/Palette';
import { Composer } from './pages/Composer';

const NAV = [
  { to: '/', label: 'Floor', icon: Icon.Floor },
  { to: '/inbox', label: 'Inbox', icon: Icon.Inbox, badge: true },
  { to: '/items', label: 'Work items', icon: Icon.Items },
  { to: '/runs', label: 'Runs', icon: Icon.Runs },
  { to: '/agents', label: 'Agents', icon: Icon.Agents },
  { to: '/skills', label: 'Skills library', icon: Icon.Skills },
  { to: '/context', label: 'Context library', icon: Icon.Context },
  { to: '/definition', label: 'Definition', icon: Icon.Definition },
  { to: '/connections', label: 'Connections', icon: Icon.Connections },
  { to: '/dashboard', label: 'Dashboard', icon: Icon.Dashboard },
  { to: '/scorers', label: 'Scorers', icon: Icon.Scorers },
] as const;

export function Shell() {
  useAuthRedirect();
  const { me, factoryId, setFactoryId, factory, floor, composer, palette, isRole } = useApp();
  const [theme, toggleTheme] = useTheme();
  const nav = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { data: counts } = useApi<{ open: number; unread: number }>(['inboxCounts'], '/inbox/counts', undefined, { refetchInterval: 30_000 });
  const { data: fac } = useApi<{ repositories: Array<{ owner: string; name: string }> }>(['factory', factoryId], factoryId ? `/factories/${factoryId}` : null);
  const [menu, setMenu] = useState(false);

  // global shortcuts: Ctrl/Cmd+K palette, N new item, G then letter navigation
  useEffect(() => {
    let g = false, gt: ReturnType<typeof setTimeout>;
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest('.monaco-editor');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.set(!palette.open); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n') { e.preventDefault(); composer.set(true); }
      else if (e.key === 'g') { g = true; clearTimeout(gt); gt = setTimeout(() => (g = false), 900); }
      else if (g) {
        g = false;
        const to = ({ f: '/', i: '/inbox', w: '/items', r: '/runs', a: '/agents', s: '/skills', c: '/context', d: '/dashboard', k: '/connections' } as Record<string, string>)[e.key];
        if (to) void nav({ to });
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [nav, palette, composer]);

  const c = floor?.counters;
  const done = c?.completedToday ?? 0;
  const repos = fac?.repositories.map((r) => `${r.owner}/${r.name}`).join(' · ') ?? '';
  const initials = (factory?.name ?? 'ZF').split(/[-_ ]/).map((s) => s[0]?.toUpperCase()).join('').slice(0, 2);

  return (
    <div className="app">
      <nav className="rail" aria-label="Main">
        <div className="logo"><Icon.Logo /></div>
        {NAV.map((n) => {
          const on = n.to === '/' ? path === '/' : path.startsWith(n.to);
          return (
            <Link key={n.to} to={n.to} className={`nav${on ? ' on' : ''}`} aria-label={n.label} aria-current={on ? 'page' : undefined}>
              <n.icon />
              {'badge' in n && (counts?.open ?? 0) > 0 && <span className="dot">{counts!.open}</span>}
              <span className="tip">{n.label}</span>
            </Link>
          );
        })}
        <div className="spacer" />
        <Link to="/settings" className={`nav${path.startsWith('/settings') ? ' on' : ''}`} aria-label="Settings"><Icon.Settings /><span className="tip">Settings</span></Link>
      </nav>

      <header className="top">
        <div className="fswitch">
          <div className="glyph cut" style={{ ['--cut' as string]: '6px' }}>{initials}</div>
          <div>
            {me.factories.length > 1
              ? <select aria-label="Switch factory" className="fsel" value={factoryId} onChange={(e) => setFactoryId(e.target.value)}>{me.factories.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
              : <b>{factory?.name ?? 'No factory'}</b>}
            <span>{repos || 'no repositories mapped yet'}</span>
          </div>
        </div>
        <button className="search" onClick={() => palette.set(true)} aria-label="Open command palette"><Icon.Search />Jump to an item, agent, skill or action<kbd>Ctrl K</kbd></button>
        <div className="counters">
          <div className="ctr"><small>Active runs</small><b>{c?.activeRuns ?? 0}</b></div>
          <div className="ctr"><small>Waiting on you</small><b style={{ color: 'var(--gate)' }}>{c?.waiting ?? 0}</b></div>
          <div className="ctr"><small>Handed off today</small><b>{done}{(c?.completedDelta ?? 0) > 0 && <em>+{c!.completedDelta}</em>}</b></div>
          <div className="ctr"><small>Spend today</small><b>{fmtMoney(c?.spendToday ?? 0)}</b></div>
        </div>
        <div className="health">
          {floor?.health.filter((h) => h.state !== 'none').map((h) => <Link key={h.label} to="/connections" className={`hpill${h.state === 'warn' ? ' warn' : ''}`} title={h.detail}><i />{h.label}</Link>)}
          {floor && floor.health.every((h) => h.state === 'none') && <Link to="/connections" className="hpill warn" title="Connect GitHub, Jira and harness credentials"><i />Connect tools</Link>}
        </div>
        <button className="btn pri newbtn" onClick={() => composer.set(true)} disabled={!isRole('member')} title="New work item (N)"><Icon.Plus />New</button>
        <button className="themebtn" onClick={toggleTheme} aria-label="Switch theme" title={theme === 'light' ? 'Slate theme' : 'Light theme'}>{theme === 'light' ? <Icon.Sun /> : <Icon.Moon />}</button>
        <div className="usermenu">
          <button className="avatar" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} aria-label="Account">{me.name.split(' ').map((s) => s[0]).join('').slice(0, 2)}</button>
          {menu && (
            <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
              <div className="who"><b>{me.name}</b><span>{me.email}</span><span className="chip">{me.role.replace('_', ' ')}</span></div>
              <Link to="/settings" search={{ tab: 'tokens' }} role="menuitem" onClick={() => setMenu(false)}>Access tokens</Link>
              <button role="menuitem" onClick={() => void logout()}>Sign out</button>
            </div>
          )}
        </div>
      </header>

      <main className="page" id="main">
        <Suspense fallback={<div className="pageload"><Spinner /></div>}><Outlet /></Suspense>
      </main>

      <Drawer />
      <Palette />
      <Composer />
      <Toaster />
    </div>
  );
}

export type { Floor, InboxItem };
export { api, toast, toastError, useRef };
