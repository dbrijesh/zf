import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api, useApi, useLiveInvalidation, ApiError, type Me, type Floor } from './api';

/* ---------------- toast ---------------- */
type ToastMsg = { id: number; text: string; kind: 'info' | 'error'; undo?: () => void };
const listeners = new Set<(m: ToastMsg) => void>();
let toastSeq = 0;
export const toast = (text: string, kind: 'info' | 'error' = 'info', undo?: () => void) => { const m = { id: ++toastSeq, text, kind, undo }; listeners.forEach((l) => l(m)); };
export const toastError = (e: unknown) => toast(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e), 'error');

export function Toaster() {
  const [m, setM] = useState<ToastMsg | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const l = (x: ToastMsg) => { setM(x); clearTimeout(t); t = setTimeout(() => setM(null), x.kind === 'error' ? 5200 : x.undo ? 6000 : 2600); };
    listeners.add(l);
    return () => { listeners.delete(l); clearTimeout(t); };
  }, []);
  return <div className={`toast${m ? ' on' : ''}${m?.kind === 'error' ? ' err' : ''}`} role="status" aria-live="polite">{m?.text}{m?.undo && <button className="undo" onClick={() => { m.undo?.(); setM(null); }}>Undo</button>}</div>;
}

/* ---------------- app state ---------------- */
interface AppState {
  me: Me;
  factoryId: string;
  setFactoryId: (id: string) => void;
  factory: Me['factories'][number] | undefined;
  floor: Floor | undefined;
  isRole: (min: 'viewer' | 'member' | 'approver' | 'factory_owner' | 'org_admin') => boolean;
  composer: { open: boolean; set: (v: boolean) => void };
  palette: { open: boolean; set: (v: boolean) => void };
}
const Ctx = createContext<AppState | null>(null);
export const useApp = () => { const c = useContext(Ctx); if (!c) throw new Error('outside AppProvider'); return c; };

const RANK = ['viewer', 'member', 'approver', 'factory_owner', 'org_admin'];

export function AppProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [factoryId, setFid] = useState<string>(() => { try { return localStorage.getItem('zf-factory') ?? ''; } catch { return ''; } });
  const valid = me.factories.find((f) => f.id === factoryId) ?? me.factories[0];
  const id = valid?.id ?? '';
  const setFactoryId = useCallback((v: string) => { setFid(v); try { localStorage.setItem('zf-factory', v); } catch { /* ignore */ } }, []);
  const [composer, setComposer] = useState(false);
  const [palette, setPalette] = useState(false);
  useLiveInvalidation(id || undefined);
  const { data: floor } = useApi<Floor>(['floor', id], id ? `/factories/${id}/floor` : null, undefined, { refetchInterval: 20_000 });
  const v = useMemo<AppState>(() => ({
    me, factoryId: id, setFactoryId, factory: valid, floor,
    isRole: (min) => RANK.indexOf(valid?.role ?? me.role) >= RANK.indexOf(min),
    composer: { open: composer, set: setComposer }, palette: { open: palette, set: setPalette },
  }), [me, id, setFactoryId, valid, floor, composer, palette]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

/** Redirect to /login on 401. */
export function useAuthRedirect() {
  const nav = useNavigate();
  useEffect(() => {
    const f = () => void nav({ to: '/login' });
    window.addEventListener('zf-unauthorized', f);
    return () => window.removeEventListener('zf-unauthorized', f);
  }, [nav]);
}

export async function logout() { await api('/auth/logout', { method: 'POST' }); location.href = '/login'; }
