import { useState, type FormEvent } from 'react';
import type { User } from '../../shared/types';
import { ApiError, api } from './api';
import { Mark } from './ui';

export function AuthPage({ onUser }: { onUser: (u: User) => void }) {
  const [mode, setMode] = useState<'in' | 'new' | 'join' | 'forgot'>('in');
  const [sent, setSent] = useState('');
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
      if (mode === 'forgot') {
        setSent((await api.forgot(email)).message);
        setBusy('');
        return;
      }
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
          <h2>{mode === 'in' ? 'Sign in' : mode === 'new' ? 'Start a help desk' : mode === 'forgot' ? 'Reset your password' : 'Join your company'}</h2>
          {mode === 'forgot' ? (
            <>
              <p className="switch">Enter your work email and we’ll send a link to choose a new password. It works once and expires in 30 minutes.</p>
              <label className="fld">Work email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus /></label>
              {sent && <p className="notice" role="status">{sent}</p>}
              {error && <p className="err" role="alert">{error}</p>}
              <button className="btn-main" disabled={!!busy || !email}>{busy === 'form' ? 'One moment…' : 'Send reset link'}</button>
              <p className="switch"><button type="button" onClick={() => { setMode('in'); setSent(''); setError(''); }}>← Back to sign in</button></p>
            </>
          ) : <>
          <div className="demo-btns">
            <button type="button" onClick={() => demo('agent')} disabled={!!busy}><b>{busy === 'agent' ? 'Setting it up…' : '→ Try it as IT staff'}</b><small>A live queue with real-looking tickets. No sign-up.</small></button>
            <button type="button" onClick={() => demo('requester')} disabled={!!busy}><b>{busy === 'requester' ? 'Setting it up…' : '→ Try it as an employee'}</b><small>Report a problem and watch IT pick it up.</small></button>
          </div>
          <div className="or">or with an account</div>
          {mode !== 'in' && <label className="fld">Your name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>}
          <label className="fld">Work email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <label className="fld">Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} /></label>
          {mode === 'in' && <p className="switch" style={{ marginTop: -4 }}><button type="button" onClick={() => { setMode('forgot'); setError(''); }}>Forgot password?</button></p>}
          {mode === 'new' && <label className="fld">Company or team name<input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="e.g. Acme IT" /></label>}
          {mode === 'join' && <label className="fld">Join code from your IT team<input value={code} onChange={(e) => setCode(e.target.value)} className="mono" /></label>}
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn-main" disabled={!!busy}>{busy === 'form' ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
          <p className="switch">
            {mode === 'in'
              ? <>New? <button type="button" onClick={() => setMode('join')}>Join your company</button> or <button type="button" onClick={() => setMode('new')}>start a help desk</button></>
              : <>Have an account? <button type="button" onClick={() => setMode('in')}>Sign in</button></>}
          </p>
          </>}
        </form>
      </section>
    </div>
  );
}

/** Opened from the emailed link: #/reset/<token>. */
export function ResetPage({ token, onUser }: { token: string; onUser: (u: User) => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth" style={{ gridTemplateColumns: '1fr' }}>
      <section className="auth-r">
        <form noValidate onSubmit={async (e) => {
          e.preventDefault();
          if (password !== again) { setError('The two passwords don’t match'); return; }
          setBusy(true); setError('');
          try {
            const r = await api.reset(token, password);
            history.replaceState(null, '', location.pathname);
            onUser(r.user);
          } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not reset'); setBusy(false); }
        }}>
          <div className="brand" style={{ padding: 0 }}><Mark />Fixline</div>
          <h2>Choose a new password</h2>
          <p className="switch">You’ll be signed out everywhere else.</p>
          <label className="fld">New password<input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} /></label>
          <label className="fld">Type it again<input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></label>
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn-main" disabled={busy || password.length < 8}>{busy ? 'One moment…' : 'Save and sign in'}</button>
        </form>
      </section>
    </div>
  );
}
