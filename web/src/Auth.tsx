import { useEffect, useState, type FormEvent } from 'react';
import type { User } from '../../shared/types';
import { ApiError, api, type SignIn } from './api';
import { Mark } from './ui';

const SSO_ERRORS: Record<string, string> = {
  'no-account': 'There’s no Fixline account for that email yet. Ask IT to add you, or to turn on sign-in for your company’s domain.',
  'no-email': 'Your account didn’t share a verified email address, so we couldn’t match it to anyone.',
  mismatch: 'That email is already linked to a different Microsoft or Google account.',
  expired: 'That sign-in took too long or was opened twice. Please try again.',
  provider: 'Microsoft or Google didn’t confirm the sign-in. Please try again.',
  'not-configured': 'Single sign-on isn’t set up on this server yet.',
};

/** Continue with Microsoft / Google, shown only when the server has them set up. */
function SsoButtons() {
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { api.ssoProviders().then((r) => setProviders(r.providers)).catch(() => {}); }, []);
  if (!providers.length) return null;
  return (
    <div className="sso">
      {providers.map((p) => (
        <a key={p.id} className="sso-btn" href={`/api/sso/${p.id}/start`}>
          {p.id === 'microsoft'
            ? <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="#f25022" d="M0 0h7.5v7.5H0z" /><path fill="#7fba00" d="M8.5 0H16v7.5H8.5z" /><path fill="#00a4ef" d="M0 8.5h7.5V16H0z" /><path fill="#ffb900" d="M8.5 8.5H16V16H8.5z" /></svg>
            : <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.7 17.8 9.5 24 9.5z" /><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" /><path fill="#FBBC05" d="M10.6 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7z" /><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.2-13.4-9.9l-8 6.2C6.6 42.6 14.6 48 24 48z" /></svg>}
          Continue with {p.name}
        </a>
      ))}
      <div className="or">or</div>
    </div>
  );
}

/** Step two: the 6-digit code from an authenticator app, or a recovery code. */
function TwoFactorStep({ challenge, onUser, onRestart }: { challenge: string; onUser: (u: User) => void; onRestart: (why: string) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  return (
    <form noValidate onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError('');
      try { onUser((await api.secondFactor(challenge, code)).user); } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Could not check the code';
        if (/start again/i.test(msg)) onRestart(msg); else { setError(msg); setBusy(false); setCode(''); }
      }
    }}>
      <h2>Two-step sign-in</h2>
      <p className="switch">{recovery ? 'Type one of the recovery codes you saved when you turned this on. Each works once.' : 'Open your authenticator app and type the 6-digit code for Fixline.'}</p>
      <label className="fld">{recovery ? 'Recovery code' : 'Code'}
        <input className="mono code-in" autoFocus inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" value={code} maxLength={recovery ? 9 : 6}
          onChange={(e) => setCode(recovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ''))} placeholder={recovery ? 'XXXX-XXXX' : '123456'} />
      </label>
      {error && <p className="err" role="alert">{error}</p>}
      <button className="btn-main" disabled={busy || code.length < 6}>{busy ? 'Checking…' : 'Sign in'}</button>
      <p className="switch"><button type="button" onClick={() => { setRecovery(!recovery); setCode(''); setError(''); }}>{recovery ? 'Use the app instead' : 'Lost your phone? Use a recovery code'}</button></p>
    </form>
  );
}

export function AuthPage({ onUser }: { onUser: (u: User) => void }) {
  const [mode, setMode] = useState<'in' | 'new' | 'join' | 'forgot'>('in');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [sent, setSent] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [org, setOrg] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState(() => {
    const why = location.hash.match(/^#\/sso-error\/([\w-]+)/)?.[1];
    return why ? SSO_ERRORS[why] ?? 'Sign-in didn’t work. Please try again.' : '';
  });
  const [busy, setBusy] = useState('');
  useEffect(() => { if (location.hash.startsWith('#/sso-error/')) history.replaceState(null, '', location.pathname); }, []);

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
      const r: SignIn = mode === 'in'
        ? await api.login({ email, password })
        : await api.signup({ name, email, password, workspaceName: mode === 'new' ? org : undefined, joinCode: mode === 'join' ? code : undefined });
      if (r.twoFactor && r.challenge) { setChallenge(r.challenge); setBusy(''); setPassword(''); return; }
      onUser(r.user!);
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
        {challenge ? <TwoFactorStep challenge={challenge} onUser={onUser} onRestart={(why) => { setChallenge(null); setError(why); }} /> :
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
          {mode === 'in' && <SsoButtons />}
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
        </form>}
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
  const [challenge, setChallenge] = useState<string | null>(null);
  return (
    <div className="auth" style={{ gridTemplateColumns: '1fr' }}>
      <section className="auth-r">
        {challenge ? <TwoFactorStep challenge={challenge} onUser={onUser} onRestart={() => { location.hash = ''; location.reload(); }} /> :
        <form noValidate onSubmit={async (e) => {
          e.preventDefault();
          if (password !== again) { setError('The two passwords don’t match'); return; }
          setBusy(true); setError('');
          try {
            const r = await api.reset(token, password);
            history.replaceState(null, '', location.pathname);
            // A reset link proves you own the email; with two-step sign-in on, the code is still needed.
            if (r.twoFactor && r.challenge) { setChallenge(r.challenge); setBusy(false); return; }
            onUser(r.user!);
          } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not reset'); setBusy(false); }
        }}>
          <div className="brand" style={{ padding: 0 }}><Mark />Fixline</div>
          <h2>Choose a new password</h2>
          <p className="switch">You’ll be signed out everywhere else.</p>
          <label className="fld">New password<input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} /></label>
          <label className="fld">Type it again<input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></label>
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn-main" disabled={busy || password.length < 8}>{busy ? 'One moment…' : 'Save and sign in'}</button>
        </form>}
      </section>
    </div>
  );
}
