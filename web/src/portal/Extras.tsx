import { useEffect, useState } from 'react';
import type { Asset, CatalogItem, Ticket } from '../../../shared/types';
import { ApiError, api } from '../api';
import { ago, celebrate, useToast } from '../ui';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Planned work in the next day, so nobody opens a ticket for something IT is doing on purpose. */
export function MaintenanceBanner() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.maintenance>>['maintenance']>([]);
  useEffect(() => { api.maintenance().then((r) => setItems(r.maintenance)).catch(() => {}); }, []);
  return (
    <>
      {items.map((m) => (
        <div className="banner plan" role="status" key={m.title + m.start}>
          <span style={{ marginTop: 1 }}>🛠</span>
          <div>
            <b>Planned work: {m.title}</b>
            <p>{m.affects ? `${m.affects} may be unavailable ` : 'Expect a short interruption '}
              {new Date(m.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} to {new Date(m.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. No need to report it.</p>
          </div>
        </div>
      ))}
    </>
  );
}

/** A request form, already filled in from what the person typed. */
export function RequestForm({ item, prefill, note, onClose, onCreated }: { item: CatalogItem; prefill: Record<string, string>; note: string; onClose: () => void; onCreated: (t: Ticket) => void }) {
  const [form, setForm] = useState<Record<string, string>>(prefill);
  const [extra, setExtra] = useState(note);
  const [error, setError] = useState<{ text: string; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <form className="reqform" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      try {
        const { ticket } = await api.request({ itemId: item.id, form, note: extra });
        toast(ticket.approval === 'pending' ? `Sent to ${ticket.approver?.name.split(' ')[0] ?? 'your manager'} for a quick yes` : `Sent! Your request is ${ticket.key}`);
        onCreated(ticket);
      } catch (err) {
        setError({ text: errText(err, 'Could not send'), field: err instanceof ApiError ? err.field?.replace(/^form\./, '') : undefined });
        setBusy(false);
      }
    }}>
      <div className="reqform-h">
        <span className="emoji">{item.icon}</span>
        <div><b>{item.name}</b><small>{item.needsApproval ? 'Your manager gets a one-tap approval by email. IT starts as soon as they say yes.' : 'No approval needed. It goes straight to IT.'}</small></div>
        <button type="button" className="icon-btn" aria-label="Close the form" onClick={onClose} style={{ marginLeft: 'auto' }}>×</button>
      </div>
      <div className="form">
        {item.fields.map((f) => {
          const id = `rf-${f.key}`;
          const bad = error?.field === f.key;
          const common = { id, value: form[f.key] ?? '', 'aria-invalid': bad || undefined, onChange: (e: { target: { value: string } }) => setForm({ ...form, [f.key]: e.target.value }) };
          return (
            <label key={f.key} className="fld" htmlFor={id}>
              <span>{f.label}{f.required ? '' : <span className="dim"> · optional</span>}{prefill[f.key] && <span className="filled"> ✨ filled in for you</span>}</span>
              {f.type === 'textarea' ? <textarea {...common} style={{ minHeight: 70 }} />
                : f.type === 'select' ? <select {...common}><option value="">Choose…</option>{f.options?.map((o) => <option key={o}>{o}</option>)}</select>
                : <input {...common} type={f.type === 'date' ? 'date' : 'text'} />}
            </label>
          );
        })}
        <label className="fld"><span>Anything else IT should know<span className="dim"> · optional</span></span><textarea value={extra} onChange={(e) => setExtra(e.target.value)} style={{ minHeight: 50 }} /></label>
        {error && <p className="err" role="alert">{error.text}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="b" onClick={onClose}>Cancel</button>
          <button className="send-btn" disabled={busy}>{busy ? 'Sending…' : item.needsApproval ? 'Send for approval' : 'Send to IT'}</button>
        </div>
      </div>
    </form>
  );
}

/** "Ask the assistant": an answer from the desk's own guides, with the guides it used. */
export function AskAssistant({ question, onTicket }: { question: string; onTicket: () => void }) {
  const [state, setState] = useState<'idle' | 'busy' | Awaited<ReturnType<typeof api.aiAsk>> | { error: string }>('idle');
  useEffect(() => { setState('idle'); }, [question]);
  if (state === 'idle') return <button type="button" className="ai-btn" onClick={async () => { setState('busy'); try { setState(await api.aiAsk(question)); } catch (e) { setState({ error: errText(e, 'The assistant couldn’t answer just now.') }); } }}>✨ Ask the IT assistant first</button>;
  if (state === 'busy') return <div className="ai-card"><span className="ai-dots" aria-label="Thinking"><i /><i /><i /></span> Reading the IT guides…</div>;
  if ('error' in state) return <div className="ai-card"><p>{state.error}</p></div>;
  if (!state.answer) return <div className="ai-card"><p>None of the IT guides cover this yet, so it’s best to send it to IT.</p><button className="b" onClick={onTicket}>Send it to IT</button></div>;
  return (
    <div className="ai-card" aria-live="polite">
      <small className="ai-l">✨ From the IT guides</small>
      <div className="article-body" style={{ fontSize: 14 }}>{state.answer}</div>
      {state.sources.length > 0 && <div className="ai-src">Based on {state.sources.map((s, i) => <span key={s.id}>{i > 0 && ', '}<a href={`#/g/${s.id}`}>{s.title}</a></span>)}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="b solve" onClick={() => { celebrate(); setState('idle'); }}>👍 That fixed it</button>
        <button className="b" onClick={onTicket}>Still stuck, send it to IT</button>
      </div>
    </div>
  );
}

/** Requests waiting for my yes or no (I'm someone's manager). */
export function Approvals({ onChanged }: { onChanged: () => void }) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [declining, setDeclining] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const toast = useToast();
  const load = () => api.approvals().then((r) => setTickets(r.tickets)).catch(() => {});
  useEffect(() => { load(); }, []);
  const decide = async (t: Ticket, d: 'approve' | 'decline') => {
    try { await api.decide(t.id, d, comment); toast(d === 'approve' ? `Approved. ${t.requester.name.split(' ')[0]} and IT have been told.` : 'Declined, with your note'); setDeclining(null); setComment(''); load(); onChanged(); } catch (e) { toast(errText(e, 'Could not save')); }
  };
  return (
    <section>
      <h1 className="big-h">Approvals</h1>
      <p style={{ color: 'var(--mu)', marginBottom: 16 }}>Your team’s requests. IT starts the moment you say yes.</p>
      {tickets?.length === 0 && <div className="empty"><b>Nothing waiting</b>You’re all caught up.</div>}
      <div className="mytix">
        {tickets?.map((t) => (
          <div key={t.id} className="appr">
            <div>
              <b>{t.subject}</b>
              <small className="dim">{t.requester.name} · asked {ago(t.createdAt)}</small>
              <div className="answers compact">{Object.entries(t.form).filter(([, v]) => v).map(([k, v]) => <div key={k}><small>{k}</small><span>{v}</span></div>)}</div>
            </div>
            {declining === t.id ? (
              <div className="form" style={{ gridColumn: '1 / -1' }}>
                <label className="fld">Why not? {t.requester.name.split(' ')[0]} will see this<textarea autoFocus value={comment} onChange={(e) => setComment(e.target.value)} /></label>
                <div style={{ display: 'flex', gap: 8 }}><button className="b" onClick={() => setDeclining(null)}>Back</button><button className="b danger" onClick={() => decide(t, 'decline')}>Decline</button></div>
              </div>
            ) : (
              <div className="appr-a"><button className="b solve" onClick={() => decide(t, 'approve')}>✓ Approve</button><button className="b" onClick={() => setDeclining(t.id)}>Decline</button></div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** My devices: what I have, and a one-tap way to report a problem with one. */
export function MyDevices() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  useEffect(() => { api.myAssets().then((r) => setAssets(r.assets)).catch(() => {}); }, []);
  return (
    <section>
      <h1 className="big-h">My devices</h1>
      <p style={{ color: 'var(--mu)', marginBottom: 16 }}>When you report a problem, IT already knows which device it’s about.</p>
      {assets?.length === 0 && <div className="empty"><b>No devices on file</b>Ask IT to add your laptop.</div>}
      <div className="cards">
        {assets?.map((a) => {
          const warranty = a.warrantyUntil ? Date.parse(a.warrantyUntil) > Date.now() : null;
          return (
            <div key={a.id} className="tile dev">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className="emoji">{a.type === 'laptop' ? '💻' : a.type === 'desktop' ? '🖥️' : a.type === 'phone' ? '📱' : a.type === 'monitor' ? '🖵' : '🔧'}</span>
                <div><b style={{ margin: 0 }}>{a.name}</b><small className="mono dim">{a.tag} · {a.model}</small></div>
              </div>
              <div className="meta" style={{ marginTop: 12 }}>
                {warranty !== null && <span className={`tag ${warranty ? 'ok' : ''}`}>{warranty ? `warranty to ${new Date(a.warrantyUntil!).toLocaleDateString([], { month: 'short', year: 'numeric' })}` : 'out of warranty'}</span>}
                {a.openTickets > 0 && <span className="tag amb">{a.openTickets} open ticket{a.openTickets === 1 ? '' : 's'}</span>}
              </div>
              <a className="b" style={{ marginTop: 12, display: 'inline-block' }} href={`#/new/${encodeURIComponent(a.tag)}`}>Report a problem with it</a>
            </div>
          );
        })}
      </div>
    </section>
  );
}
