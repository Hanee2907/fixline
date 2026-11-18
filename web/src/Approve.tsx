import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { Mark } from './ui';

type Link = Awaited<ReturnType<typeof api.approvalLink>>;

/**
 * Opened from the approval email: #/approve/<token>. Works without signing in, because the link
 * itself proves who it was sent to. Opening it changes nothing; only pressing a button does.
 */
export function ApprovePage({ token }: { token: string }) {
  const [d, setD] = useState<Link | null>(null);
  const [error, setError] = useState('');
  const [declining, setDeclining] = useState(false);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState<'approve' | 'decline' | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.approvalLink(token).then(setD).catch((e) => setError(e instanceof ApiError ? e.message : 'Could not open this approval.')); }, [token]);

  const decide = async (decision: 'approve' | 'decline') => {
    setBusy(true);
    try { await api.decideLink(token, decision, comment); setDone(decision); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not save your decision.'); setBusy(false); }
  };
  const t = d?.ticket;
  return (
    <div className="auth" style={{ gridTemplateColumns: '1fr' }}>
      <section className="auth-r">
        <div className="approve">
          <div className="brand" style={{ padding: 0, marginBottom: 18 }}><Mark />Fixline</div>
          {error && !done && <><h2>This link has expired</h2><p className="switch" style={{ marginTop: 8 }}>{error} If the request is still waiting, you can approve it from Fixline under Approvals.</p></>}
          {!error && !d && <p className="switch">Loading…</p>}
          {done && (
            <div className="done-card">
              <span className="big-tick">{done === 'approve' ? '✓' : '✕'}</span>
              <h2>{done === 'approve' ? 'Approved' : 'Declined'}</h2>
              <p className="switch">{t!.requester.split(' ')[0]} has been told{done === 'approve' ? ', and IT has started on it.' : '.'} You can close this page.</p>
            </div>
          )}
          {t && !done && !error && (
            <>
              <p className="switch">Hi {d!.approver.split(' ')[0]}, {t.requester} is asking for:</p>
              <h2 style={{ margin: '6px 0 14px' }}>{t.subject}</h2>
              <div className="answers">
                {Object.entries(t.form).filter(([, v]) => v).map(([k, v]) => <div key={k}><small>{k}</small><span>{v}</span></div>)}
                <div><small>From</small><span>{t.requester}{t.department ? ` · ${t.department}` : ''}</span></div>
              </div>
              {t.approval !== 'pending' ? (
                <p className="notice" style={{ marginTop: 16 }}>This was already {t.approval === 'approved' ? 'approved' : 'declined'}. Nothing more to do.</p>
              ) : declining ? (
                <div className="form" style={{ marginTop: 16 }}>
                  <label className="fld">Tell {t.requester.split(' ')[0]} why (optional)<textarea autoFocus value={comment} onChange={(e) => setComment(e.target.value)} placeholder="e.g. Let’s use the team licence instead" /></label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="b" onClick={() => setDeclining(false)}>Back</button>
                    <button className="btn-main danger-main" style={{ flex: 1 }} disabled={busy} onClick={() => decide('decline')}>Decline</button>
                  </div>
                </div>
              ) : (
                <div className="approve-btns">
                  <button className="btn-main" disabled={busy} onClick={() => decide('approve')}>✓ Approve</button>
                  <button className="b" disabled={busy} onClick={() => setDeclining(true)}>Decline…</button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
