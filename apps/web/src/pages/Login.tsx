import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Btn, Icon } from '@zerovity/ui-kit';
import { api, queryClient, useApi } from '../api';
import { toastError } from '../state';

const DEMO = [['admin@acme.test', 'Org admin'], ['priya@acme.test', 'Approver (tech-leads)'], ['dev@acme.test', 'Member'], ['viewer@acme.test', 'Viewer']];

export function LoginPage() {
  const nav = useNavigate();
  const { data: cfg } = useApi<{ devLogin: boolean; oidc: boolean; version: string }>(['static', 'authcfg'], '/auth/config');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e: string) => { setBusy(true); try { await api('/auth/dev-login', { body: { email: e } }); await queryClient.invalidateQueries(); void nav({ to: '/' }); } catch (err) { toastError(err); } finally { setBusy(false); } };
  return (
    <div className="login">
      <div className="lcard cut">
        <div className="logo big"><Icon.Logo /></div>
        <h1>Zerovity Factory</h1>
        <p>A team of agents on your repositories. People approve at the gates; agents never merge.</p>
        {cfg?.oidc && <a className="btn pri block" href="/api/v1/auth/oidc/login">Sign in with your organisation</a>}
        {cfg?.devLogin && (
          <form onSubmit={(e) => { e.preventDefault(); if (email) void go(email); }}>
            <label className="fld">Email (development sign-in)<input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
            <Btn pri type="submit" disabled={!email || busy}>Continue</Btn>
            <div className="demo"><small>Demo users</small>{DEMO.map(([e, r]) => <button type="button" key={e} className="chip link" onClick={() => void go(e)}>{r}</button>)}</div>
            <p className="hint">The first person to sign in on a new install becomes the organisation admin. Turn this off in production with ZF_DEV_LOGIN=0 and use OIDC.</p>
          </form>
        )}
        {cfg && !cfg.devLogin && !cfg.oidc && <p className="hint">No sign-in method is configured. Set OIDC_ISSUER or ZF_DEV_LOGIN=1.</p>}
        <small className="ver">v{cfg?.version}</small>
      </div>
    </div>
  );
}
