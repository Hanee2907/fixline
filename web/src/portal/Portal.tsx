import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { SLA } from '../../../shared/sla';
import type { Article, Attachment, CatalogItem, Category, Incident, Message, Priority, Suggestion, Ticket, User } from '../../../shared/types';
import { ApiError, api, connectLive } from '../api';
import { Avatar, Icon, Mark, ago, celebrate, clockTime, useTheme, useToast } from '../ui';
import { AttachButton, Attachments, PendingFiles, useUploads } from '../files';
import { Approvals, AskAssistant, MaintenanceBanner, MyDevices, RequestForm } from './Extras';

type Route = { page: 'home'; device?: string } | { page: 'ticket'; id: number } | { page: 'guide'; id: number } | { page: 'tickets' } | { page: 'approvals' } | { page: 'devices' };
const parse = (hash: string): Route => {
  const [a, b] = hash.replace(/^#\/?/, '').split('/');
  if (a === 't' && Number(b)) return { page: 'ticket', id: Number(b) };
  if (a === 'g' && Number(b)) return { page: 'guide', id: Number(b) };
  if (a === 'tickets') return { page: 'tickets' };
  if (a === 'approvals') return { page: 'approvals' };
  if (a === 'devices') return { page: 'devices' };
  if (a === 'new' && b) return { page: 'home', device: decodeURIComponent(b) };
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
  const [toApprove, setToApprove] = useState(0);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const load = useCallback(async () => {
    const [t, i, a] = await Promise.all([api.tickets(), api.incidents(), api.approvals()]);
    setTickets(t.tickets);
    setIncidents(i.incidents);
    setToApprove(a.tickets.length);
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
          {(user.isManager || toApprove > 0) && <a href="#/approvals" className={route.page === 'approvals' ? 'on' : ''}>Approvals{toApprove ? <em className="nb">{toApprove}</em> : ''}</a>}
          <a href="#/devices" className={route.page === 'devices' ? 'on' : ''}>My devices</a>
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
        <MaintenanceBanner />
        {route.page === 'home' && <Home key={route.device ?? ''} user={user} device={route.device} tickets={tickets} onCreated={(t) => { load(); location.hash = `#/t/${t.id}`; }} />}
        {route.page === 'approvals' && <Approvals onChanged={load} />}
        {route.page === 'devices' && <MyDevices />}
        {route.page === 'tickets' && <TicketList tickets={tickets} />}
        {route.page === 'ticket' && <TicketView id={route.id} rev={rev} onChanged={load} />}
        {route.page === 'guide' && <Guide id={route.id} />}
      </main>
    </div>
  );
}

function Home({ user, device, tickets, onCreated }: { user: User; device?: string; tickets: Ticket[]; onCreated: (t: Ticket) => void }) {
  const [subject, setSubject] = useState(device ? `Problem with ${device}: ` : '');
  const [matches, setMatches] = useState<{ item: CatalogItem; prefill: Record<string, string> }[]>([]);
  const [picked, setPicked] = useState<{ item: CatalogItem; prefill: Record<string, string>; note: string } | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [aiOn, setAiOn] = useState(false);
  useEffect(() => {
    api.catalog().then((r) => setCatalog(r.items)).catch(() => {});
    api.aiStatus().then((r) => setAiOn(r.enabled)).catch(() => {});
  }, []);
  const [details, setDetails] = useState('');
  const [fixes, setFixes] = useState<Suggestion[]>([]);
  const [guess, setGuess] = useState<{ category: Category; priority: Priority } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const files = useUploads();
  const toast = useToast();

  // As they type: guides that might fix it, and how the ticket would be sorted.
  useEffect(() => {
    const text = `${subject} ${details}`.trim();
    if (text.length < 4) { setFixes([]); setGuess(null); setMatches([]); return; }
    const t = setTimeout(() => {
      api.suggest(text).then((r) => { setFixes(r.suggestions); setGuess({ category: r.category, priority: r.priority }); }).catch(() => {});
      // "I need Acrobat" is a request, not a fault: offer the right form, already filled in.
      api.matchCatalog(text).then((r) => setMatches(r.matches)).catch(() => {});
    }, 220);
    return () => clearTimeout(t);
  }, [subject, details]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.create({ subject, description: details, attachments: files.uploads() });
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
        <p>Describe it in your own words, or say what you need. You’ll see fixes as you type, and if none work, IT gets it straight away.</p>
        {picked ? <RequestForm item={picked.item} prefill={picked.prefill} note={picked.note} onClose={() => setPicked(null)} onCreated={onCreated} /> : <>
        <form className={`ask${files.over ? ' dropping' : ''}`} onSubmit={submit} {...files.dropProps}>
          <label className="sr-only" htmlFor="ask-s">Describe the problem</label>
          <input id="ask-s" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} onPaste={files.onPaste} placeholder="e.g. Outlook keeps asking for my password" maxLength={140} />
          <label className="sr-only" htmlFor="ask-d">More details</label>
          <textarea id="ask-d" value={details} onChange={(e) => setDetails(e.target.value)} onPaste={files.onPaste} placeholder="Anything else? When did it start, what have you tried… Paste a screenshot with Ctrl+V." />
          <PendingFiles files={files.files} remove={files.remove} />
          {files.error && <p className="file-err" role="alert">{files.error}</p>}
          <div className="bar">
            <AttachButton onFiles={files.add} label="📎 Add a screenshot" />
            <span className="guess" aria-live="polite">{guess ? <>Will go to IT as <span className="tag">{guess.category}</span><span className="tag">{SLA[guess.priority].label}</span> · first reply within {SLA[guess.priority].respond / 60000 >= 60 ? `${SLA[guess.priority].respond / 3600000}h` : `${SLA[guess.priority].respond / 60000} min`}</> : 'IT replies within 2 hours on working days, much faster if it’s urgent.'}</span>
            <button className="send" disabled={busy || subject.trim().length < 3}>{busy ? 'Sending…' : 'Send to IT'}</button>
          </div>
        </form>
        {error && <p className="err" role="alert">{error}</p>}
        {matches.length > 0 && (
          <div className="fixes" aria-label="Requests that match">
            <div style={{ fontSize: 13, color: 'var(--mu)' }}>📋 Sounds like you need something. Use the form and skip the back-and-forth:</div>
            {matches.map((m) => (
              <button key={m.item.id} type="button" className="fix req" onClick={() => setPicked({ ...m, note: details })}>
                <span className="emoji">{m.item.icon}</span>
                <span><b>{m.item.name}</b><small>{m.item.description}{Object.keys(m.prefill).length ? ' · already filled in from what you typed' : ''}</small></span>
                <em>{m.item.needsApproval ? 'manager approves' : 'no approval'} →</em>
              </button>
            ))}
          </div>
        )}
        {fixes.length > 0 && (
          <div className="fixes" aria-label="Guides that might fix this">
            <div style={{ fontSize: 13, color: 'var(--mu)' }}>✨ These fixed the same problem for others:</div>
            {fixes.map((f) => (
              <a key={f.id} className="fix" href={`#/g/${f.id}`}><span>📘</span><span><b>{f.title}</b><small>Takes about 2 minutes</small></span><em>{f.detail}</em></a>
            ))}
          </div>
        )}
        {aiOn && `${subject} ${details}`.trim().length >= 10 && !matches.length && (
          <div className="fixes"><AskAssistant question={`${subject}\n${details}`.trim()} onTicket={() => submit()} /></div>
        )}
        </>}
      </section>
      {!picked && catalog.length > 0 && (
        <section className="sect">
          <h2>Or ask IT for something</h2>
          <div className="cat-grid">
            {catalog.map((c) => (
              <button key={c.id} className="cat" onClick={() => { setPicked({ item: c, prefill: {}, note: '' }); scrollTo({ top: 0, behavior: 'smooth' }); }}>
                <span className="emoji">{c.icon}</span><b>{c.name}</b><small>{c.description}</small>
              </button>
            ))}
          </div>
        </section>
      )}
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
  const [d, setD] = useState<{ ticket: Ticket; messages: Message[]; attachments: Attachment[] } | null>(null);
  const [reply, setReply] = useState('');
  const [rated, setRated] = useState(false);
  const files = useUploads();
  const toast = useToast();
  const load = useCallback(() => api.ticket(id).then(setD).catch(() => setD(null)), [id]);
  useEffect(() => { load(); }, [load, rev]);
  if (!d) return <div className="empty">Loading…</div>;
  const t = d.ticket;
  const approvalFlow = t.approval != null;
  const steps = approvalFlow ? ['Asked', t.approval === 'rejected' ? 'Declined' : 'Approved', 'In progress', 'Done'] : ['Received', 'In progress', 'Fixed', 'Rated'];
  const step = approvalFlow
    ? (t.approval === 'pending' ? 1 : t.approval === 'rejected' ? 2 : t.status === 'solved' ? 4 : t.status === 'new' ? 2 : 3)
    : (t.rating ? 4 : STAGE[t.status].step);
  return (
    <section>
      <a href="#/tickets" className="b" style={{ display: 'inline-block', marginBottom: 14 }}>← My tickets</a>
      <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-.5px' }}>{t.subject}</h1>
      <div style={{ color: 'var(--dim)', marginTop: 4 }}><span className="mono">{t.key}</span> · {t.category} · opened {ago(t.createdAt)}</div>
      <div className={`track${t.approval === 'rejected' ? ' declined' : ''}`} aria-hidden="true">{[1, 2, 3, 4].map((s) => <span key={s} className={s <= step ? 'done' : ''} />)}</div>
      <div className="track-l">{steps.map((label, i) => <span key={label}>{step >= i + 1 ? <b>{label}</b> : label}</span>)}</div>
      <p className="sr-only">Status: {t.approval === 'pending' ? 'Waiting for approval' : STAGE[t.status].label}</p>
      {Object.keys(t.form).length > 0 && <div className="answers" style={{ marginTop: 18 }}>{Object.entries(t.form).filter(([, v]) => v).map(([k, v]) => <div key={k}><small>{k}</small><span>{v}</span></div>)}</div>}
      {t.approval === 'pending' && <div className="banner" style={{ marginTop: 16, borderColor: 'var(--note-line)', background: 'var(--note-bg)' }}><span>✉</span><div><b>Waiting for {t.approver?.name ?? 'your manager'} to approve</b><p>They got an email with a one-tap approve button. IT starts the moment they say yes, and the clock doesn’t run until then.</p></div></div>}
      {t.approval === 'rejected' && <div className="banner" style={{ marginTop: 16 }}><span>✕</span><div><b>{t.approver?.name ?? 'Your manager'} declined this</b><p>{t.resolution}</p></div></div>}
      {t.status === 'waiting' && t.approval !== 'pending' && <div className="banner" style={{ marginTop: 16, borderColor: 'var(--note-line)', background: 'var(--note-bg)' }}><span>⏸</span><div><b>{t.waitingReason}</b><p>Reply below if IT asked you something. The ticket picks up again as soon as you do.</p></div></div>}

      <div style={{ display: 'grid', gap: 12, marginTop: 22 }}>
        <div className="ev"><Avatar person={t.requester} /><div className="card"><small>You · {clockTime(t.createdAt)}</small>{t.description || t.subject}<Attachments items={d.attachments} /></div></div>
        {d.messages.filter((m) => m.kind !== 'event').map((m) => (
          <div key={m.id} className={`ev${m.author?.id === t.requester.id ? '' : ' mine'}`}>
            <Avatar person={m.author} />
            <div className="card"><small>{m.author?.id === t.requester.id ? 'You' : `${m.author?.name ?? 'IT'} · IT`} · {clockTime(m.createdAt)}{m.via === 'email' ? <span className="via">email</span> : null}</small>{m.body}<Attachments items={m.attachments} /></div>
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

      <form className={`composer${files.over ? ' dropping' : ''}`} style={{ margin: '20px 0 0' }} {...files.dropProps} onSubmit={async (e) => {
        e.preventDefault();
        if (!reply.trim() && !files.files.length) return;
        try {
          await api.message(t.id, { kind: 'reply', body: reply.trim(), attachments: files.uploads() });
        } catch (err) { toast(err instanceof ApiError ? err.message : 'Could not send'); return; }
        setReply('');
        files.clear();
        load();
        onChanged();
        toast('Sent to IT');
      }}>
        <label className="sr-only" htmlFor="p-reply">Reply to IT</label>
        <PendingFiles files={files.files} remove={files.remove} />
        {files.error && <p className="file-err" role="alert">{files.error}</p>}
        <textarea id="p-reply" value={reply} onChange={(e) => setReply(e.target.value)} onPaste={files.onPaste} placeholder={t.status === 'solved' ? 'Still having trouble? Reply and the ticket reopens.' : 'Add a message for IT…'} />
        <div className="a"><AttachButton onFiles={files.add} /><button className="b send" disabled={!reply.trim() && !files.files.length}>Send</button></div>
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
