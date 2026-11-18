import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { SLA } from '../../../shared/sla';
import type { Article, Category, Incident, Message, Priority, Suggestion, Ticket, User } from '../../../shared/types';
import { ApiError, api, connectLive } from '../api';
import { Avatar, Icon, Mark, ago, celebrate, clockTime, useTheme, useToast } from '../ui';

type Route = { page: 'home' } | { page: 'ticket'; id: number } | { page: 'guide'; id: number } | { page: 'tickets' };
const parse = (hash: string): Route => {
  const [a, b] = hash.replace(/^#\/?/, '').split('/');
  if (a === 't' && Number(b)) return { page: 'ticket', id: Number(b) };
  if (a === 'g' && Number(b)) return { page: 'guide', id: Number(b) };
  if (a === 'tickets') return { page: 'tickets' };
  return { page: 'home' };
};

const STAGE: Record<Ticket['status'], { label: string; step: number }> = {
  new: { label: 'Received', step: 1 },
  open: { label: 'Being worked on', step: 2 },
  waiting: { label: 'Waiting on you or a part', step: 2 },
  solved: { label: 'Fixed', step: 3 },
};

/** What employees see: one box to describe the problem, instant fixes, and a tracker for each ticket. */
export function Portal({ user, onUser }: { user: User; onUser: (u: User | null) => void }) {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [rev, setRev] = useState(0);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const load = useCallback(async () => {
    const [t, i] = await Promise.all([api.tickets(), api.incidents()]);
    setTickets(t.tickets);
    setIncidents(i.incidents);
  }, []);
  useEffect(() => { load().catch(() => {}); }, [load]);
  // Live: when IT replies or fixes something, it shows up straight away.
  useEffect(() => connectLive(() => { load().catch(() => {}); setRev((r) => r + 1); }), [load]);

  const signOut = async () => { await api.logout(); onUser(null); location.hash = ''; };
  const switchDemo = async () => { const r = await api.switchDemo(); location.hash = ''; onUser(r.user); };
  const open = tickets.filter((t) => t.status !== 'solved');

  return (
    <div className="portal">
      <header className="ptop">
        <a href="#/" className="brand"><Mark />Fixline</a>
        <nav aria-label="Main">
          <a href="#/" className={route.page === 'home' ? 'on' : ''}>Get help</a>
          <a href="#/tickets" className={route.page === 'tickets' || route.page === 'ticket' ? 'on' : ''}>My tickets{open.length ? ` · ${open.length}` : ''}</a>
        </nav>
        <div className="right">
          {user.demo && <button className="b" onClick={switchDemo} title="See what IT sees"><Icon name="swap" size={13} /> Switch to IT view</button>}
          <button className="icon-btn" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <Avatar person={user} />
          <button className="icon-btn" aria-label="Sign out" onClick={signOut}><Icon name="out" /></button>
        </div>
      </header>
      <main className="pwrap">
        {incidents.filter((i) => i.status === 'active').map((i) => (
          <div className="banner" role="status" key={i.id}>
            <span className="dot live" style={{ marginTop: 6 }} />
            <div><b>Known issue: {i.title}</b><p>{i.message} · started {ago(i.createdAt)}</p></div>
          </div>
        ))}
        {route.page === 'home' && <Home user={user} tickets={tickets} onCreated={(t) => { load(); location.hash = `#/t/${t.id}`; }} />}
        {route.page === 'tickets' && <TicketList tickets={tickets} />}
        {route.page === 'ticket' && <TicketView id={route.id} rev={rev} onChanged={load} />}
        {route.page === 'guide' && <Guide id={route.id} />}
      </main>
    </div>
  );
}

function Home({ user, tickets, onCreated }: { user: User; tickets: Ticket[]; onCreated: (t: Ticket) => void }) {
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');
  const [fixes, setFixes] = useState<Suggestion[]>([]);
  const [guess, setGuess] = useState<{ category: Category; priority: Priority } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  // As they type: guides that might fix it, and how the ticket would be sorted.
  useEffect(() => {
    const text = `${subject} ${details}`.trim();
    if (text.length < 4) { setFixes([]); setGuess(null); return; }
    const t = setTimeout(() => api.suggest(text).then((r) => { setFixes(r.suggestions); setGuess({ category: r.category, priority: r.priority }); }).catch(() => {}), 220);
    return () => clearTimeout(t);
  }, [subject, details]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.create({ subject, description: details });
      toast(`Sent! Your ticket is ${r.ticket.key}`);
      onCreated(r.ticket);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send. Check your connection.');
      setBusy(false);
    }
  };
  const recent = tickets.slice(0, 3);
  return (
    <>
      <section className="hero">
        <h1>Hi {user.name.split(' ')[0]}, <em>what’s going wrong?</em></h1>
        <p>Describe it in your own words. You’ll see fixes as you type, and if none work, IT gets it straight away.</p>
        <form className="ask" onSubmit={submit}>
          <label className="sr-only" htmlFor="ask-s">Describe the problem</label>
          <input id="ask-s" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Outlook keeps asking for my password" maxLength={140} />
          <label className="sr-only" htmlFor="ask-d">More details</label>
          <textarea id="ask-d" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Anything else? When did it start, what have you tried, which computer…" />
          <div className="bar">
            <span className="guess" aria-live="polite">{guess ? <>Will go to IT as <span className="tag">{guess.category}</span><span className="tag">{SLA[guess.priority].label}</span> · first reply within {SLA[guess.priority].respond / 60000 >= 60 ? `${SLA[guess.priority].respond / 3600000}h` : `${SLA[guess.priority].respond / 60000} min`}</> : 'IT replies within 2 hours on working days, much faster if it’s urgent.'}</span>
            <button className="send" disabled={busy || subject.trim().length < 3}>{busy ? 'Sending…' : 'Send to IT'}</button>
          </div>
        </form>
        {error && <p className="err" role="alert">{error}</p>}
        {fixes.length > 0 && (
          <div className="fixes" aria-label="Guides that might fix this">
            <div style={{ fontSize: 13, color: 'var(--mu)' }}>✨ These fixed the same problem for others:</div>
            {fixes.map((f) => (
              <a key={f.id} className="fix" href={`#/g/${f.id}`}><span>📘</span><span><b>{f.title}</b><small>Takes about 2 minutes</small></span><em>{f.detail}</em></a>
            ))}
          </div>
        )}
      </section>
      {recent.length > 0 && (
        <section className="sect">
          <h2>Your recent tickets</h2>
          <TicketList tickets={recent} compact />
        </section>
      )}
    </>
  );
}

function TicketList({ tickets, compact }: { tickets: Ticket[]; compact?: boolean }) {
  if (!tickets.length) return <div className="empty"><b>No tickets yet</b>When you ask IT for help, you can follow it here.</div>;
  return (
    <div className="mytix" style={compact ? undefined : { marginTop: 4 }}>
      {!compact && <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.5px', marginBottom: 8 }}>My tickets</h1>}
      {tickets.map((t) => (
        <a key={t.id} className="myt" href={`#/t/${t.id}`}>
          <b>{t.subject}</b><span className={`stage ${t.status}`}>{STAGE[t.status].label}</span>
          <small><span className="mono">{t.key}</span> · opened {ago(t.createdAt)}{t.assignee ? ` · ${t.assignee.name.split(' ')[0]} from IT is on it` : ''}</small>
        </a>
      ))}
    </div>
  );
}

function TicketView({ id, rev, onChanged }: { id: number; rev: number; onChanged: () => void }) {
  const [d, setD] = useState<{ ticket: Ticket; messages: Message[] } | null>(null);
  const [reply, setReply] = useState('');
  const [rated, setRated] = useState(false);
  const toast = useToast();
  const load = useCallback(() => api.ticket(id).then(setD).catch(() => setD(null)), [id]);
  useEffect(() => { load(); }, [load, rev]);
  if (!d) return <div className="empty">Loading…</div>;
  const t = d.ticket;
  const step = t.rating ? 4 : STAGE[t.status].step;
  return (
    <section>
      <a href="#/tickets" className="b" style={{ display: 'inline-block', marginBottom: 14 }}>← My tickets</a>
      <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-.5px' }}>{t.subject}</h1>
      <div style={{ color: 'var(--dim)', marginTop: 4 }}><span className="mono">{t.key}</span> · {t.category} · opened {ago(t.createdAt)}</div>
      <div className="track" aria-hidden="true">{[1, 2, 3, 4].map((s) => <span key={s} className={s <= step ? 'done' : ''} />)}</div>
      <div className="track-l"><span className={step >= 1 ? '' : ''}><b>Received</b></span><span>{step >= 2 ? <b>In progress</b> : 'In progress'}</span><span>{step >= 3 ? <b>Fixed</b> : 'Fixed'}</span><span>{step >= 4 ? <b>Rated</b> : 'Rated'}</span></div>
      <p className="sr-only">Status: {STAGE[t.status].label}</p>
      {t.status === 'waiting' && <div className="banner" style={{ marginTop: 16, borderColor: 'var(--note-line)', background: 'var(--note-bg)' }}><span>⏸</span><div><b>{t.waitingReason}</b><p>Reply below if IT asked you something. The ticket picks up again as soon as you do.</p></div></div>}

      <div style={{ display: 'grid', gap: 12, marginTop: 22 }}>
        <div className="ev"><Avatar person={t.requester} /><div className="card"><small>You · {clockTime(t.createdAt)}</small>{t.description || t.subject}</div></div>
        {d.messages.filter((m) => m.kind !== 'event').map((m) => (
          <div key={m.id} className={`ev${m.author?.id === t.requester.id ? '' : ' mine'}`}>
            <Avatar person={m.author} />
            <div className="card"><small>{m.author?.id === t.requester.id ? 'You' : `${m.author?.name ?? 'IT'} · IT`} · {clockTime(m.createdAt)}</small>{m.body}</div>
          </div>
        ))}
      </div>

      {t.status === 'solved' && !t.rating && !rated && (
        <div className="rate" style={{ marginTop: 16 }}>
          <b style={{ marginRight: 'auto' }}>Did this fix it?</b>
          <button onClick={async () => { await api.rate(t.id, 'good'); setRated(true); celebrate(); toast('Thanks for the feedback!'); load(); onChanged(); }}>👍 Yes, all good</button>
          <button onClick={async () => { await api.reopen(t.id); toast('Reopened. IT will take another look'); load(); onChanged(); }}>👎 No, still broken</button>
        </div>
      )}
      {t.rating && <p style={{ marginTop: 16, color: 'var(--mu)' }}>You rated this {t.rating === 'good' ? '👍' : '👎'}. Thanks!</p>}

      <form className="composer" style={{ margin: '20px 0 0' }} onSubmit={async (e) => {
        e.preventDefault();
        if (!reply.trim()) return;
        await api.message(t.id, { kind: 'reply', body: reply.trim() });
        setReply('');
        load();
        onChanged();
        toast('Sent to IT');
      }}>
        <label className="sr-only" htmlFor="p-reply">Reply to IT</label>
        <textarea id="p-reply" value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t.status === 'solved' ? 'Still having trouble? Reply and the ticket reopens.' : 'Add a message for IT…'} />
        <div className="a"><button className="b send" disabled={!reply.trim()}>Send</button></div>
      </form>
    </section>
  );
}

function Guide({ id }: { id: number }) {
  const [a, setA] = useState<Article | null>(null);
  const [done, setDone] = useState(false);
  const toast = useToast();
  useEffect(() => { api.article(id).then((r) => setA(r.article)).catch(() => {}); }, [id]);
  if (!a) return <div className="empty">Loading…</div>;
  return (
    <article>
      <a href="#/" className="b" style={{ display: 'inline-block', marginBottom: 14 }}>← Back</a>
      <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-.5px', marginBottom: 14 }}>{a.title}</h1>
      <div className="article-body">{a.body}</div>
      {!done ? (
        <div className="rate" style={{ marginTop: 22 }}>
          <b style={{ marginRight: 'auto' }}>Did this fix it?</b>
          <button onClick={async () => { await api.helped(a.id); setDone(true); celebrate(); toast('Great! No ticket needed.'); }}>👍 Yes, fixed</button>
          <a href="#/" className="b" style={{ padding: '8px 14px' }}>No, send it to IT</a>
        </div>
      ) : <p style={{ marginTop: 18, color: 'var(--accent-tx)', fontWeight: 600 }}>Glad it worked. You saved yourself a wait!</p>}
    </article>
  );
}
