import { useEffect, useMemo, useState } from 'react';
import { isOpen, minutesLabel, opensLabel, type Hours } from '../../../shared/hours';
import type { Email, User, WorkspaceSettings } from '../../../shared/types';
import { ApiError, api } from '../api';
import { ago, useToast } from '../ui';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toMinutes = (v: string) => { const [h, m] = v.split(':').map(Number); return h * 60 + (m || 0); };
const KIND: Record<string, string> = { created: 'got it', reply: 'IT replied', solved: 'fixed', 'requester-reply': 'to IT', urgent: 'urgent', reset: 'password', incident: 'incident' };

export function SettingsPage({ user, onUser }: { user: User; onUser: (u: User) => void }) {
  const [s, setS] = useState<WorkspaceSettings | null>(null);
  const [emails, setEmails] = useState<Email[]>([]);
  const toast = useToast();
  const loadEmails = () => api.emails().then((r) => setEmails(r.emails)).catch(() => {});
  useEffect(() => { api.settings().then(setS).catch(() => {}); loadEmails(); }, []);
  if (!s) return <main className="page"><div className="empty">Loading…</div></main>;
  const admin = user.role === 'admin';
  return (
    <main className="page">
      <div className="page-h"><div><h1>Settings &amp; email</h1><p>{s.name}</p></div></div>
      <div className="settings">
        <HoursPanel hours={user.hours} canEdit={admin} onSaved={(u) => { onUser(u); toast('Working hours saved. New tickets use them right away.'); }} />
        <EmailPanel settings={s} onTested={() => { loadEmails(); }} />
        <div className="panel">
          <h3>Outbox <span>{s.emailDelivery === 'smtp' ? 'sent through your mail server' : 'recorded here (not delivered yet)'}</span></h3>
          {emails.length === 0 && <p style={{ color: 'var(--dim)' }}>No emails yet.</p>}
          {emails.map((e) => (
            <div className="mail" key={e.id}>
              <span className="kind">{KIND[e.kind] ?? e.kind}</span>
              <b title={e.subject}>{e.subject}</b>
              <small>{ago(e.createdAt)}{e.status === 'failed' ? ' · failed' : ''}</small>
              <details><summary>To {user.demo ? e.to.replace(/\.[a-f0-9]{10}@/, '@') : e.to}</summary><pre>{e.body}</pre></details>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function HoursPanel({ hours, canEdit, onSaved }: { hours: Hours; canEdit: boolean; onSaved: (u: User) => void }) {
  const [h, setH] = useState<Hours>(hours);
  const [error, setError] = useState('');
  const zones = useMemo(() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return [hours.timeZone]; } }, [hours.timeZone]);
  const now = Date.now();
  const open = isOpen(now, h);
  const dirty = JSON.stringify(h) !== JSON.stringify(hours);
  return (
    <form className="panel" onSubmit={async (e) => {
      e.preventDefault();
      setError('');
      try { onSaved((await api.saveSettings({ hours: h })).user); } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save'); }
    }}>
      <h3>Working hours <span>{open ? '● open now' : `☾ closed · ${opensLabel(now, h)}`}</span></h3>
      <p style={{ color: 'var(--mu)', fontSize: 13, marginBottom: 14 }}>Time limits only count while the desk is open. A ticket that arrives on Friday evening starts its clock on Monday morning.</p>
      <fieldset disabled={!canEdit} style={{ border: 0, display: 'grid', gap: 14 }}>
        <div className="form two-col" style={{ display: 'grid' }}>
          <label className="fld">Time zone
            <select value={h.timeZone} onChange={(e) => setH({ ...h, timeZone: e.target.value })}>{zones.map((z) => <option key={z}>{z}</option>)}</select>
          </label>
          <div style={{ display: 'flex', gap: 10 }}>
            <label className="fld" style={{ flex: 1 }}>Opens<input type="time" value={minutesLabel(h.start)} onChange={(e) => setH({ ...h, start: toMinutes(e.target.value) })} /></label>
            <label className="fld" style={{ flex: 1 }}>Closes<input type="time" value={minutesLabel(Math.min(h.end, 1439))} onChange={(e) => setH({ ...h, end: toMinutes(e.target.value) })} /></label>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--mu)', marginBottom: 6 }} id="days-l">Working days</div>
          <div className="days" role="group" aria-labelledby="days-l">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <label key={d} className={h.days.includes(d) ? 'on' : ''}>
                <input type="checkbox" checked={h.days.includes(d)} onChange={(e) => setH({ ...h, days: e.target.checked ? [...h.days, d] : h.days.filter((x) => x !== d) })} />{DAY_NAMES[d]}
              </label>
            ))}
          </div>
        </div>
        <label className="check"><input type="checkbox" checked={h.urgent24x7} onChange={(e) => setH({ ...h, urgent24x7: e.target.checked })} /> Urgent (P1) tickets keep counting around the clock</label>
      </fieldset>
      {error && <p className="err" role="alert">{error}</p>}
      {canEdit ? <div className="dlg-foot"><button className="b solve" disabled={!dirty}>Save hours</button></div> : <p style={{ color: 'var(--dim)', fontSize: 12, marginTop: 10 }}>Only admins can change working hours.</p>}
    </form>
  );
}

function EmailPanel({ settings, onTested }: { settings: WorkspaceSettings; onTested: () => void }) {
  const [from, setFrom] = useState(() => `Jamie Fox <jamie.${Math.random().toString(36).slice(2, 7)}@example.com>`);
  const [subject, setSubject] = useState('Laptop won’t connect to the Wi-Fi in Room B');
  const [text, setText] = useState('Hi IT, since this morning my laptop can’t join the Wi-Fi in meeting room B. My phone connects fine.\n\nThanks,\nGrace');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  return (
    <div className="panel">
      <h3>Email <span>{settings.emailDelivery === 'smtp' ? '● sending through your mail server' : 'not connected to a mail server yet'}</span></h3>
      <div className="notice" style={{ marginBottom: 14 }}>
        <b>Emails out:</b> people get an email when their ticket arrives, when IT replies and when it’s fixed; urgent tickets alert all of IT. Replies to those emails go back onto the ticket.
        {settings.emailDelivery === 'log' && <> Until a mail server is connected (set <code>SMTP_URL</code>), emails are recorded in the outbox below instead of being delivered.</>}
      </div>
      {settings.inboundAddress ? (
        <>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--mu)', marginBottom: 6 }}>Emails in: point your email provider’s inbound webhook here</div>
          <div className="copyline"><code>{settings.inboundAddress}</code><button className="b" onClick={() => { navigator.clipboard?.writeText(settings.inboundAddress!); toast('Address copied'); }}>Copy</button></div>
          <details style={{ marginTop: 14 }} open>
            <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Send a test email to the desk</summary>
            <form className="form" style={{ marginTop: 12 }} onSubmit={async (e) => {
              e.preventDefault();
              setError(''); setResult('');
              try {
                const r = await api.inbound(settings.inboundAddress!, { from, subject, text });
                setResult(r.action === 'created' ? 'It arrived as a new ticket in the queue.' : 'It was added to the existing ticket.');
                toast(r.action === 'created' ? 'New ticket from email' : 'Reply added from email');
                onTested();
              } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not send'); }
            }}>
              <label className="fld">From<input value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="fld">Subject <small style={{ fontWeight: 400 }}>(put a ticket number like [FX-1062] in it to reply to that ticket)</small><input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
              <label className="fld">Message<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
              {error && <p className="err" role="alert">{error}</p>}
              {result && <p style={{ color: 'var(--accent-tx)', fontWeight: 600 }}>{result} <a href="#/q/all" style={{ textDecoration: 'underline' }}>Open the inbox</a></p>}
              <div className="dlg-foot"><button className="b send">Send test email</button></div>
            </form>
          </details>
        </>
      ) : <p style={{ color: 'var(--dim)', fontSize: 13 }}>Ask an admin for the desk’s inbound email address.</p>}
    </div>
  );
}
