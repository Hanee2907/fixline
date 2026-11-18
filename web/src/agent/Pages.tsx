import { useEffect, useState } from 'react';
import { formatMinutes } from '../../../shared/sla';
import { CATEGORIES, type Article, type Category, type Incident, type Person, type Reports, type User } from '../../../shared/types';
import { ApiError, api } from '../api';
import { Avatar, Dialog, ago, useToast } from '../ui';

const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

/* ---------- Knowledge base ---------- */
export function KnowledgePage({ id }: { id?: number }) {
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Article | 'new' | null>(null);
  const toast = useToast();
  const load = () => api.articles(q).then((r) => setArticles(r.articles)).catch(() => {});
  useEffect(() => { const t = setTimeout(load, q ? 200 : 0); return () => clearTimeout(t); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = id ? articles?.find((a) => a.id === id) : undefined;

  if (open) {
    return (
      <main className="page">
        <div className="page-h"><a className="b" href="#/kb">← All guides</a><span className="tag">{open.category}</span><span className="tag">fixed {open.uses}×</span>
          <button className="b" style={{ marginLeft: 'auto' }} onClick={() => setEditing(open)}>Edit</button></div>
        <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-.5px', marginBottom: 16, maxWidth: 760 }}>{open.title}</h1>
        <div className="article-body" style={{ maxWidth: 760 }}>{open.body}</div>
        {editing && <ArticleDialog article={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); toast('Guide saved'); }} />}
      </main>
    );
  }
  return (
    <main className="page">
      <div className="page-h">
        <div><h1>Knowledge base</h1><p>Guides IT writes once, so nobody solves the same problem twice. Employees see them while they type.</p></div>
        <button className="btn-accent" onClick={() => setEditing('new')}>+ New guide</button>
      </div>
      <div className="search-row" style={{ padding: '0 0 16px', maxWidth: 420 }}>
        <label className="sr-only" htmlFor="kbq">Search guides</label>
        <input id="kbq" placeholder="Search guides" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="cards">
        {articles?.map((a) => (
          <a key={a.id} className="tile" href={`#/kb/${a.id}`}>
            <b>{a.title}</b><p>{a.body}</p>
            <div className="meta"><span className="tag">{a.category}</span><span>fixed {a.uses}×</span><span style={{ marginLeft: 'auto' }}>{ago(a.updatedAt)}</span></div>
          </a>
        ))}
      </div>
      {articles?.length === 0 && <div className="empty"><b>No guides found</b>Write one, or tick “Save as guide” when you resolve a ticket.</div>}
      {editing && <ArticleDialog article={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); toast('Guide saved'); }} />}
    </main>
  );
}

function ArticleDialog({ article, onClose, onSaved }: { article?: Article; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(article?.title ?? '');
  const [body, setBody] = useState(article?.body ?? '');
  const [category, setCategory] = useState<Category>(article?.category ?? 'Other');
  const [error, setError] = useState('');
  return (
    <Dialog title={article ? 'Edit guide' : 'New guide'} sub="Short steps work best. Employees will see this when they describe a matching problem." onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.saveArticle({ title, body, category }, article?.id); onSaved(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save'); }
      }}>
        <label className="fld">Title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="fld">Category<select value={category} onChange={(e) => setCategory(e.target.value as Category)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="fld">Steps<textarea style={{ minHeight: 180 }} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="dlg-foot">
          {article && <button type="button" className="b danger" style={{ marginRight: 'auto' }} onClick={async () => { await api.deleteArticle(article.id); location.hash = '#/kb'; onSaved(); }}>Delete</button>}
          <button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve">Save guide</button>
        </div>
      </form>
    </Dialog>
  );
}

/* ---------- Reports ---------- */
export function ReportsPage() {
  const [r, setR] = useState<Reports | null>(null);
  useEffect(() => { api.reports().then((x) => setR(x.reports)).catch(() => {}); }, []);
  if (!r) return <main className="page"><div className="empty">Loading…</div></main>;
  const max = Math.max(1, ...r.volume.map((v) => Math.max(v.created, v.solved)));
  const catMax = Math.max(1, ...r.byCategory.map((c) => c.count));
  return (
    <main className="page">
      <div className="page-h"><div><h1>Reports</h1><p>Last 30 days, unless it says otherwise.</p></div></div>
      <div className="grid4">
        <div className="metric"><small>Solved on time</small><b className="l">{pct(r.onTimeRate)}</b></div>
        <div className="metric"><small>Average first response</small><b>{formatMinutes(r.firstResponseMinutes)}</b></div>
        <div className="metric"><small>Happy users</small><b>{pct(r.satisfaction)}</b></div>
        <div className="metric"><small>Tickets, last 14 days</small><b>{r.volume.reduce((s, v) => s + v.created, 0)}</b></div>
      </div>
      <div className="two">
        <div className="panel">
          <h3>Created vs solved <span>last 14 days</span></h3>
          <div className="bars" role="img" aria-label={r.volume.map((v) => `${v.day}: ${v.created} created, ${v.solved} solved`).join('. ')}>
            {r.volume.map((v) => (
              <div key={v.day} title={`${v.day}: ${v.created} created, ${v.solved} solved`}>
                <i style={{ height: `${(v.created / max) * 100}%` }} />
                <i className="l" style={{ height: `${(v.solved / max) * 100}%` }} />
                {new Date(v.day + 'T12:00:00').toLocaleDateString([], { weekday: 'narrow' })}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 12, color: 'var(--dim)' }}><span>▮ created</span><span style={{ color: 'var(--accent-tx)' }}>▮ solved</span></div>
        </div>
        <div className="panel">
          <h3>Most common problems</h3>
          {r.byCategory.map((c) => (
            <div className="hbar" key={c.category}><span>{c.category}</span><span className="track"><span style={{ width: `${(c.count / catMax) * 100}%` }} /></span><em>{c.count}</em></div>
          ))}
        </div>
      </div>
      <div className="two">
        <div className="panel">
          <h3>Team</h3>
          <table className="t">
            <thead><tr><th>Agent</th><th>Solved</th><th>Open now</th><th>Average fix time</th></tr></thead>
            <tbody>{r.byAgent.map((a) => <tr key={a.name}><td><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Avatar person={a} size="sm" />{a.name}</span></td><td>{a.solved}</td><td>{a.open}</td><td>{formatMinutes(a.avgFixMinutes)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Guides that fixed the most</h3>
          {r.topArticles.map((a) => <div className="hbar" key={a.title} style={{ gridTemplateColumns: '1fr 40px' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</span><em>{a.uses}×</em></div>)}
        </div>
      </div>
    </main>
  );
}

/* ---------- People ---------- */
export function PeoplePage({ user }: { user: User }) {
  const [people, setPeople] = useState<(Person & { open: number; managerId: number | null })[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const toast = useToast();
  const load = () => api.people().then((r) => setPeople(r.people)).catch(() => {});
  useEffect(() => { load(); api.settings().then((w) => setCode(w.joinCode)).catch(() => {}); }, []);
  return (
    <main className="page">
      <div className="page-h"><div><h1>People</h1><p>{user.workspaceName}</p></div></div>
      {code && (
        <div className="panel" style={{ marginBottom: 14, maxWidth: 640 }}>
          <h3>Invite your team</h3>
          <p style={{ color: 'var(--mu)', fontSize: 13 }}>Employees sign up with this join code. Make someone IT staff by changing their role below.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <code className="mono" style={{ fontSize: 18, padding: '6px 12px', border: '1px solid var(--line2)', borderRadius: 8 }}>{code}</code>
            <button className="b" onClick={() => { navigator.clipboard?.writeText(code); toast('Join code copied'); }}>Copy</button>
          </div>
        </div>
      )}
      <div className="panel">
        <table className="t">
          <thead><tr><th>Name</th><th>Team</th><th>Email</th><th>Role</th><th title="Approves their requests">Manager</th><th>Open tickets</th></tr></thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <td><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Avatar person={p} size="sm" me={p.id === user.id} />{p.name}</span></td>
                <td>{p.department || '—'}</td>
                <td style={{ color: 'var(--mu)' }}>{user.demo ? '—' : p.email}</td>
                <td>
                  {user.role === 'admin' && p.id !== user.id
                    ? <select aria-label={`Role for ${p.name}`} value={p.role} onChange={async (e) => { try { await api.setRole(p.id, e.target.value as Person['role']); toast('Role updated'); load(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Could not change role'); } }}>
                        <option value="requester">Employee</option><option value="agent">IT agent</option><option value="admin">Admin</option>
                      </select>
                    : { requester: 'Employee', agent: 'IT agent', admin: 'Admin' }[p.role]}
                </td>
                <td>
                  {user.role === 'admin'
                    ? <select aria-label={`Manager for ${p.name}`} value={p.managerId ?? ''} onChange={async (e) => { try { await api.setManager(p.id, e.target.value ? Number(e.target.value) : null); toast('Manager updated. They approve this person’s requests now.'); load(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Could not change'); } }}>
                        <option value="">An admin</option>
                        {people.filter((m) => m.id !== p.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    : people.find((m) => m.id === p.managerId)?.name ?? '—'}
                </td>
                <td>{p.role === 'requester' ? '—' : p.open}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

/* ---------- Incidents ---------- */
export function IncidentsPage({ incidents, onChanged }: { incidents: Incident[]; onChanged: () => void }) {
  const [declaring, setDeclaring] = useState(false);
  const [resolving, setResolving] = useState<Incident | null>(null);
  const toast = useToast();
  return (
    <main className="page">
      <div className="page-h">
        <div><h1>Incidents</h1><p>When many people hit the same problem: declare it once, every employee sees a banner, and resolving it closes every linked ticket.</p></div>
        <button className="btn-accent" onClick={() => setDeclaring(true)}>+ Declare incident</button>
      </div>
      <div style={{ display: 'grid', gap: 10, maxWidth: 860 }}>
        {incidents.length === 0 && <div className="empty"><b>No incidents</b>Everything is running normally.</div>}
        {incidents.map((i) => (
          <div key={i.id} className={`incident${i.status === 'resolved' ? ' done' : ''}`}>
            <span className={i.status === 'active' ? 'dot live' : 'dot'} style={i.status === 'active' ? undefined : { background: 'var(--accent)' }} />
            <div>
              <b>{i.title}</b>
              <div style={{ color: 'var(--mu)', fontSize: 13 }}>{i.message}</div>
              <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 4 }}>{i.linked} linked tickets · started {ago(i.createdAt)}{i.resolvedAt ? ` · resolved ${ago(i.resolvedAt)}` : ''}</div>
            </div>
            {i.status === 'active'
              ? <div style={{ display: 'flex', gap: 8 }}><a className="b" href={`#/q/incident:${i.id}`}>View tickets</a><button className="b solve" onClick={() => setResolving(i)}>Resolve all</button></div>
              : <span className="tag">resolved</span>}
          </div>
        ))}
      </div>
      {declaring && <DeclareDialog onClose={() => setDeclaring(false)} onDone={() => { setDeclaring(false); onChanged(); toast('Incident declared: employees now see a banner'); }} />}
      {resolving && <ResolveIncident incident={resolving} onClose={() => setResolving(null)} onDone={(n) => { setResolving(null); onChanged(); toast(`Incident resolved · ${n} tickets closed and everyone told`); }} />}
    </main>
  );
}

function DeclareDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('We know about this and are working on it. No need to open a new ticket.');
  const [error, setError] = useState('');
  return (
    <Dialog title="Declare an incident" sub="Employees see this as a banner when they open the portal." onClose={onClose}>
      <form className="form" onSubmit={async (e) => { e.preventDefault(); try { await api.createIncident({ title, message }); onDone(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not declare'); } }}>
        <label className="fld">What’s broken<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Email is slow for everyone" /></label>
        <label className="fld">Message for employees<textarea value={message} onChange={(e) => setMessage(e.target.value)} /></label>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve" disabled={title.trim().length < 3}>Declare</button></div>
      </form>
    </Dialog>
  );
}

function ResolveIncident({ incident, onClose, onDone }: { incident: Incident; onClose: () => void; onDone: (n: number) => void }) {
  const [resolution, setResolution] = useState('');
  return (
    <Dialog title={`Resolve “${incident.title}”`} sub={`This closes all ${incident.linked} linked tickets and sends each person your message.`} onClose={onClose}>
      <form className="form" onSubmit={async (e) => { e.preventDefault(); const r = await api.resolveIncident(incident.id, resolution); onDone(r.solved); }}>
        <label className="fld">What fixed it<textarea autoFocus value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="e.g. The provider restored the VPN gateway." /></label>
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve" disabled={resolution.trim().length < 3}>Resolve all</button></div>
      </form>
    </Dialog>
  );
}
