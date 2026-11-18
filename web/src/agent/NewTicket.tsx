import { useEffect, useState } from 'react';
import { SLA } from '../../../shared/sla';
import { CATEGORIES, type Category, type Person, type Priority, type Ticket } from '../../../shared/types';
import { ApiError, api } from '../api';
import { Dialog } from '../ui';

/** IT logs a ticket for someone who phoned or walked up. Category and priority fill themselves in. */
export function NewTicketDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: Ticket) => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [requesterId, setRequesterId] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<Category | ''>('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [guess, setGuess] = useState<{ category: Category; priority: Priority } | null>(null);
  const [channel, setChannel] = useState('phone');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.people().then((r) => setPeople(r.people)).catch(() => {}); }, []);
  useEffect(() => {
    const text = `${subject} ${description}`.trim();
    if (text.length < 4) { setGuess(null); return; }
    const t = setTimeout(() => api.suggest(text).then((r) => setGuess({ category: r.category, priority: r.priority })).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [subject, description]);

  return (
    <Dialog title="New ticket" sub="For a call, a walk-up or an email. Leave category and priority on Auto and Fixline sorts it." onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const r = await api.create({
            subject, description, channel,
            requesterId: requesterId ? Number(requesterId) : undefined,
            category: category || guess?.category, priority: priority || guess?.priority,
          });
          onCreated(r.ticket);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Could not create the ticket');
          setBusy(false);
        }
      }}>
        <div className="two-col">
          <label className="fld">For
            <select value={requesterId} onChange={(e) => setRequesterId(e.target.value)}>
              <option value="">Me</option>
              {people.filter((p) => p.role === 'requester').map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ` · ${p.department}` : ''}</option>)}
            </select>
          </label>
          <label className="fld">Came in by
            <select value={channel} onChange={(e) => setChannel(e.target.value)}><option value="phone">Phone</option><option value="email">Email</option><option value="portal">Walk-up / other</option></select>
          </label>
        </div>
        <label className="fld">Subject<input autoFocus required minLength={3} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Label printer offline at the shipping dock" /></label>
        <label className="fld">Details<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <div className="two-col">
          <label className="fld">Category
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              <option value="">Auto{guess ? ` · ${guess.category}` : ''}</option>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="fld">Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value ? (Number(e.target.value) as Priority) : '')}>
              <option value="">Auto{guess ? ` · P${guess.priority} ${SLA[guess.priority].label}` : ''}</option>
              {([1, 2, 3, 4] as Priority[]).map((p) => <option key={p} value={p}>P{p} · {SLA[p].label}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve" disabled={busy || subject.trim().length < 3}>Create ticket</button></div>
      </form>
    </Dialog>
  );
}
