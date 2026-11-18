import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { SLA } from '../../../shared/sla';
import {
  CATEGORIES, type Asset, type AuditEntry, type CatalogItem, type Category, type Change, type FormField, type Person, type Priority, type Problem,
  type ProblemCandidate, type Rule, type RuleAction, type RuleCondition, type RuleField, type Ticket, type User,
} from '../../../shared/types';
import { ApiError, api, type AssetDraft, type ChangeDraft } from '../api';
import { Avatar, Dialog, ago, useToast } from '../ui';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
export const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayOnly = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
type Agent = Person & { open: number; managerId: number | null };
let agentsCache: Promise<Agent[]> | null = null;
const loadPeople = () => (agentsCache ??= api.people().then((r) => r.people));

function Header({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  return <div className="page-h"><div><h1>{title}</h1><p>{sub}</p></div>{children}</div>;
}

/* =====================================================================
   Requests: what people can ask for, and requests waiting on a manager
   ===================================================================== */
export function RequestsPage({ user }: { user: User }) {
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [waiting, setWaiting] = useState<Ticket[]>([]);
  const [editing, setEditing] = useState<CatalogItem | 'new' | null>(null);
  const toast = useToast();
  const load = useCallback(() => {
    api.catalog().then((r) => setItems(r.items)).catch(() => {});
    api.tickets('waiting').then((r) => setWaiting(r.tickets.filter((t) => t.approval === 'pending'))).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const admin = user.role === 'admin';
  return (
    <main className="page">
      <Header title="Requests" sub="Things people can ask for. They type what they need in their own words and Fixline opens the right form, filled in.">
        {admin && <button className="btn-accent" onClick={() => setEditing('new')}>+ New request type</button>}
      </Header>
      {waiting.length > 0 && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <h3>Waiting for a manager <span>the clock is paused until they decide</span></h3>
          {waiting.map((t) => (
            <a key={t.id} className="line" href={`#/q/waiting/${t.id}`}>
              <span className="mono dim">{t.key}</span><b>{t.subject}</b>
              <span className="dim">{t.requester.name} → {t.approver?.name ?? 'an admin'} · asked {ago(t.createdAt)}</span>
            </a>
          ))}
        </div>
      )}
      <div className="cards">
        {items?.map((i) => (
          <button key={i.id} className={`tile${i.active ? '' : ' off'}`} onClick={() => admin && setEditing(i)} disabled={!admin} style={{ cursor: admin ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}><span className="emoji">{i.icon}</span><b style={{ margin: 0 }}>{i.name}</b></div>
            <p>{i.description}</p>
            <div className="meta">
              <span className="tag">{i.category}</span>
              <span className={`tag ${i.needsApproval ? 'amb' : 'ok'}`}>{i.needsApproval ? 'manager approves' : 'no approval'}</span>
              <span>{i.fields.length} questions</span>
              {!i.active && <span style={{ marginLeft: 'auto' }}>hidden</span>}
            </div>
          </button>
        ))}
      </div>
      {editing && <CatalogDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); toast('Saved. Employees see it straight away.'); }} />}
    </main>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'q';

function CatalogDialog({ item, onClose, onSaved }: { item?: CatalogItem; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Omit<CatalogItem, 'id'>>(item ?? { name: '', description: '', icon: '📦', category: 'Software', keywords: '', fields: [{ key: 'what', label: 'What do you need?', type: 'text', required: true }], needsApproval: true, priority: 4, active: true });
  const [error, setError] = useState('');
  const set = (p: Partial<typeof d>) => setD({ ...d, ...p });
  const setField = (i: number, p: Partial<FormField>) => set({ fields: d.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  return (
    <Dialog title={item ? `Edit “${item.name}”` : 'New request type'} sub="Keep it to the few questions IT really needs answered." onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.saveCatalogItem({ ...d, fields: d.fields.map((f) => ({ ...f, key: f.key || slug(f.label) })) }, item?.id); onSaved(); } catch (err) { setError(errText(err, 'Could not save')); }
      }}>
        <div className="two-col" style={{ gridTemplateColumns: '70px 1fr' }}>
          <label className="fld">Icon<input value={d.icon} maxLength={4} onChange={(e) => set({ icon: e.target.value })} style={{ textAlign: 'center', fontSize: 18 }} /></label>
          <label className="fld">Name<input autoFocus value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. New software" /></label>
        </div>
        <label className="fld">One line for employees<input value={d.description} onChange={(e) => set({ description: e.target.value })} /></label>
        <label className="fld">Words people might use (comma separated)<input value={d.keywords} onChange={(e) => set({ keywords: e.target.value })} placeholder="install, licence, adobe" /></label>
        <div className="two-col">
          <label className="fld">Category<select value={d.category} onChange={(e) => set({ category: e.target.value as Category })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="fld">Priority<select value={d.priority} onChange={(e) => set({ priority: Number(e.target.value) as Priority })}>{([1, 2, 3, 4] as Priority[]).map((p) => <option key={p} value={p}>P{p} · {SLA[p].label}</option>)}</select></label>
        </div>
        <div>
          <div className="fld-h">Questions</div>
          {d.fields.map((f, i) => (
            <div className="qrow" key={i}>
              <input aria-label="Question" value={f.label} onChange={(e) => setField(i, { label: e.target.value, key: item ? f.key : slug(e.target.value) })} placeholder="Question" />
              <select aria-label="Answer type" value={f.type} onChange={(e) => setField(i, { type: e.target.value as FormField['type'] })}>
                <option value="text">Short answer</option><option value="textarea">Long answer</option><option value="select">Pick one</option><option value="date">Date</option>
              </select>
              <label className="check"><input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} />Required</label>
              <button type="button" className="icon-btn" aria-label="Remove question" onClick={() => set({ fields: d.fields.filter((_, j) => j !== i) })}>×</button>
              {f.type === 'select' && <input aria-label="Options" style={{ gridColumn: '1 / -1' }} value={(f.options ?? []).join(', ')} onChange={(e) => setField(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="Options, comma separated" />}
            </div>
          ))}
          {d.fields.length < 12 && <button type="button" className="b" onClick={() => set({ fields: [...d.fields, { key: '', label: '', type: 'text' }] })}>+ Add a question</button>}
        </div>
        <label className="check"><input type="checkbox" checked={d.needsApproval} onChange={(e) => set({ needsApproval: e.target.checked })} />The person’s manager approves it first (one tap from their email)</label>
        <label className="check"><input type="checkbox" checked={d.active} onChange={(e) => set({ active: e.target.checked })} />Show it to employees</label>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve">Save</button></div>
      </form>
    </Dialog>
  );
}

/* =====================================================================
   Devices: every laptop, PC and printer, with plain-language health
   ===================================================================== */
const STATUS_LABEL: Record<Asset['status'], string> = { in_use: 'In use', in_stock: 'In stock', repair: 'In repair', retired: 'Retired' };
const TYPES = ['laptop', 'desktop', 'monitor', 'phone', 'printer', 'dock', 'licence', 'server', 'other'];

export function AssetsPage({ id }: { id?: number }) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention' | Asset['status']>('all');
  const [editing, setEditing] = useState<Asset | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const toast = useToast();
  const load = useCallback(() => api.assets(q).then((r) => setAssets(r.assets)).catch(() => {}), [q]);
  useEffect(() => { const t = setTimeout(load, q ? 200 : 0); return () => clearTimeout(t); }, [load, q]);
  if (id) return <AssetDetail id={id} onChanged={load} />;
  const list = (assets ?? []).filter((a) => filter === 'all' || (filter === 'attention' ? a.health.length > 0 : a.status === filter));
  const attention = (assets ?? []).filter((a) => a.health.length);
  return (
    <main className="page">
      <Header title="Devices" sub="Every device, who has it, and what it’s telling you. Tickets link to the right device by themselves.">
        <button className="b" style={{ marginLeft: 'auto' }} onClick={() => setImporting(true)}>Import CSV</button>
        <button className="btn-accent" style={{ marginLeft: 0 }} onClick={() => setEditing('new')}>+ Add device</button>
      </Header>
      <div className="grid4">
        <div className="metric"><small>Devices</small><b>{assets?.filter((a) => a.status !== 'retired').length ?? '—'}</b></div>
        <div className="metric"><small>Need attention</small><b className={attention.length ? 'amb' : ''}>{attention.length}</b></div>
        <div className="metric"><small>In stock, ready to give out</small><b className="l">{assets?.filter((a) => a.status === 'in_stock').length ?? '—'}</b></div>
        <div className="metric"><small>In repair</small><b>{assets?.filter((a) => a.status === 'repair').length ?? '—'}</b></div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="search-row" style={{ padding: 0, width: 300 }}>
          <label className="sr-only" htmlFor="aq">Search devices</label>
          <input id="aq" placeholder="Tag, model, serial or person" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="filters" style={{ border: 0, padding: 0 }}>
          {(['all', 'attention', 'in_use', 'in_stock', 'repair', 'retired'] as const).map((f) => (
            <button key={f} className={`f${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'attention' ? `Needs attention · ${attention.length}` : STATUS_LABEL[f]}</button>
          ))}
        </div>
      </div>
      <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="t">
          <thead><tr><th>Tag</th><th>Device</th><th>Who has it</th><th>Status</th><th>Tickets · 30 days</th><th>What to know</th></tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id} className="click" onClick={() => { location.hash = `#/devices/${a.id}`; }}>
                <td><a className="mono" href={`#/devices/${a.id}`} onClick={(e) => e.stopPropagation()}>{a.tag}</a></td>
                <td><b style={{ fontWeight: 500 }}>{a.name}</b><div className="dim" style={{ fontSize: 12 }}>{a.model}</div></td>
                <td>{a.assignedTo ? <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Avatar person={a.assignedTo} size="sm" />{a.assignedTo.name}</span> : <span className="dim">{a.location || '—'}</span>}</td>
                <td><span className={`st ${a.status}`}>{STATUS_LABEL[a.status]}</span></td>
                <td className="mono">{a.ticketsLast30 || '—'}</td>
                <td>{a.health.length ? a.health.map((h) => <span key={h} className="warn">{h}</span>) : <span className="dim">All good</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {assets && list.length === 0 && <div className="empty"><b>No devices here</b>Add one, or import a spreadsheet.</div>}
      </div>
      {editing && <AssetDialog asset={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); toast('Device saved'); }} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={(added, updated) => { setImporting(false); load(); toast(`${added} added, ${updated} updated`); }} />}
    </main>
  );
}

function AssetDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const [d, setD] = useState<{ asset: Asset; tickets: Ticket[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  const load = useCallback(() => api.asset(id).then(setD).catch(() => {}), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <main className="page"><div className="empty">Loading…</div></main>;
  const a = d.asset;
  return (
    <main className="page">
      <div className="page-h"><a className="b" href="#/devices">← All devices</a><span className="tag">{a.type}</span><span className={`st ${a.status}`}>{STATUS_LABEL[a.status]}</span>
        <button className="b" style={{ marginLeft: 'auto' }} onClick={() => setEditing(true)}>Edit</button></div>
      <h1 className="big-h"><span className="mono dim" style={{ fontWeight: 500 }}>{a.tag}</span> {a.name}</h1>
      {a.health.length > 0 && (
        <div className="advice">
          <b>⚠ What this device is telling you</b>
          <ul>{a.health.map((h) => <li key={h}>{h}</li>)}</ul>
          {a.ticketsLast30 >= 3 && <p>Replacing it now usually costs less than the time lost to repeat tickets.</p>}
        </div>
      )}
      <div className="two" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
        <div className="panel">
          <h3>Details</h3>
          <div className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
            <span>Who has it</span><span className="val">{a.assignedTo ? <><Avatar person={a.assignedTo} size="sm" />{a.assignedTo.name}</> : '—'}</span>
            <span>Model</span><span className="val">{a.model || '—'}</span>
            <span>Serial</span><span className="val mono" style={{ fontSize: 12 }}>{a.serial || '—'}</span>
            <span>Location</span><span className="val">{a.location || '—'}</span>
            <span>Bought</span><span className="val">{a.purchasedOn ? dayOnly(a.purchasedOn) : '—'}</span>
            <span>Warranty until</span><span className="val">{a.warrantyUntil ? dayOnly(a.warrantyUntil) : '—'}</span>
          </div>
          {a.notes && <p style={{ marginTop: 12, color: 'var(--mu)', whiteSpace: 'pre-wrap' }}>{a.notes}</p>}
        </div>
        <div className="panel">
          <h3>Ticket history <span>{d.tickets.length} total · {a.ticketsLast30} in 30 days</span></h3>
          {d.tickets.length === 0 && <p className="dim">No tickets for this device yet.</p>}
          {d.tickets.map((t) => (
            <a key={t.id} className="line" href={`#/q/${t.status === 'solved' ? 'solved' : 'all'}/${t.id}`}>
              <span className="mono dim">{t.key}</span><b>{t.subject}</b><span className="dim">{t.status === 'solved' ? `fixed · ${t.resolution}` : 'open'} · {ago(t.createdAt)}</span>
            </a>
          ))}
        </div>
      </div>
      {editing && <AssetDialog asset={a} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onChanged(); toast('Device saved'); }} />}
    </main>
  );
}

function AssetDialog({ asset, onClose, onSaved }: { asset?: Asset; onClose: () => void; onSaved: () => void }) {
  const [people, setPeople] = useState<Agent[]>([]);
  const [d, setD] = useState<AssetDraft>(() => asset
    ? { tag: asset.tag, name: asset.name, type: asset.type, model: asset.model, serial: asset.serial, status: asset.status, assignedTo: asset.assignedTo?.id ?? null, location: asset.location, purchasedOn: asset.purchasedOn, warrantyUntil: asset.warrantyUntil, notes: asset.notes }
    : { tag: '', name: '', type: 'laptop', model: '', serial: '', status: 'in_stock', assignedTo: null, location: '', purchasedOn: null, warrantyUntil: null, notes: '' });
  const [error, setError] = useState('');
  useEffect(() => { loadPeople().then(setPeople).catch(() => {}); }, []);
  const set = (p: Partial<AssetDraft>) => setD({ ...d, ...p });
  return (
    <Dialog title={asset ? `Edit ${asset.tag}` : 'Add a device'} onClose={onClose}>
      <form className="form" onSubmit={async (e) => { e.preventDefault(); try { await api.saveAsset(d, asset?.id); onSaved(); } catch (err) { setError(errText(err, 'Could not save')); } }}>
        <div className="two-col">
          <label className="fld">Asset tag<input autoFocus className="mono" value={d.tag} onChange={(e) => set({ tag: e.target.value.toUpperCase() })} placeholder="LT-0400" /></label>
          <label className="fld">Type<select value={d.type} onChange={(e) => set({ type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        </div>
        <label className="fld">Name<input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Sara’s laptop" /></label>
        <div className="two-col">
          <label className="fld">Model<input value={d.model} onChange={(e) => set({ model: e.target.value })} /></label>
          <label className="fld">Serial number<input value={d.serial} onChange={(e) => set({ serial: e.target.value })} /></label>
        </div>
        <div className="two-col">
          <label className="fld">Status<select value={d.status} onChange={(e) => set({ status: e.target.value as Asset['status'] })}>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="fld">Who has it<select value={d.assignedTo ?? ''} onChange={(e) => set({ assignedTo: e.target.value ? Number(e.target.value) : null })}><option value="">Nobody</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        </div>
        <div className="two-col">
          <label className="fld">Bought<input type="date" value={d.purchasedOn ?? ''} onChange={(e) => set({ purchasedOn: e.target.value || null })} /></label>
          <label className="fld">Warranty until<input type="date" value={d.warrantyUntil ?? ''} onChange={(e) => set({ warrantyUntil: e.target.value || null })} /></label>
        </div>
        <label className="fld">Location<input value={d.location} onChange={(e) => set({ location: e.target.value })} /></label>
        <label className="fld">Notes<textarea value={d.notes} onChange={(e) => set({ notes: e.target.value })} style={{ minHeight: 60 }} /></label>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve">Save</button></div>
      </form>
    </Dialog>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (added: number, updated: number) => void }) {
  const [csv, setCsv] = useState('tag,name,type,model,serial,assigned_to_email,purchased_on,warranty_until\n');
  const [error, setError] = useState('');
  return (
    <Dialog title="Import devices" sub="Paste rows from a spreadsheet. Existing tags are updated; new ones are added. Dates as YYYY-MM-DD." onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        try { const r = await api.importAssets(csv); if (r.skipped.length) setError(`Skipped: ${r.skipped.join('; ')}`); onDone(r.imported, r.updated); } catch (err) { setError(errText(err, 'Could not import')); }
      }}>
        <label className="fld">CSV<textarea className="mono" style={{ minHeight: 200, fontSize: 12 }} value={csv} onChange={(e) => setCsv(e.target.value)} /></label>
        <label className="b" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>Choose a .csv file<input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} /></label>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve">Import</button></div>
      </form>
    </Dialog>
  );
}

/* =====================================================================
   Problems: the root causes behind repeat tickets, spotted for you
   ===================================================================== */
const PROBLEM_STATUS: Record<Problem['status'], string> = { investigating: 'Investigating', known_error: 'Workaround known', resolved: 'Fixed for good' };

export function ProblemsPage({ id }: { id?: number }) {
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [candidates, setCandidates] = useState<ProblemCandidate[]>([]);
  const [creating, setCreating] = useState<ProblemCandidate | 'blank' | null>(null);
  const toast = useToast();
  const load = useCallback(() => {
    api.problems().then((r) => setProblems(r.problems)).catch(() => {});
    api.problemCandidates().then((r) => setCandidates(r.candidates)).catch(() => {});
  }, []);
  useEffect(load, [load]);
  if (id) return <ProblemDetail id={id} onChanged={load} />;
  return (
    <main className="page">
      <Header title="Problems" sub="When the same thing keeps breaking, fix the cause once. Fixline watches new tickets and points out patterns for you.">
        <button className="btn-accent" onClick={() => setCreating('blank')}>+ New problem</button>
      </Header>
      {candidates.length > 0 && (
        <div className="spotted">
          <h3>✨ Spotted in the last 3 days</h3>
          {candidates.map((c) => (
            <div key={c.keys.join()} className="cand">
              <div>
                <b>{c.ticketIds.length} tickets look like the same problem: “{c.label}”</b>
                <div className="dim" style={{ fontSize: 12 }}>{c.keys.join(' · ')} · first one {ago(c.since)}</div>
              </div>
              <button className="b solve" onClick={() => setCreating(c)}>Group them as a problem</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gap: 10, maxWidth: 900 }}>
        {problems?.length === 0 && <div className="empty"><b>No problems yet</b>When Fixline spots repeat tickets, they show up above.</div>}
        {problems?.map((p) => (
          <a key={p.id} className="prob" href={`#/problems/${p.id}`}>
            <span className={`st ${p.status}`}>{PROBLEM_STATUS[p.status]}</span>
            <div style={{ minWidth: 0 }}>
              <b><span className="mono dim" style={{ fontWeight: 500 }}>{p.key}</span> {p.title}</b>
              <div className="dim" style={{ fontSize: 12 }}>{p.linked} linked tickets{p.openLinked ? ` · ${p.openLinked} still open` : ''} · {p.assignee ? `${p.assignee.name}` : 'nobody'} on it · {ago(p.createdAt)}</div>
              {p.workaround && <div className="wk">Workaround: {p.workaround}</div>}
            </div>
          </a>
        ))}
      </div>
      {creating && <NewProblemDialog candidate={creating === 'blank' ? undefined : creating} onClose={() => setCreating(null)} onDone={(newId) => { setCreating(null); toast('Problem created and tickets linked'); location.hash = `#/problems/${newId}`; }} />}
    </main>
  );
}

function NewProblemDialog({ candidate, onClose, onDone }: { candidate?: ProblemCandidate; onClose: () => void; onDone: (id: number) => void }) {
  const [title, setTitle] = useState(candidate?.label ?? '');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  return (
    <Dialog title="New problem" sub={candidate ? `${candidate.keys.join(', ')} will be linked to it.` : 'You can link tickets to it from each ticket.'} onClose={onClose}>
      <form className="form" onSubmit={async (e) => { e.preventDefault(); try { onDone((await api.createProblem({ title, description, ticketIds: candidate?.ticketIds ?? [] })).id); } catch (err) { setError(errText(err, 'Could not create')); } }}>
        <label className="fld">What keeps happening<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="fld">What you know so far<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve" disabled={title.trim().length < 3}>Create problem</button></div>
      </form>
    </Dialog>
  );
}

function ProblemDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const [d, setD] = useState<{ problem: Problem; tickets: Ticket[] } | null>(null);
  const [draft, setDraft] = useState({ rootCause: '', workaround: '' });
  const [people, setPeople] = useState<Agent[]>([]);
  const toast = useToast();
  const load = useCallback(() => api.problem(id).then((r) => { setD(r); setDraft({ rootCause: r.problem.rootCause, workaround: r.problem.workaround }); }).catch(() => {}), [id]);
  useEffect(() => { load(); loadPeople().then((p) => setPeople(p.filter((x) => x.role !== 'requester'))).catch(() => {}); }, [load]);
  if (!d) return <main className="page"><div className="empty">Loading…</div></main>;
  const p = d.problem;
  const save = async (b: Parameters<typeof api.updateProblem>[1], msg: string) => {
    try { await api.updateProblem(p.id, b); await load(); onChanged(); toast(msg); } catch (err) { toast(errText(err, 'Could not save')); }
  };
  const dirty = draft.rootCause !== p.rootCause || draft.workaround !== p.workaround;
  const openOnes = d.tickets.filter((t) => t.status !== 'solved').length;
  return (
    <main className="page">
      <div className="page-h"><a className="b" href="#/problems">← All problems</a><span className="mono dim">{p.key}</span>
        <select aria-label="Status" className="sel" value={p.status} onChange={(e) => save({ status: e.target.value as Problem['status'] }, e.target.value === 'resolved' ? 'Marked fixed for good' : 'Status updated')}>
          {Object.entries(PROBLEM_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="Owner" className="sel" value={p.assignee?.id ?? ''} onChange={(e) => save({ assigneeId: e.target.value ? Number(e.target.value) : null }, 'Owner changed')}>
          <option value="">Nobody</option>{people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </div>
      <h1 className="big-h">{p.title}</h1>
      {p.description && <p style={{ color: 'var(--mu)', maxWidth: 760, marginBottom: 16 }}>{p.description}</p>}
      <div className="two">
        <div className="panel">
          <h3>Cause and workaround</h3>
          <div className="form">
            <label className="fld">Root cause<textarea value={draft.rootCause} onChange={(e) => setDraft({ ...draft, rootCause: e.target.value })} placeholder="Why does it keep happening?" /></label>
            <label className="fld">Workaround people can use now<textarea value={draft.workaround} onChange={(e) => setDraft({ ...draft, workaround: e.target.value })} placeholder="Steps that get people working again" /></label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="b solve" disabled={!dirty} onClick={() => save(draft, 'Saved')}>Save</button>
              <button className="b" disabled={!p.workaround || dirty || !openOnes} title={!p.workaround ? 'Write and save the workaround first' : undefined}
                onClick={async () => { try { const r = await api.shareWorkaround(p.id); toast(`Workaround sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}`); load(); } catch (err) { toast(errText(err, 'Could not send')); } }}>
                ✉ Send the workaround to {openOnes} open {openOnes === 1 ? 'ticket' : 'tickets'}
              </button>
            </div>
          </div>
        </div>
        <div className="panel">
          <h3>Linked tickets <span>{d.tickets.length}</span></h3>
          {d.tickets.map((t) => (
            <a key={t.id} className="line" href={`#/q/${t.status === 'solved' ? 'solved' : 'all'}/${t.id}`}>
              <span className="mono dim">{t.key}</span><b>{t.subject}</b><span className="dim">{t.requester.name} · {t.status === 'solved' ? 'fixed' : 'open'}</span>
            </a>
          ))}
        </div>
      </div>
    </main>
  );
}

/* =====================================================================
   Changes: planned work, with risk worked out for you
   ===================================================================== */
const CHANGE_STATUS: Record<Change['status'], string> = { pending: 'Needs a decision', approved: 'Approved', rejected: 'Not approved', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function RiskMeter({ risk }: { risk: Change['risk'] }) {
  return (
    <div className={`risk ${risk.level}`}>
      <div className="risk-top"><b>{risk.level === 'low' ? 'Low risk' : risk.level === 'medium' ? 'Medium risk' : 'High risk'}</b><span className="mono">{risk.score}/100</span></div>
      <div className="risk-bar"><span style={{ width: `${Math.max(4, risk.score)}%` }} /></div>
      {risk.reasons.length ? <ul>{risk.reasons.map((r) => <li key={r.text}><span className="mono">+{r.points}</span>{r.text}</li>)}</ul> : <p>Nothing risky found. Low-risk changes are approved automatically.</p>}
    </div>
  );
}

export function ChangesPage({ user }: { user: User }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [completing, setCompleting] = useState<Change | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const toast = useToast();
  const load = useCallback(() => api.changes().then((r) => setChanges(r.changes)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const now = Date.now();
  const all = changes ?? [];
  const pending = all.filter((c) => c.status === 'pending');
  const upcoming = all.filter((c) => c.status === 'approved');
  const past = all.filter((c) => !['pending', 'approved'].includes(c.status)).reverse();
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i); return d; }), []);
  const decide = async (c: Change, decision: 'approve' | 'reject') => {
    try { await api.decideChange(c.id, decision); load(); toast(decision === 'approve' ? `${c.key} approved` : `${c.key} not approved`); } catch (err) { toast(errText(err, 'Could not decide')); }
  };
  const card = (c: Change) => {
    const started = Date.parse(c.plannedStart) <= now;
    return (
      <div key={c.id} className={`chg ${c.risk.level}`}>
        <button className="chg-h" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
          <span className={`riskdot ${c.risk.level}`} title={`${c.risk.level} risk`} />
          <span style={{ minWidth: 0, textAlign: 'left' }}>
            <b><span className="mono dim" style={{ fontWeight: 500 }}>{c.key}</span> {c.title}</b>
            <span className="dim" style={{ display: 'block', fontSize: 12 }}>{when(c.plannedStart)} → {new Date(c.plannedEnd).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {c.affects || 'no service named'} · by {c.requestedBy?.name ?? '—'}</span>
          </span>
          <span className={`st ${c.status}`}>{CHANGE_STATUS[c.status]}</span>
        </button>
        {c.clashes.length > 0 && <div className="clash">⚠ Overlaps {c.clashes.map((x) => `${x.key} ${x.title}`).join(', ')}</div>}
        {open === c.id && (
          <div className="chg-b">
            <RiskMeter risk={c.risk} />
            <div>
              {c.plan && <><h5>Plan</h5><p>{c.plan}</p></>}
              <h5>If it goes wrong</h5><p className={c.rollback ? '' : 'err'}>{c.rollback || 'No way back written down.'}</p>
              {c.outcome && <><h5>Outcome</h5><p>{c.outcome}</p></>}
              {c.approvedBy && <p className="dim" style={{ fontSize: 12 }}>{c.status === 'rejected' ? 'Declined' : 'Approved'} by {c.approvedBy.name}</p>}
            </div>
          </div>
        )}
        {(c.status === 'pending' && user.role === 'admin') || (c.status === 'approved' && started) ? (
          <div className="chg-a">
            {c.status === 'pending' && <><button className="b solve" onClick={() => decide(c, 'approve')}>Approve</button><button className="b danger" onClick={() => decide(c, 'reject')}>Don’t approve</button></>}
            {c.status === 'approved' && started && <button className="b solve" onClick={() => setCompleting(c)}>How did it go?</button>}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <main className="page">
      <Header title="Changes" sub="Plan work on systems people rely on. Fixline scores the risk as you type, warns about clashes, and approves low-risk changes by itself.">
        <button className="btn-accent" onClick={() => setCreating(true)}>+ Plan a change</button>
      </Header>
      <div className="panel cal" style={{ marginBottom: 14 }}>
        <h3>Next 14 days <span>employees see approved work a day before, as a banner</span></h3>
        <div className="cal-grid">
          {days.map((d) => {
            const end = d.getTime() + 86_400_000;
            const here = all.filter((c) => ['pending', 'approved'].includes(c.status) && Date.parse(c.plannedStart) < end && Date.parse(c.plannedEnd) > d.getTime());
            return (
              <div key={d.toISOString()} className={`cal-d${d.getDay() === 0 || d.getDay() === 6 ? ' we' : ''}`}>
                <small>{d.toLocaleDateString([], { weekday: 'short' })} <b>{d.getDate()}</b></small>
                {here.map((c) => <button key={c.id} className={`cal-c ${c.risk.level}${c.status === 'pending' ? ' tbc' : ''}`} title={`${c.key} ${c.title}`} onClick={() => setOpen(c.id)}>{c.key}</button>)}
              </div>
            );
          })}
        </div>
      </div>
      {changes === null && <div className="empty">Loading…</div>}
      {pending.length > 0 && <><div className="grp" style={{ paddingLeft: 0 }}>Needs a decision · {pending.length}</div><div className="chgs">{pending.map(card)}</div></>}
      {upcoming.length > 0 && <><div className="grp" style={{ paddingLeft: 0 }}>Approved</div><div className="chgs">{upcoming.map(card)}</div></>}
      {past.length > 0 && <><div className="grp" style={{ paddingLeft: 0 }}>History</div><div className="chgs">{past.map(card)}</div></>}
      {creating && <ChangeDialog onClose={() => setCreating(false)} onDone={(status) => { setCreating(false); load(); toast(status === 'approved' ? 'Low risk, so it’s approved already' : 'Sent for approval'); }} />}
      {completing && <CompleteDialog change={completing} onClose={() => setCompleting(null)} onDone={() => { setCompleting(null); load(); toast('Recorded'); }} />}
    </main>
  );
}

function ChangeDialog({ onClose, onDone }: { onClose: () => void; onDone: (status: Change['status']) => void }) {
  const start0 = new Date(Date.now() + 3 * 86_400_000); start0.setHours(19, 0, 0, 0);
  const [d, setD] = useState({ title: '', affects: '', plan: '', rollback: '', start: localInput(start0), end: localInput(new Date(start0.getTime() + 3_600_000)) });
  const [risk, setRisk] = useState<Change['risk'] | null>(null);
  const [error, setError] = useState('');
  const draft = (): ChangeDraft => ({ title: d.title, affects: d.affects, plan: d.plan, rollback: d.rollback, plannedStart: new Date(d.start).toISOString(), plannedEnd: new Date(d.end).toISOString() });
  // Live risk: recalculated a moment after each change to the form.
  useEffect(() => {
    if (d.title.trim().length < 3 || !d.start || !d.end) { setRisk(null); return; }
    const t = setTimeout(() => api.changeRisk(draft()).then((r) => setRisk(r.risk)).catch(() => setRisk(null)), 300);
    return () => clearTimeout(t);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<typeof d>) => setD({ ...d, ...p });
  return (
    <Dialog title="Plan a change" sub="No questionnaire. Describe it and the risk is worked out as you type." onClose={onClose}>
      <form className="form" onSubmit={async (e) => { e.preventDefault(); try { onDone((await api.createChange(draft())).status); } catch (err) { setError(errText(err, 'Could not save')); } }}>
        <label className="fld">What’s changing<input autoFocus value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Update the firewall firmware" /></label>
        <label className="fld">What it affects<input value={d.affects} onChange={(e) => set({ affects: e.target.value })} placeholder="e.g. Internet at Plant 1" /></label>
        <div className="two-col">
          <label className="fld">Starts<input type="datetime-local" value={d.start} onChange={(e) => set({ start: e.target.value })} /></label>
          <label className="fld">Ends<input type="datetime-local" value={d.end} onChange={(e) => set({ end: e.target.value })} /></label>
        </div>
        <label className="fld">Steps<textarea value={d.plan} onChange={(e) => set({ plan: e.target.value })} style={{ minHeight: 70 }} /></label>
        <label className="fld">How to undo it if it goes wrong<textarea value={d.rollback} onChange={(e) => set({ rollback: e.target.value })} style={{ minHeight: 60 }} /></label>
        {risk && <RiskMeter risk={risk} />}
        {error && <p className="err" role="alert">{error}</p>}
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve" disabled={d.title.trim().length < 3}>{risk?.level === 'low' ? 'Save (auto-approved)' : 'Send for approval'}</button></div>
      </form>
    </Dialog>
  );
}

function CompleteDialog({ change, onClose, onDone }: { change: Change; onClose: () => void; onDone: () => void }) {
  const [result, setResult] = useState<'done' | 'failed' | 'cancelled'>('done');
  const [outcome, setOutcome] = useState('');
  return (
    <Dialog title={`How did ${change.key} go?`} sub="Failed changes make similar ones score higher next time." onClose={onClose}>
      <form className="form" onSubmit={async (e) => { e.preventDefault(); await api.completeChange(change.id, result, outcome); onDone(); }}>
        <div className="seg">{(['done', 'failed', 'cancelled'] as const).map((r) => <button type="button" key={r} className={result === r ? 'on' : ''} onClick={() => setResult(r)}>{CHANGE_STATUS[r]}</button>)}</div>
        <label className="fld">What happened<textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} /></label>
        <div className="dlg-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve">Save</button></div>
      </form>
    </Dialog>
  );
}

/* =====================================================================
   Automation: rules written as sentences, tested before they go live
   ===================================================================== */
const FIELD_LABEL: Record<RuleField, string> = { text: 'the words', category: 'the category', priority: 'the priority', channel: 'it came in by', kind: 'it is a', department: 'the person’s team' };
const OP_LABEL = { is: 'is', is_not: 'is not', contains: 'contain' } as const;

function describeCondition(c: RuleCondition) {
  if (c.field === 'text') return <>the ticket {c.op === 'is_not' ? 'doesn’t mention' : 'mentions'} <b>{c.value.split(/\s*,\s*/).join(' or ')}</b></>;
  if (c.field === 'priority') return <>the priority {OP_LABEL[c.op]} <b>P{c.value.replace(/^p/i, '')}</b></>;
  if (c.field === 'kind') return <>it {c.op === 'is_not' ? 'isn’t' : 'is'} <b>{c.value === 'request' ? 'a request' : 'a problem report'}</b></>;
  if (c.field === 'channel') return <>it came in {c.op === 'is_not' ? 'not ' : ''}by <b>{c.value}</b></>;
  return <>{FIELD_LABEL[c.field]} {OP_LABEL[c.op]} <b>{c.value}</b></>;
}
function describeAction(a: RuleAction, people: Agent[], problems: Problem[]) {
  switch (a.type) {
    case 'assign': return <>assign it to <b>{people.find((p) => p.id === a.userId)?.name ?? 'someone'}</b></>;
    case 'priority': return <>make it <b>P{a.value} · {SLA[a.value].label}</b></>;
    case 'category': return <>file it under <b>{a.value}</b></>;
    case 'note': return <>add the note <b>“{a.text.replace(/[.!?]+$/, '')}”</b></>;
    case 'alert_agents': return <>email <b>the whole IT team</b></>;
    case 'link_problem': return <>link it to <b>{problems.find((p) => p.id === a.problemId)?.key ?? 'a problem'}</b></>;
  }
}

export function AutomationPage({ user }: { user: User }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [people, setPeople] = useState<Agent[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const toast = useToast();
  const load = useCallback(() => api.rules().then((r) => setRules(r.rules)).catch(() => {}), []);
  useEffect(() => { load(); loadPeople().then((p) => setPeople(p.filter((x) => x.role !== 'requester'))).catch(() => {}); api.problems().then((r) => setProblems(r.problems)).catch(() => {}); }, [load]);
  const admin = user.role === 'admin';
  return (
    <main className="page">
      <Header title="Automation" sub="Rules run on every new ticket, in order. Write them like sentences and test them on last month’s tickets before switching them on.">
        {admin && <button className="btn-accent" onClick={() => setEditing('new')}>+ New rule</button>}
      </Header>
      <div style={{ display: 'grid', gap: 10, maxWidth: 900 }}>
        {rules?.length === 0 && <div className="empty"><b>No rules yet</b>For example: when the ticket mentions “payroll”, make it urgent and assign it to Ana.</div>}
        {rules?.map((r) => (
          <div key={r.id} className={`rule${r.enabled ? '' : ' off'}`}>
            <div style={{ minWidth: 0 }}>
              <b>{r.name}</b>
              <p className="sentence">
                <span className="kw">When</span> {r.conditions.map((c, i) => <span key={i}>{i > 0 && <span className="kw"> and </span>}{describeCondition(c)}</span>)}
                <span className="kw">, then</span> {r.actions.map((a, i) => <span key={i}>{i > 0 && (i === r.actions.length - 1 ? ' and ' : ', ')}{describeAction(a, people, problems)}</span>)}.
              </p>
              <small className="dim">Ran {r.runs} {r.runs === 1 ? 'time' : 'times'}{r.lastRunAt ? ` · last ${ago(r.lastRunAt)}` : ''}</small>
            </div>
            {admin && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <label className="toggle" title={r.enabled ? 'On' : 'Off'}>
                  <input type="checkbox" checked={r.enabled} aria-label={`${r.name} is ${r.enabled ? 'on' : 'off'}`} onChange={async () => { await api.saveRule({ ...r, enabled: !r.enabled }, r.id); load(); toast(r.enabled ? 'Rule off' : 'Rule on'); }} /><span />
                </label>
                <button className="b" onClick={() => setEditing(r)}>Edit</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {editing && <RuleDialog rule={editing === 'new' ? undefined : editing} people={people} problems={problems} onClose={() => setEditing(null)} onSaved={(msg) => { setEditing(null); load(); toast(msg); }} />}
    </main>
  );
}

function RuleDialog({ rule, people, problems, onClose, onSaved }: { rule?: Rule; people: Agent[]; problems: Problem[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(rule?.name ?? '');
  const [conditions, setConditions] = useState<RuleCondition[]>(rule?.conditions ?? [{ field: 'text', op: 'contains', value: '' }]);
  const [actions, setActions] = useState<RuleAction[]>(rule?.actions ?? [{ type: 'assign', userId: people[0]?.id ?? 0 }]);
  const [test, setTest] = useState<Awaited<ReturnType<typeof api.testRule>> | null>(null);
  const [error, setError] = useState('');
  const setC = (i: number, p: Partial<RuleCondition>) => { setTest(null); setConditions(conditions.map((c, j) => (j === i ? { ...c, ...p } : c))); };
  const setA = (i: number, a: RuleAction) => setActions(actions.map((x, j) => (j === i ? a : x)));
  const blankAction = (type: RuleAction['type']): RuleAction => {
    switch (type) {
      case 'assign': return { type, userId: people[0]?.id ?? 0 };
      case 'priority': return { type, value: 1 };
      case 'category': return { type, value: 'Hardware' };
      case 'note': return { type, text: '' };
      case 'alert_agents': return { type };
      case 'link_problem': return { type, problemId: problems[0]?.id ?? 0 };
    }
  };
  return (
    <Dialog title={rule ? 'Edit rule' : 'New rule'} sub="Fixline reads it back as a sentence, so you can check it says what you mean." onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.saveRule({ name, enabled: rule?.enabled ?? true, conditions, actions }, rule?.id); onSaved(rule ? 'Rule saved' : 'Rule on. It runs on the next new ticket.'); } catch (err) { setError(errText(err, 'Could not save')); }
      }}>
        <label className="fld">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Payroll problems are urgent" /></label>
        <div>
          <div className="fld-h">When</div>
          {conditions.map((c, i) => (
            <div className="qrow" key={i}>
              <select aria-label="Field" value={c.field} onChange={(e) => setC(i, { field: e.target.value as RuleField, op: e.target.value === 'text' ? 'contains' : 'is' })}>
                <option value="text">the ticket mentions</option><option value="category">the category</option><option value="priority">the priority</option>
                <option value="department">the person’s team</option><option value="kind">it is a</option><option value="channel">it came in by</option>
              </select>
              {c.field === 'text'
                ? <select aria-label="Match" value={c.op === 'is_not' ? 'is_not' : 'contains'} onChange={(e) => setC(i, { op: e.target.value as RuleCondition['op'] })}><option value="contains">any of</option><option value="is_not">none of</option></select>
                : <select aria-label="Match" value={c.op} onChange={(e) => setC(i, { op: e.target.value as RuleCondition['op'] })}><option value="is">is</option><option value="is_not">is not</option>{c.field === 'department' && <option value="contains">contains</option>}</select>}
              {c.field === 'category' ? <select aria-label="Value" value={c.value} onChange={(e) => setC(i, { value: e.target.value })}><option value="">Pick…</option>{CATEGORIES.map((x) => <option key={x}>{x}</option>)}</select>
                : c.field === 'priority' ? <select aria-label="Value" value={c.value} onChange={(e) => setC(i, { value: e.target.value })}><option value="">Pick…</option>{[1, 2, 3, 4].map((p) => <option key={p} value={String(p)}>P{p}</option>)}</select>
                : c.field === 'kind' ? <select aria-label="Value" value={c.value} onChange={(e) => setC(i, { value: e.target.value })}><option value="">Pick…</option><option value="incident">problem report</option><option value="request">request</option></select>
                : c.field === 'channel' ? <select aria-label="Value" value={c.value} onChange={(e) => setC(i, { value: e.target.value })}><option value="">Pick…</option><option value="portal">portal</option><option value="email">email</option><option value="phone">phone</option></select>
                : <input aria-label="Value" value={c.value} onChange={(e) => setC(i, { value: e.target.value })} placeholder={c.field === 'text' ? 'words, comma separated' : 'e.g. Finance'} />}
              <button type="button" className="icon-btn" aria-label="Remove" disabled={conditions.length === 1} onClick={() => setConditions(conditions.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" className="b" onClick={() => setConditions([...conditions, { field: 'category', op: 'is', value: '' }])}>+ and…</button>
        </div>
        <div>
          <div className="fld-h">Then</div>
          {actions.map((a, i) => (
            <div className="qrow" key={i}>
              <select aria-label="Action" value={a.type} onChange={(e) => setA(i, blankAction(e.target.value as RuleAction['type']))}>
                <option value="assign">assign it to</option><option value="priority">set the priority to</option><option value="category">set the category to</option>
                <option value="note">add an internal note</option><option value="alert_agents">email the whole IT team</option><option value="link_problem">link it to a problem</option>
              </select>
              {a.type === 'assign' && <select aria-label="Person" value={a.userId} onChange={(e) => setA(i, { ...a, userId: Number(e.target.value) })}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
              {a.type === 'priority' && <select aria-label="Priority" value={a.value} onChange={(e) => setA(i, { ...a, value: Number(e.target.value) as Priority })}>{([1, 2, 3, 4] as Priority[]).map((p) => <option key={p} value={p}>P{p} · {SLA[p].label}</option>)}</select>}
              {a.type === 'category' && <select aria-label="Category" value={a.value} onChange={(e) => setA(i, { ...a, value: e.target.value as Category })}>{CATEGORIES.map((x) => <option key={x}>{x}</option>)}</select>}
              {a.type === 'note' && <input aria-label="Note" value={a.text} onChange={(e) => setA(i, { ...a, text: e.target.value })} placeholder="What should the agent know?" />}
              {a.type === 'link_problem' && <select aria-label="Problem" value={a.problemId} onChange={(e) => setA(i, { ...a, problemId: Number(e.target.value) })}>{problems.map((p) => <option key={p.id} value={p.id}>{p.key} {p.title}</option>)}</select>}
              {a.type === 'alert_agents' && <span />}
              <span />
              <button type="button" className="icon-btn" aria-label="Remove" disabled={actions.length === 1} onClick={() => setActions(actions.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" className="b" onClick={() => setActions([...actions, blankAction('note')])}>+ and also…</button>
        </div>
        <div className="testbox">
          <button type="button" className="b" disabled={conditions.some((c) => !c.value.trim())} onClick={async () => { try { setTest(await api.testRule(conditions)); } catch (err) { setError(errText(err, 'Could not test')); } }}>▶ Test on last month’s tickets</button>
          {test && (
            <div aria-live="polite">
              <b>{test.matched} of {test.checked}</b> tickets from the last 30 days would have matched.
              {test.examples.length > 0 && <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{test.examples.map((x) => `${x.key} ${x.subject}`).join(' · ')}</div>}
              {test.matched === 0 && <div className="dim" style={{ fontSize: 12 }}>Nothing matched. Check the spelling, or it may just be rare.</div>}
            </div>
          )}
        </div>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="dlg-foot">
          {rule && <button type="button" className="b danger" style={{ marginRight: 'auto' }} onClick={async () => { await api.deleteRule(rule.id); onSaved('Rule deleted'); }}>Delete</button>}
          <button type="button" className="b" onClick={onClose}>Cancel</button><button className="b solve" disabled={name.trim().length < 2}>Save rule</button>
        </div>
      </form>
    </Dialog>
  );
}

/* =====================================================================
   Audit log: who did what, in plain words
   ===================================================================== */
const ACTION_TEXT: Record<string, string> = {
  sign_in: 'signed in', 'sign_in.failed': 'failed to sign in', 'sign_in.code_wrong': 'entered a wrong sign-in code',
  'security.2fa_on': 'turned on two-step sign-in', 'security.2fa_off': 'turned off two-step sign-in', 'security.password_reset': 'reset their password',
  'person.role_changed': 'changed the role of', 'person.manager_changed': 'changed the manager of',
  'settings.updated': 'changed desk settings', 'ticket.resolved': 'resolved',
  'request.approved': 'approved request', 'request.declined': 'declined request',
  'change.created': 'planned change', 'change.approved': 'approved change', 'change.rejected': 'didn’t approve change', 'change.done': 'completed change', 'change.failed': 'reported a failed change', 'change.cancelled': 'cancelled change',
  'rule.created': 'created the rule', 'rule.updated': 'changed the rule', 'rule.deleted': 'deleted the rule',
  'asset.created': 'added device', 'asset.updated': 'updated device', 'asset.imported': 'imported devices',
  'problem.created': 'opened problem', 'problem.status': 'changed the status of', 'problem.updated': 'updated problem', 'problem.workaround_shared': 'shared the workaround for',
  'catalog.created': 'added the request type', 'catalog.updated': 'changed the request type',
};

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => api.audit(q).then((r) => setEntries(r.entries)).catch(() => {}), q ? 250 : 0); return () => clearTimeout(t); }, [q]);
  return (
    <main className="page">
      <Header title="Audit log" sub="Every sign-in, approval and setting change, in plain words. Fixline has no way to edit or delete an entry.">
        <a className="b" style={{ marginLeft: 'auto' }} href="/api/audit.csv" download>Download CSV</a>
      </Header>
      <div className="search-row" style={{ padding: '0 0 14px', maxWidth: 420 }}>
        <label className="sr-only" htmlFor="audq">Search the log</label>
        <input id="audq" placeholder="Search by person, action or item" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="panel" style={{ padding: '4px 18px' }}>
        {entries?.length === 0 && <div className="empty"><b>Nothing found</b></div>}
        {entries?.map((e) => (
          <div key={e.id} className={`aud${e.action.includes('failed') || e.action.includes('wrong') ? ' bad' : ''}`}>
            <Avatar person={e.actor ? { name: e.actor } : null} size="sm" />
            <span><b>{e.actor ?? 'Someone'}</b> {ACTION_TEXT[e.action] ?? e.action.replace(/[._]/g, ' ')}{e.target && <> <b>{e.target}</b></>}{e.detail && <span className="dim"> · {e.detail}</span>}</span>
            <span className="dim mono" title={new Date(e.createdAt).toLocaleString()}>{ago(e.createdAt)}{e.ip ? ` · ${e.ip}` : ''}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
