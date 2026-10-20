import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

/** Class name joiner */
export const cx = (...a: Array<string | false | null | undefined>): string => a.filter(Boolean).join(' ');

export const PHASES = ['INTENT', 'SPEC', 'BUILD', 'VERIFY', 'SHIP'] as const;
export type PhaseName = (typeof PHASES)[number] | 'GATE';
/** CSS variable carrying the accent of each phase (same one everywhere: floor, timelines, chips, charts). */
export const phaseVar = (p: string): string => `var(--${p === 'GATE' ? 'gate' : p.toLowerCase()})`;
export const phaseColor = (p: string): CSSProperties => ({ ['--c' as string]: phaseVar(p) });

export const HARNESS_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', copilot: 'Copilot', cursor: 'Cursor', fake: 'Offline demo' };
export const harnessVar = (h: string): string => (h === 'claude-code' ? 'var(--hx1)' : h === 'codex' ? 'var(--hx2)' : h === 'copilot' ? 'var(--hx3)' : h === 'cursor' ? 'var(--hx4)' : 'var(--ink3)');

export const fmtMoney = (n: number | null | undefined, digits = 2): string => `$${(n ?? 0).toFixed(digits)}`;
export const fmtTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n));
export function fmtAgo(d: string | Date | null | undefined, now = Date.now()): string {
  if (!d) return '';
  const s = Math.max(0, Math.round((now - new Date(d).getTime()) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
export function fmtDur(min: number | null | undefined): string {
  const m = Math.max(0, min ?? 0);
  if (m < 1) return '<1m';
  if (m < 90) return `${Math.round(m)}m`;
  if (m < 60 * 36) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}

export function useReducedMotion(): boolean {
  const [r, setR] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = matchMedia('(prefers-reduced-motion: reduce)');
    const f = () => setR(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return r;
}

/** A re-render every `ms` so relative times stay fresh. */
export function useTick(ms = 30_000): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return n;
}

export const Btn = ({ pri, danger, small, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pri?: boolean; danger?: boolean; small?: boolean }) => (
  <button {...p} type={p.type ?? 'button'} className={cx('btn', pri && 'pri', danger && 'danger', small && 'small', p.className)} />
);

export const Chip = ({ children, c, title }: { children: ReactNode; c?: string; title?: string }) => (
  <span className="chip" title={title} style={c ? ({ ['--c' as string]: c } as CSSProperties) : undefined}>{children}</span>
);

export const PhaseChip = ({ phase }: { phase: string }) => (
  <span className="chip phase" style={phaseColor(phase)}><i />{phase}</span>
);

export function Ring({ value, color = 'var(--spec)', size = 26 }: { value: number; color?: string; size?: number }) {
  const C = 2 * Math.PI * 10;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg className="ring" viewBox="0 0 26 26" width={size} height={size} aria-label={`${Math.round(v * 100)}% of budget used`}>
      <circle cx="13" cy="13" r="10" fill="none" style={{ stroke: 'color-mix(in srgb,var(--ink) 14%,transparent)' }} strokeWidth="2.5" />
      <circle cx="13" cy="13" r="10" fill="none" strokeWidth="2.5" transform="rotate(-90 13 13)" strokeDasharray={`${C * v} ${C}`} style={{ stroke: v > 0.8 ? 'var(--danger)' : color, transition: 'stroke-dasharray .8s ease,stroke .4s' }} />
    </svg>
  );
}

export function Meter({ value, max = 1, mark }: { value: number; max?: number; mark?: number }) {
  return (
    <div className="bmeter" role="meter" aria-valuenow={value} aria-valuemax={max}>
      <i style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      {mark !== undefined && <s style={{ left: `${mark * 100}%` }} />}
    </div>
  );
}

export const Empty = ({ children, icon }: { children: ReactNode; icon?: ReactNode }) => <div className="emptyblock">{icon}<div>{children}</div></div>;
export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;

export function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }> }) {
  return <div className="seg" role="tablist">{options.map((o) => <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

export const KV = ({ items }: { items: Array<[string, ReactNode]> }) => (
  <div className="kv">{items.map(([k, v]) => <div key={k}><small>{k}</small><b>{v}</b></div>)}</div>
);

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ id: T; label: string; badge?: number | string }> }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} className={t.id === value ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.label}{t.badge !== undefined && t.badge !== 0 && <em>{t.badge}</em>}
        </button>
      ))}
    </div>
  );
}

/* ---------- icons: 20px line icons in the same stroke weight as the design ---------- */
const I = ({ d, children }: { d?: string; children?: ReactNode }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d ? <path d={d} /> : children}</svg>;
export const Icon = {
  Floor: () => <I d="M3 18h18M5 18V9l4 3V9l4 3V9l4 3v6" />,
  Inbox: () => <I d="M4 13l2-8h12l2 8v6H4zM4 13h5l1 2h4l1-2h5" />,
  Items: () => <I d="M5 6h14M5 12h14M5 18h9" />,
  Runs: () => <I d="M3 12h4l2-6 4 12 2-6h6" />,
  Agents: () => <I><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><circle cx="12" cy="12" r="2.5" /></I>,
  Skills: () => <I d="M4 5h7v7H4zM13 12h7v7h-7zM13 5l3.5-2L20 5v4l-3.5 2L13 9z" />,
  Context: () => <I d="M4 6l8-3 8 3-8 3zM4 12l8 3 8-3M4 18l8 3 8-3" />,
  Connections: () => <I><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 6h7M6 8.5v4a5.5 5.5 0 005.5 5.5h4" /></I>,
  Dashboard: () => <I d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  Settings: () => <I><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></I>,
  Definition: () => <I d="M8 4L3 12l5 8M16 4l5 8-5 8M14 4l-4 16" />,
  Scorers: () => <I d="M12 3l2.7 5.5 6 .9-4.4 4.2 1 6L12 16.8 6.7 19.6l1-6L3.3 9.4l6-.9z" />,
  Search: () => <I><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></I>,
  Moon: () => <I d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" />,
  Sun: () => <I><circle cx="12" cy="12" r="4" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" /></I>,
  Plus: () => <I d="M12 5v14M5 12h14" />,
  Close: () => <I d="M6 6l12 12M18 6L6 18" />,
  Pause: () => <I d="M8 5v14M16 5v14" />,
  Play: () => <I d="M7 5l12 7-12 7z" />,
  Check: () => <I d="M5 12l5 5 9-10" />,
  Link: () => <I d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />,
  File: () => <I d="M6 3h8l4 4v14H6zM14 3v4h4" />,
  Alert: () => <I d="M12 4l9 16H3zM12 10v4M12 17v.5" />,
  Chevron: () => <I d="M9 6l6 6-6 6" />,
  Logo: () => (
    <svg viewBox="0 0 34 34" aria-label="Zerovity">
      <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style={{ stopColor: 'var(--intent)' }} /><stop offset="1" style={{ stopColor: 'var(--spec)' }} /></linearGradient></defs>
      <path d="M6 7h22L9 27h19" fill="none" stroke="url(#lg)" strokeWidth="3.2" strokeLinecap="square" /><circle cx="28" cy="7" r="2.4" style={{ fill: 'var(--ship)' }} />
    </svg>
  ),
};

/** Theme: stored in localStorage, falls back to the OS preference; returns [theme, toggle]. */
export function useTheme(): ['dark' | 'light', () => void] {
  const read = (): 'dark' | 'light' => {
    const d = document.documentElement.dataset.theme as 'dark' | 'light' | undefined;
    return d ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  };
  const [t, setT] = useState<'dark' | 'light'>(read);
  const toggle = () => {
    const next = t === 'light' ? 'dark' : 'light';
    const root = document.documentElement;
    root.classList.add('theming');
    root.dataset.theme = next;
    try { localStorage.setItem('zf-theme', next); } catch { /* private mode */ }
    setTimeout(() => root.classList.remove('theming'), 400);
    setT(next);
  };
  return [t, toggle];
}
