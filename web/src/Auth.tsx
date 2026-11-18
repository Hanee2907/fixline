import { useState, type FormEvent } from 'react';
import type { User } from '../../shared/types';
import { ApiError, api } from './api';
import { Mark } from './ui';

export function AuthPage({ onUser }: { onUser: (u: User) => void }) {
  const [mode, setMode] = useState<'in' | 'new' | 'join'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [org, setOrg] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('form');
    setError('');
    try {
      const r = mode === 'in'
        ? await api.login({ email, password })
        : await api.signup({ name, email, password, workspaceName: mode === 'new' ? org : undefined, joinCode: mode === 'join' ? code : undefined });
      onUser(r.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach Fixline.');
      setBusy('');
    }
  };
  const demo = async (as: 'agent' | 'requester') => {
    setBusy(as);
    setError('');
    try { onUser((await api.demo(as)).user); } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not start the demo.'); setBusy(''); }
  };

  return (
    <div className="auth">
      <section className="auth-l">
        <div className="brand" style={{ padding: 0 }}><Mark />Fixline</div>
        <h1>IT help that feels <em>instant</em>.</h1>
        <p>A help desk for small IT teams: a live queue with time limits that pause on their own, fixes suggested as people type, and one-click outage banners.</p>
        <div className="feat">
          <div><b>Live, no refresh</b>Tickets arrive and change on every screen in real time.</div>
          <div><b>Fixes before tickets</b>Employees see matching guides while they type.</div>
          <div><b>Fair time limits</b>The clock pauses while waiting on a person or a part.</div>
          <div><b>Built for keyboards</b>J/K, R, E and Ctrl+K for everything.</div>
        </div>
      </section>
      <section className="auth-r">
        <form onSubmit={submit} noValidate>
          <h2>{mode === 'in' ? 'Sign in' : mode === 'new' ? 'Start a help desk' : 'Join your company'}</h2>
          <div className="demo-btns">
            <button type="button" onClick={() => demo('agent')} disabled={!!busy}><b>{busy === 'agent' ? 'Setting it up…' : '→ Try it as IT staff'}</b><small>A live queue with real-looking tickets. No sign-up.</small></button>
            <button type="button" onClick={() => demo('requester')} disabled={!!busy}><b>{busy === 'requester' ? 'Setting it up…' : '→ Try it as an employee'}</b><small>Report a problem and watch IT pick it up.</small></button>
          </div>
          <div className="or">or with an account</div>
          {mode !== 'in' && <label className="fld">Your name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>}
          <label className="fld">Work email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <label className="fld">Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} /></label>
          {mode === 'new' && <label className="fld">Company or team name<input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="e.g. Acme IT" /></label>}
          {mode === 'join' && <label className="fld">Join code from your IT team<input value={code} onChange={(e) => setCode(e.target.value)} className="mono" /></label>}
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn-main" disabled={!!busy}>{busy === 'form' ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
          <p className="switch">
            {mode === 'in'
              ? <>New? <button type="button" onClick={() => setMode('join')}>Join your company</button> or <button type="button" onClick={() => setMode('new')}>start a help desk</button></>
              : <>Have an account? <button type="button" onClick={() => setMode('in')}>Sign in</button></>}
          </p>
        </form>
      </section>
    </div>
  );
}
