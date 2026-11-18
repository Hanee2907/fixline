import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatMinutes } from '../../../shared/sla';
import type { Incident, Kpis, LiveEvent, Ticket, User } from '../../../shared/types';
import { api, connectLive, type View } from '../api';
import { Avatar, Icon, Mark, slaLabel, useNow, useTheme, useToast } from '../ui';
import { NewTicketDialog } from './NewTicket';
import { Palette } from './Palette';
import { IncidentsPage, KnowledgePage, PeoplePage, ReportsPage } from './Pages';
import { TicketPane } from './TicketPane';

export type Route =
  | { page: 'queue'; view: View; id?: number }
  | { page: 'kb'; id?: number }
  | { page: 'reports' } | { page: 'people' } | { page: 'incidents' };

export function parseAgentRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'kb') return { page: 'kb', id: Number(parts[1]) || undefined };
  if (parts[0] === 'reports') return { page: 'reports' };
  if (parts[0] === 'people') return { page: 'people' };
  if (parts[0] === 'incidents') return { page: 'incidents' };
  const view = (parts[0] === 'q' && parts[1] ? decodeURIComponent(parts[1]) : 'all') as View;
  return { page: 'queue', view, id: Number(parts[2]) || undefined };
}
export const go = (path: string) => { location.hash = path; };

const VIEWS: { view: View; label: string; icon: string; count?: (k: Kpis) => number; hot?: boolean }[] = [
  { view: 'all', label: 'Inbox', icon: 'inbox', count: (k) => k.breached + k.dueSoon, hot: true },
  { view: 'mine', label: 'Assigned to me', icon: 'me', count: (k) => k.mine },
  { view: 'unassigned', label: 'Unassigned', icon: 'plus', count: (k) => k.unassigned },
  { view: 'breaching', label: 'Breaching soon', icon: 'alert', count: (k) => k.breached + k.dueSoon },
  { view: 'waiting', label: 'Waiting', icon: 'pause', count: (k) => k.waiting },
  { view: 'solved', label: 'Solved', icon: 'check' },
];

export function Console({ user, onUser }: { user: User; onUser: (u: User | null) => void }) {
  const [route, setRoute] = useState<Route>(() => parseAgentRoute(location.hash));
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [q, setQ] = useState('');
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [palette, setPalette] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rev, setRev] = useState(0); // bumps when the open ticket changed elsewhere
  const [theme, toggleTheme] = useTheme();
  const toast = useToast();
  const now = useNow(30_000);
  const view = route.page === 'queue' ? route.view : 'all';
  const selected = route.page === 'queue' ? route.id : undefined;
  const known = useRef<Set<number>>(new Set());

  useEffect(() => {
    const on = () => setRoute(parseAgentRoute(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  const loadList = useCallback(async () => {
    const r = await api.tickets(view, q);
    // Anything we haven't seen before slides in with a lime flash.
    const arrived = r.tickets.filter((t) => known.current.size && !known.current.has(t.id)).map((t) => t.id);
    r.tickets.forEach((t) => known.current.add(t.id));
    if (arrived.length) {
      setFresh(new Set(arrived));
      setTimeout(() => setFresh(new Set()), 1200);
    }
    setTickets(r.tickets);
  }, [view, q]);
  const loadSide = useCallback(async () => {
    const [k, i] = await Promise.all([api.kpis(), api.incidents()]);
    setKpis(k.kpis);
    setIncidents(i.incidents);
  }, []);

  useEffect(() => { setTickets(null); }, [view]);
  useEffect(() => {
    const t = setTimeout(() => loadList().catch(() => toast('Could not load tickets')), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [loadList, q, toast]);
  useEffect(() => { loadSide().catch(() => {}); }, [loadSide]);

  // Live updates: refetch what changed, a beat later so several changes become one request.
  const pending = useRef<{ list: boolean; side: boolean; ticket: Set<number> }>({ list: false, side: false, ticket: new Set() });
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => connectLive((e: LiveEvent | { type: 'resync' }) => {
    const p = pending.current;
    if (e.type === 'presence') p.side = true;
    else if (e.type === 'incident') { p.side = true; p.list = true; }
    else if (e.type === 'article') { /* knowledge page refreshes itself */ }
    else { p.list = true; p.side = true; if ('ticketId' in e && e.ticketId && e.actorId !== user.id) p.ticket.add(e.ticketId); }
    if (e.type === 'resync') { p.list = true; p.side = true; }
    if (flush.current) return;
    flush.current = setTimeout(() => {
      flush.current = null;
      const { list, side, ticket } = pending.current;
      pending.current = { list: false, side: false, ticket: new Set() };
      if (list) loadList().catch(() => {});
      if (side) loadSide().catch(() => {});
      if (selectedRef.current && ticket.has(selectedRef.current)) setRev((r) => r + 1);
    }, 150);
  }), [loadList, loadSide, user.id]);

  const visibleTickets = tickets ?? [];
  const index = visibleTickets.findIndex((t) => t.id === selected);

  // Keyboard: J/K move, Ctrl+K palette, C new ticket, G then I/K/R jump.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); return; }
      const typing = /input|textarea|select/i.test((e.target as HTMLElement).tagName) || (e.target as HTMLElement).isContentEditable;
      if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
      if (route.page !== 'queue') return;
      if (e.key === 'j' || e.key === 'k') {
        const next = visibleTickets[Math.max(0, Math.min(visibleTickets.length - 1, index + (e.key === 'j' ? 1 : -1)))];
        if (next) go(`/q/${view}/${next.id}`);
      } else if (e.key === 'c') { e.preventDefault(); setCreating(true); }
      else if (e.key === 'Escape' && selected) go(`/q/${view}`);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [route, visibleTickets, index, view, selected]);

  // Keep the selected row in view as J/K moves through the list.
  useEffect(() => { document.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' }); }, [selected]);

  const signOut = async () => { await api.logout(); onUser(null); location.hash = ''; };
  const switchDemo = async () => { const r = await api.switchDemo(); location.hash = ''; onUser(r.user); };
  const activeIncidents = incidents.filter((i) => i.status === 'active');
  const counts = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v.view, kpis && v.count ? v.count(kpis) : 0])), [kpis]);

  const navItem = (path: string, on: boolean, icon: string, label: string, extra?: ReactNode) => (
    <a href={`#${path}`} className={`it${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}><Icon name={icon} />{label}{extra}</a>
  );

  return (
    <div className={`console${route.page === 'queue' ? '' : ' wide'}${selected ? ' has-ticket' : ''}`}>
      <nav className="side" aria-label="Main">
        <div className="brand"><Mark />Fixline<small title={user.workspaceName}>IT desk</small></div>
        <button className="jump" onClick={() => setPalette(true)}>Search or jump to… <kbd>Ctrl K</kbd></button>
        {VIEWS.map((v) => navItem(`/q/${v.view}`, route.page === 'queue' && view === v.view, v.icon, v.label,
          counts[v.view] ? <em className={v.hot && kpis && kpis.breached ? 'hot' : ''}>{counts[v.view]}</em> : null))}
        {navItem('/kb', route.page === 'kb', 'book', 'Knowledge base')}
        {navItem('/reports', route.page === 'reports', 'chart', 'Reports')}
        {navItem('/people', route.page === 'people', 'users', 'People')}
        <div className="grp incidents">Live incidents</div>
        {activeIncidents.map((i) => (
          <a key={i.id} href={`#/q/incident:${i.id}`} className={`it incidents${view === `incident:${i.id}` ? ' on' : ''}`}><span className="dot live" />{i.title}<em>{i.linked}</em></a>
        ))}
        {navItem('/incidents', route.page === 'incidents', 'bolt', activeIncidents.length ? 'All incidents' : 'Incidents')}
        <div className="me">
          <Avatar person={user} me />
          <div style={{ minWidth: 0 }}><b>{user.name}</b><small>● Online · {Math.max(1, kpis?.agentsOnline ?? 1)} {Math.max(1, kpis?.agentsOnline ?? 1) === 1 ? 'agent' : 'agents'}</small></div>
          <div className="tools">
            {user.demo && <button className="icon-btn" title="See it as the employee (Maya)" aria-label="Switch to the employee view" onClick={switchDemo}><Icon name="swap" /></button>}
            <button className="icon-btn" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title="Light / dark" onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
            <button className="icon-btn" aria-label="Sign out" title="Sign out" onClick={signOut}><Icon name="out" /></button>
          </div>
        </div>
      </nav>

      {route.page === 'queue' && (
        <>
          <section className="list" aria-label="Tickets">
            <div className="lh">
              <h2>{VIEWS.find((v) => v.view === view)?.label ?? incidents.find((i) => `incident:${i.id}` === view)?.title ?? 'Tickets'}</h2>
              {kpis && <span className="pill">{kpis.open} open</span>}
              <button className="btn-accent" onClick={() => setCreating(true)} title="New ticket (C)">+ New</button>
            </div>
            {kpis && (
              <div className="stats">
                <div><small>Due in 1h</small><b className={kpis.dueSoon + kpis.breached ? 'r' : ''}>{kpis.dueSoon + kpis.breached}</b></div>
                <div><small>1st response</small><b>{formatMinutes(kpis.firstResponseMinutes)}</b></div>
                <div><small>CSAT</small><b className="l">{kpis.satisfaction == null ? '—' : `${Math.round(kpis.satisfaction * 100)}%`}</b></div>
              </div>
            )}
            <div className="filters" role="tablist" aria-label="Filter tickets">
              {(['all', 'unassigned', 'breaching', 'waiting'] as View[]).map((v) => (
                <a key={v} role="tab" aria-selected={view === v} href={`#/q/${v}`} className={`f${view === v ? ' on' : ''}`}>{{ all: 'All open', unassigned: 'Unassigned', breaching: 'Breaching', waiting: 'Waiting' }[v as 'all']}</a>
              ))}
            </div>
            <div className="search-row" style={{ paddingTop: 10 }}>
              <label className="sr-only" htmlFor="q">Search tickets</label>
              <input id="q" placeholder="Filter by subject, person or FX number" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="rows">
              {tickets === null && <div className="empty">Loading…</div>}
              {tickets?.length === 0 && <div className="empty"><b>{view === 'solved' ? 'Nothing solved yet' : 'All clear'}</b>{view === 'solved' ? 'Solved tickets show up here.' : 'No tickets here right now.'}</div>}
              {visibleTickets.map((t) => {
                const s = slaLabel(t, now);
                return (
                  <a key={t.id} href={`#/q/${view}/${t.id}`} className={`row${t.id === selected ? ' sel' : ''}${fresh.has(t.id) ? ' fresh' : ''}${t.status === 'solved' ? ' solved' : ''}`}
                    aria-current={t.id === selected ? 'true' : undefined}>
                    <span className={`pr ${t.status === 'solved' ? 'ok' : `p${t.priority}`}`}>{t.status === 'solved' ? '✓' : `P${t.priority}`}</span>
                    <b>{t.subject}</b>
                    <span className={`sla tone-${s.tone}`} title={s.s.clock === 'respond' ? 'Time left to first response' : s.s.clock === 'paused' ? t.waitingReason : 'Time left to fix'}>{s.text}</span>
                    <span className="sub"><span className="mono">{t.key}</span>· {t.requester.name.split(' ')[0]} {t.requester.name.split(' ')[1]?.[0] ?? ''}. · {t.incidentId ? 'linked to incident' : t.status === 'waiting' ? t.waitingReason.toLowerCase() : t.category}</span>
                    <span className="ag"><Avatar person={t.assignee} size="sm" me={t.assignee?.id === user.id} /></span>
                  </a>
                );
              })}
            </div>
          </section>
          {selected
            ? <TicketPane key={selected} id={selected} user={user} rev={rev} incidents={incidents} onChanged={() => { loadList(); loadSide(); }} onBack={() => go(`/q/${view}`)} />
            : <section className="detail"><div className="empty" style={{ margin: 'auto' }}><b>Pick a ticket</b>Use <kbd>J</kbd> <kbd>K</kbd> to move through the queue, <kbd>Ctrl K</kbd> to search.</div></section>}
        </>
      )}
      {route.page === 'kb' && <KnowledgePage id={route.id} />}
      {route.page === 'reports' && <ReportsPage />}
      {route.page === 'people' && <PeoplePage user={user} />}
      {route.page === 'incidents' && <IncidentsPage incidents={incidents} onChanged={loadSide} />}

      {palette && <Palette onClose={() => setPalette(false)} onNew={() => { setPalette(false); setCreating(true); }} />}
      {creating && <NewTicketDialog onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); loadList(); loadSide(); go(`/q/all/${t.id}`); toast(`${t.key} created`); }} />}
    </div>
  );
}
