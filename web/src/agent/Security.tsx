import { useEffect, useState } from 'react';
import type { User, WorkspaceSettings } from '../../../shared/types';
import { ApiError, api } from '../api';
import { useToast } from '../ui';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Two-step sign-in for my own account: scan, confirm a code, save recovery codes. */
export function TwoFactorPanel({ user, onUser }: { user: User; onUser: (u: User) => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const refreshUser = async () => { const r = await api.me(); if (r.user) onUser(r.user); };

  return (
    <div className="panel">
      <h3>Two-step sign-in <span>{user.twoFactor ? '● on for your account' : 'off'}</span></h3>
      {codes ? (
        <div className="form">
          <p style={{ color: 'var(--mu)' }}>It’s on. Save these recovery codes somewhere safe, like a password manager. Each one works once if you lose your phone. You won’t see them again.</p>
          <div className="codes mono">{codes.map((c) => <span key={c}>{c}</span>)}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="b" onClick={() => { navigator.clipboard?.writeText(codes.join('\n')); toast('Codes copied'); }}>Copy codes</button>
            <button className="b solve" onClick={() => { setCodes(null); refreshUser(); }}>I’ve saved them</button>
          </div>
        </div>
      ) : user.twoFactor ? (
        turningOff ? (
          <form className="form" onSubmit={async (e) => { e.preventDefault(); try { await api.disable2fa(password); setTurningOff(false); setPassword(''); await refreshUser(); toast('Two-step sign-in is off'); } catch (err) { setError(errText(err, 'Could not turn it off')); } }}>
            <label className="fld">Your password, to confirm<input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
            {error && <p className="err" role="alert">{error}</p>}
            <div style={{ display: 'flex', gap: 8 }}><button type="button" className="b" onClick={() => setTurningOff(false)}>Keep it on</button><button className="b danger">Turn off</button></div>
          </form>
        ) : (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <p style={{ color: 'var(--mu)', flex: 1, minWidth: 240 }}>Signing in needs your password and a code from your phone. Someone who steals your password still can’t get in.</p>
            <button className="b" onClick={() => { setTurningOff(true); setError(''); }}>Turn off…</button>
          </div>
        )
      ) : setup ? (
        <form className="form" onSubmit={async (e) => {
          e.preventDefault();
          try { setCodes((await api.enable2fa(code)).recoveryCodes); setSetup(null); setCode(''); } catch (err) { setError(errText(err, 'That code isn’t right')); }
        }}>
          <div className="totp">
            <img src={setup.qr} alt="QR code to add Fixline to your authenticator app" width={180} height={180} />
            <div>
              <p><b>1.</b> Open an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…) and scan this.</p>
              <p className="dim" style={{ fontSize: 12 }}>Can’t scan? Enter this key: <code className="mono">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code></p>
              <p style={{ marginTop: 10 }}><b>2.</b> Type the 6-digit code it shows.</p>
              <input className="mono code-in" inputMode="numeric" autoComplete="one-time-code" aria-label="6-digit code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" />
            </div>
          </div>
          {error && <p className="err" role="alert">{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}><button type="button" className="b" onClick={() => setSetup(null)}>Cancel</button><button className="b solve" disabled={code.length !== 6}>Turn on</button></div>
        </form>
      ) : (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <p style={{ color: 'var(--mu)', flex: 1, minWidth: 240 }}>Add a code from your phone on top of your password. Strongly recommended for IT staff, who can see everyone’s tickets.</p>
          <button className="b solve" disabled={user.demo} title={user.demo ? 'Not available in the demo' : undefined}
            onClick={async () => { setError(''); try { setSetup(await api.setup2fa()); } catch (err) { toast(errText(err, 'Could not start')); } }}>Set it up</button>
        </div>
      )}
    </div>
  );
}

/** Company sign-in: which email domain belongs to this desk. */
export function SsoPanel({ settings, canEdit, demo, onSaved }: { settings: WorkspaceSettings; canEdit: boolean; demo: boolean; onSaved: () => void }) {
  const [domain, setDomain] = useState(settings.ssoDomain);
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api.ssoProviders().then((r) => setProviders(r.providers)).catch(() => {}); }, []);
  return (
    <form className="panel" onSubmit={async (e) => { e.preventDefault(); setError(''); try { await api.saveSettings({ ssoDomain: domain }); onSaved(); } catch (err) { setError(errText(err, 'Could not save')); } }}>
      <h3>Sign in with Microsoft or Google <span>{providers.length ? `● ${providers.map((p) => p.name).join(' and ')} ready` : 'not set up on the server yet'}</span></h3>
      <p style={{ color: 'var(--mu)', fontSize: 13, marginBottom: 12 }}>
        People sign in with their work account instead of a separate password. Anyone whose email ends with your domain joins this desk as an employee the first time they sign in.
        {!providers.length && ' Your server admin adds the Microsoft or Google app keys first.'}
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="fld" style={{ flex: 1, minWidth: 220 }}>Company email domain<input value={domain} disabled={!canEdit || demo} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" /></label>
        {canEdit && <button className="b solve" style={{ padding: '9px 14px' }} disabled={demo || domain === settings.ssoDomain}>Save</button>}
      </div>
      {error && <p className="err" role="alert">{error}</p>}
    </form>
  );
}
