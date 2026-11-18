import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { SLA, formatClock, formatMinutes, slaState } from '../../../shared/sla';
import { CATEGORIES, type Category, type Incident, type Macro, type Person, type Priority, type User } from '../../../shared/types';
import { ApiError, api, type TicketDetail } from '../api';
import { Avatar, Dialog, Icon, celebrate, clockTime, useNow, useToast } from '../ui';
import { AttachButton, Attachments, PendingFiles, useUploads } from '../files';
import { opensLabel } from '../../../shared/hours';

let peopleCache: Promise<(Person & { open: number })[]> | null = null;
let macroCache: Promise<Macro[]> | null = null;
const loadAgents = () => (peopleCache ??= api.people().then((r) => r.people.filter((p) => p.role !== 'requester')));
const loadMacros = () => (macroCache ??= api.macros().then((r) => r.macros));

export function TicketPane({ id, user, rev, incidents, onChanged, onBack }: {
  id: number; user: User; rev: number; incidents: Incident[]; onChanged: () => void; onBack: () => void;
}) {
  const [d, setD] = useState<TicketDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [agents, setAgents] = useState<Person[]>([]);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState(false);
  const [articleId, setArticleId] = useState<number | undefined>();
  const [sending, setSending] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [macroOpen, setMacroOpen] = useState(false);
  const [macroIndex, setMacroIndex] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const files = useUploads();
  const toast = useToast();
  const now = useNow(1000);

  const load = useCallback(async () => {
    try {
      setD(await api.ticket(id));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    }
  }, [id]);
  useEffect(() => { load(); }, [load, rev]);
  useEffect(() => { loadAgents().then(setAgents).catch(() => {}); loadMacros().then(setMacros).catch(() => {}); }, []);

  const t = d?.ticket;
  const update = async (b: Parameters<typeof api.update>[1], msg?: string) => {
    if (!t) return;
    try {
      await api.update(t.id, b);
      await load();
      onChanged();
      if (msg) toast(msg);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save that');
    }
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!t || (!draft.trim() && !files.files.length) || sending) return;
    setSending(true);
    try {
      const r = await api.message(t.id, { kind: note ? 'note' : 'reply', body: draft.trim(), articleId, attachments: files.uploads() });
      setD((prev) => (prev ? { ...prev, ticket: r.ticket, messages: r.messages } : prev));
      setDraft('');
      files.clear();
      setArticleId(undefined);
      onChanged();
      toast(note ? 'Note added' : `Reply sent to ${t.requester.name.split(' ')[0]}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not send');
    } finally {
      setSending(false);
    }
  };

  // R reply, N note, E resolve, A assign to me.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement).tagName);
      if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]') || !t) return;
      if (e.key === 'r') { e.preventDefault(); setNote(false); box.current?.focus(); }
      else if (e.key === 'n') { e.preventDefault(); setNote(true); box.current?.focus(); }
      else if (e.key === 'e' && t.status !== 'solved') { e.preventDefault(); setResolving(true); }
      else if (e.key === 'a' && t.assignee?.id !== user.id && t.status !== 'solved') { e.preventDefault(); update({ assigneeId: user.id }, 'Assigned to you'); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const filteredMacros = macroOpen ? macros.filter((m) => m.title.toLowerCase().includes(draft.slice(1).toLowerCase())) : [];
  const applyMacro = (m: Macro) => {
    setDraft(m.body.replace(/^Thanks/, `Thanks ${t?.requester.name.split(' ')[0] ?? ''}`.trim()));
    setMacroOpen(false);
    box.current?.focus();
  };
  const onBoxKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (macroOpen && filteredMacros.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMacroIndex((i) => (i + 1) % filteredMacros.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMacroIndex((i) => (i - 1 + filteredMacros.length) % filteredMacros.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMacro(filteredMacros[macroIndex] ?? filteredMacros[0]); return; }
      if (e.key === 'Escape') { setMacroOpen(false); return; }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
  };

  if (missing) return <section className="detail"><div className="empty" style={{ margin: 'auto' }}><b>Ticket not found</b>It may have been removed.</div></section>;
  if (!d || !t) return <section className="detail"><div className="empty" style={{ margin: 'auto' }}>Loading…</div></section>;

  const s = slaState(t, now, user.hours);
  const timerTone = s.clock === 'paused' ? '' : s.tone === 'danger' ? 'danger' : s.tone === 'warn' ? 'warn' : '';
  const barColour = s.tone === 'danger' ? 'linear-gradient(90deg,var(--amb),var(--red))' : s.tone === 'warn' ? 'var(--amb)' : s.tone === 'done' ? 'var(--accent)' : 'var(--accent)';
  const timerText = s.clock === 'paused' ? 'paused' : t.status === 'solved' ? (s.clock === 'met' ? 'on time' : 'late') : `${s.afterHours && s.left >= 0 ? '☾ ' : ''}${formatClock(s.left)}`;
  const timerSub = s.afterHours && s.left >= 0 ? `${s.clock === 'respond' ? 'to first response' : 'to fix'} · after hours, ${opensLabel(now, user.hours)}` : s.clock === 'respond' ? 'left to first response' : s.clock === 'resolve' ? 'left to fix' : s.clock === 'paused' ? t.waitingReason || 'waiting' : s.clock === 'missed' && t.status !== 'solved' ? (t.firstResponseAt ? 'past the fix target' : 'past the response target') : `solved ${clockTime(t.solvedAt!)}`;
  const linked = incidents.find((i) => i.id === t.incidentId);

  return (
    <section className="detail" aria-label={`Ticket ${t.key}`}>
      <div className="dtop">
        <button className="icon-btn" onClick={onBack} aria-label="Back to the list"><Icon name="back" /></button>
        <span>Tickets / <b className="mono">{t.key}</b></span>
        <div className="keys"><kbd>J</kbd><kbd>K</kbd> move · <kbd>R</kbd> reply · <kbd>N</kbd> note · <kbd>A</kbd> take · <kbd>E</kbd> resolve</div>
      </div>
      <div className="dbody">
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="conv">
            <h1>{t.subject}</h1>
            <div className={`timer ${timerTone}`} role="timer" aria-live="off">
              <div><span className={`big tone-${s.clock === 'paused' ? 'muted' : s.tone}`}>{timerText}</span><small>{timerSub}</small></div>
              <div className="bar"><span style={{ width: `${Math.round(s.used * 100)}%`, background: barColour }} /></div>
              <div className="tgt">P{t.priority} target<b>{formatMinutes((s.clock === 'respond' ? SLA[t.priority].respond : SLA[t.priority].resolve) / 60000)}</b></div>
            </div>
            {linked && <div className="sys" style={{ paddingLeft: 0 }}><span className="dot live" /> Part of incident <b>{linked.title}</b></div>}
            <div className="ev"><Avatar person={t.requester} /><div className="card"><small>{t.requester.name} · {clockTime(t.createdAt)} · via {t.channel}</small>{t.description || t.subject}<Attachments items={d.attachments} /></div></div>
            {d.messages.map((m) => {
              if (m.kind === 'event') return <div key={m.id} className="sys">{m.body} · {clockTime(m.createdAt)}</div>;
              const mine = m.author?.id === user.id;
              const fromRequester = m.author?.id === t.requester.id;
              return (
                <div key={m.id} className={`ev${m.kind === 'note' ? ' note' : ''}${mine && m.kind !== 'note' ? ' mine' : ''}`}>
                  <Avatar person={m.author} me={mine} />
                  <div className="card"><small>{m.kind === 'note' ? '🔒 Internal note · ' : ''}{mine ? 'You' : m.author?.name ?? 'Fixline'} · {clockTime(m.createdAt)}{m.via === 'email' ? <span className="via">email</span> : fromRequester ? ' · via portal' : ''}</small>{m.body}<Attachments items={m.attachments} /></div>
                </div>
              );
            })}
            {t.status === 'solved' && (
              <div className="resolved"><b>✓ Resolved</b> {t.resolution}{t.rating && <div style={{ marginTop: 6, color: 'var(--mu)' }}>{t.requester.name.split(' ')[0]} rated it {t.rating === 'good' ? '👍 good' : '👎 not good'}</div>}</div>
            )}
          </div>
          {t.status !== 'solved' ? (
            <form className={`composer${note ? ' note' : ''}${files.over ? ' dropping' : ''}`} onSubmit={send} {...files.dropProps}>
              {macroOpen && filteredMacros.length > 0 && (
                <div className="macros" role="listbox" aria-label="Saved replies">
                  {filteredMacros.map((m, i) => (
                    <button type="button" key={m.id} role="option" aria-selected={i === macroIndex} className={i === macroIndex ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); applyMacro(m); }}>
                      <b>{m.title}</b><small>{m.body}</small>
                    </button>
                  ))}
                </div>
              )}
              <label className="sr-only" htmlFor="reply">{note ? 'Internal note' : `Reply to ${t.requester.name}`}</label>
              <PendingFiles files={files.files} remove={files.remove} />
              {files.error && <p className="file-err" role="alert">{files.error}</p>}
              <textarea id="reply" ref={box} value={draft} onKeyDown={onBoxKey} onPaste={files.onPaste}
                placeholder={note ? 'Internal note, only IT sees this… (paste screenshots too)' : `Reply to ${t.requester.name.split(' ')[0]}… type / for saved replies, Ctrl+V to paste a screenshot`}
                onChange={(e) => { setDraft(e.target.value); const open = e.target.value.startsWith('/') && !e.target.value.includes('\n'); setMacroOpen(open); if (open) setMacroIndex(0); }} />
              <div className="a">
                <AttachButton onFiles={files.add} />
                <button type="button" className={`b${note ? ' on' : ''}`} onClick={() => { setNote(!note); box.current?.focus(); }} aria-pressed={note}>🔒 Note</button>
                <button type="button" className="b" onClick={() => { setDraft('/'); setMacroOpen(true); setMacroIndex(0); box.current?.focus(); }}>/ Saved replies</button>
                {t.status === 'waiting'
                  ? <button type="button" className="b" onClick={() => update({ status: 'open' }, 'Clock running again')}>▶ Resume</button>
                  : <button type="button" className="b" onClick={() => setWaiting(true)}>⏸ Pause</button>}
                <button className="b send" disabled={(!draft.trim() && !files.files.length) || sending}>{note ? 'Add note' : 'Send'} <kbd style={{ border: 0, color: 'inherit', opacity: .6 }}>Ctrl ↵</kbd></button>
                <button type="button" className="b solve" onClick={() => setResolving(true)}>Resolve</button>
              </div>
            </form>
          ) : (
            <div className="composer" style={{ padding: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: 'var(--mu)', fontSize: 13 }}>Solved {clockTime(t.solvedAt!)} by {t.assignee?.name ?? 'IT'}.</span>
              <button className="b send" onClick={async () => { await api.reopen(t.id); await load(); onChanged(); toast('Reopened'); }}>Reopen</button>
            </div>
          )}
        </div>

        <aside className="props" aria-label="Ticket details">
          <div>
            <h5>Details</h5>
            <div className="kv">
              <span>Requester</span><span className="val"><Avatar person={t.requester} size="sm" />{t.requester.name}</span>
              <span>Team</span><span className="val" style={{ fontWeight: 500 }}>{t.requester.department || '—'}</span>
              <label htmlFor="f-status">Status</label>
              {t.status === 'solved'
                ? <span className="val" style={{ color: 'var(--accent-tx)' }}>Solved</span>
                : <select id="f-status" value={t.status} onChange={(e) => (e.target.value === 'waiting' ? setWaiting(true) : update({ status: e.target.value as 'new' | 'open' }))}>
                    <option value="new">New</option><option value="open">In progress</option><option value="waiting">Waiting (paused)</option>
                  </select>}
              <label htmlFor="f-pri">Priority</label>
              <select id="f-pri" value={t.priority} disabled={t.status === 'solved'} style={{ color: t.priority === 1 ? 'var(--red)' : t.priority === 2 ? 'var(--amb)' : undefined }}
                onChange={(e) => update({ priority: Number(e.target.value) as Priority }, 'Priority changed, targets updated')}>
                {([1, 2, 3, 4] as Priority[]).map((p) => <option key={p} value={p}>P{p} · {SLA[p].label}</option>)}
              </select>
              <label htmlFor="f-cat">Category</label>
              <select id="f-cat" value={t.category} disabled={t.status === 'solved'} onChange={(e) => update({ category: e.target.value as Category })}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
              <label htmlFor="f-ag">Assignee</label>
              <select id="f-ag" value={t.assignee?.id ?? ''} disabled={t.status === 'solved'} onChange={(e) => update({ assigneeId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Unassigned</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.id === user.id ? `${a.name} (you)` : a.name}</option>)}
              </select>
              <label htmlFor="f-inc">Incident</label>
              <select id="f-inc" value={t.incidentId ?? ''} disabled={t.status === 'solved'} onChange={(e) => update({ incidentId: e.target.value ? Number(e.target.value) : null }, e.target.value ? 'Linked to the incident' : 'Unlinked')}>
                <option value="">None</option>
                {incidents.filter((i) => i.status === 'active' || i.id === t.incidentId).map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
              </select>
              {t.device && <><span>Device</span><span className="val mono" style={{ fontSize: 12 }}>{t.device}</span></>}
              {t.location && <><span>Location</span><span className="val">{t.location}</span></>}
              <span>Opened</span><span className="val" style={{ fontWeight: 500 }}>{new Date(t.createdAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
            </div>
          </div>
          {d.suggestions.length > 0 && (
            <div className="kb">
              <h5>Suggested fixes</h5>
              {d.suggestions.map((sg) => (
                <button key={`${sg.type}${sg.id}`} className="a" onClick={async () => {
                  if (sg.type === 'ticket') { location.hash = `#/q/solved/${sg.id}`; return; }
                  const { article } = await api.article(sg.id);
                  setNote(false);
                  setArticleId(article.id);
                  setDraft(`Hi ${t.requester.name.split(' ')[0]}, this should fix it:\n\n${article.title}\n${article.body}\n\nLet me know if it works!`);
                  box.current?.focus();
                  toast('Guide added to your reply');
                }}>
                  {sg.type === 'article' ? '📘' : '🎫'} {sg.title}<em>{sg.detail}</em>
                </button>
              ))}
            </div>
          )}
          {t.status !== 'solved' && t.assignee?.id !== user.id && (
            <button className="b" style={{ alignSelf: 'flex-start' }} onClick={() => update({ assigneeId: user.id }, 'Assigned to you')}>Take this ticket <kbd>A</kbd></button>
          )}
        </aside>
      </div>

      {resolving && <ResolveDialog onClose={() => setResolving(false)} subject={t.subject} onDone={async (resolution, notify, saveArticle) => {
        await api.resolve(t.id, { resolution, notify, saveArticle });
        setResolving(false);
        celebrate();
        await load();
        onChanged();
        toast(saveArticle ? 'Solved, and saved as a guide' : `${t.key} solved`);
      }} />}
      {waiting && <WaitDialog onClose={() => setWaiting(false)} onDone={async (reason) => { setWaiting(false); await update({ status: 'waiting', waitingReason: reason }, 'Paused: the clock stops until it resumes'); }} />}
    </section>
  );
}

function ResolveDialog({ subject, onClose, onDone }: { subject: string; onClose: () => void; onDone: (r: string, notify: boolean, save?: string) => Promise<void> }) {
  const [resolution, setResolution] = useState('');
  const [notify, setNotify] = useState(true);
  const [save, setSave] = useState(false);
  const [title, setTitle] = useState(subject);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Resolve ticket" sub="Say briefly what fixed it. The person who asked gets your note and can rate the fix." onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await onDone(resolution, notify, save ? title : undefined); } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not resolve'); setBusy(false); }
      }}>
        <label className="fld">What fixed it<textarea autoFocus value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="e.g. Cleared the old password from Credential Manager and restarted Outlook." /></label>
        <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Tell the requester it’s fixed</label>
        <label className="check"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save this fix as a knowledge base guide</label>
        {save && <label className="fld">Guide title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>}
        {error && <p className="err" role="alert">{error}</p>}
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve" disabled={busy || resolution.trim().length < 3}>✓ Resolve</button></div>
      </form>
    </Dialog>
  );
}

function WaitDialog({ onClose, onDone }: { onClose: () => void; onDone: (reason: string) => void }) {
  const [reason, setReason] = useState('Waiting on the requester');
  const options = ['Waiting on the requester', 'Waiting for manager approval', 'Waiting on replacement part', 'Waiting on a supplier', 'Scheduled for later'];
  return (
    <Dialog title="Pause the clock" sub="While a ticket waits on someone else, its time limit stops. It resumes when you or the requester reply." onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onDone(reason); }}>
        <label className="fld">Waiting for
          <select value={options.includes(reason) ? reason : 'other'} onChange={(e) => setReason(e.target.value === 'other' ? '' : e.target.value)}>
            {options.map((o) => <option key={o}>{o}</option>)}<option value="other">Something else…</option>
          </select>
        </label>
        {!options.includes(reason) && <label className="fld">Reason<input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} /></label>}
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b send" disabled={!reason.trim()}>⏸ Pause</button></div>
      </form>
    </Dialog>
  );
}
