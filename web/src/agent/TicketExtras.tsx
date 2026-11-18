import { useEffect, useState } from 'react';
import type { Asset, Problem, Ticket } from '../../../shared/types';
import { ApiError, api } from '../api';
import { useToast } from '../ui';

let assetCache: Promise<Asset[]> | null = null;
let problemCache: Promise<Problem[]> | null = null;
let aiCache: Promise<boolean> | null = null;
const loadAssets = () => (assetCache ??= api.assets().then((r) => r.assets));
const loadProblems = () => (problemCache ??= api.problems().then((r) => r.problems));
const loadAi = () => (aiCache ??= api.aiStatus().then((r) => r.enabled).catch(() => false));
/** Lists change rarely; refresh them after a link so other tickets see new counts. */
const refresh = () => { assetCache = null; problemCache = null; };

/** Answers to a request form, and where the approval stands. */
export function RequestCard({ t }: { t: Ticket }) {
  if (t.kind !== 'request') return null;
  return (
    <div className="reqcard">
      <small>📋 Request{t.approval ? ` · ${t.approval === 'pending' ? `waiting for ${t.approver?.name ?? 'a manager'} to approve` : t.approval === 'approved' ? `approved by ${t.approver?.name ?? 'manager'}` : `declined by ${t.approver?.name ?? 'manager'}`}` : ' · no approval needed'}</small>
      {Object.keys(t.form).length > 0 && <div className="answers compact">{Object.entries(t.form).filter(([, v]) => v).map(([k, v]) => <div key={k}><small>{k}</small><span>{v}</span></div>)}</div>}
    </div>
  );
}

/** Device, problem and AI help in the ticket's side panel. */
export function TicketSide({ t, onChanged, onDraft }: { t: Ticket; onChanged: () => void; onDraft: (text: string) => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [ai, setAi] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'summary' | 'draft'>('');
  const toast = useToast();
  useEffect(() => {
    loadAssets().then(setAssets).catch(() => {});
    loadProblems().then(setProblems).catch(() => {});
    loadAi().then(setAi);
  }, [t.id]);
  const asset = assets.find((a) => a.id === t.assetId);
  const problem = problems.find((p) => p.id === t.problemId);
  const link = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); refresh(); onChanged(); loadAssets().then(setAssets); loadProblems().then(setProblems); toast(msg); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not link'); }
  };
  const solved = t.status === 'solved';
  const mine = assets.filter((a) => a.assignedTo?.id === t.requester.id);
  const others = assets.filter((a) => a.assignedTo?.id !== t.requester.id && a.status !== 'retired');

  return (
    <>
      <div>
        <h5>Device</h5>
        <div className="kv">
          <label htmlFor="f-asset">Linked</label>
          <select id="f-asset" value={t.assetId ?? ''} disabled={solved} onChange={(e) => link(() => api.linkAsset(t.id, e.target.value ? Number(e.target.value) : null), e.target.value ? 'Device linked' : 'Device unlinked')}>
            <option value="">None</option>
            {mine.length > 0 && <optgroup label={`${t.requester.name.split(' ')[0]}’s`}>{mine.map((a) => <option key={a.id} value={a.id}>{a.tag} · {a.model || a.type}</option>)}</optgroup>}
            <optgroup label="Others">{others.map((a) => <option key={a.id} value={a.id}>{a.tag} · {a.name}</option>)}</optgroup>
          </select>
        </div>
        {asset && (
          <a className={`devcard${asset.health.length ? ' warn' : ''}`} href={`#/devices/${asset.id}`}>
            <b className="mono">{asset.tag}</b> <span className="dim">{asset.model}</span>
            {asset.health.map((h) => <span key={h} className="hl">⚠ {h}</span>)}
            {!asset.health.length && <span className="dim" style={{ display: 'block', fontSize: 12 }}>{asset.ticketsLast30} tickets in 30 days · healthy</span>}
          </a>
        )}
      </div>

      <div>
        <h5>Problem</h5>
        <div className="kv">
          <label htmlFor="f-prob">Linked</label>
          <select id="f-prob" value={t.problemId ?? ''} onChange={(e) => link(() => api.linkProblem(t.id, e.target.value ? Number(e.target.value) : null), e.target.value ? 'Linked to the problem' : 'Unlinked')}>
            <option value="">None</option>
            {problems.filter((p) => p.status !== 'resolved' || p.id === t.problemId).map((p) => <option key={p.id} value={p.id}>{p.key} {p.title}</option>)}
          </select>
        </div>
        {problem && (
          <div className="probcard">
            <a href={`#/problems/${problem.id}`}><b>{problem.key}</b> · {problem.linked} tickets</a>
            {problem.workaround
              ? <><p>{problem.workaround}</p>{!solved && <button className="b" onClick={() => onDraft(`Hi ${t.requester.name.split(' ')[0]}, this is a known issue and here’s what fixes it for now:\n\n${problem.workaround}\n\nLet me know if that works!`)}>Use the workaround in a reply</button>}</>
              : <p className="dim">No workaround yet.</p>}
          </div>
        )}
      </div>

      {ai && (
        <div className="aibox">
          <h5>✨ Assistant</h5>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="b" disabled={!!busy} onClick={async () => {
              setBusy('summary');
              try { setSummary((await api.aiSummary(t.id)).summary); } catch (e) { toast(e instanceof ApiError ? e.message : 'The assistant couldn’t answer'); }
              setBusy('');
            }}>{busy === 'summary' ? 'Reading…' : 'Summarise'}</button>
            {!solved && <button className="b" disabled={!!busy} onClick={async () => {
              setBusy('draft');
              try { const r = await api.aiDraft(t.id); onDraft(r.draft); toast(r.guides.length ? `Draft written from “${r.guides[0].title}”. Check it before sending.` : 'Draft written. Check it before sending.'); } catch (e) { toast(e instanceof ApiError ? e.message : 'The assistant couldn’t answer'); }
              setBusy('');
            }}>{busy === 'draft' ? 'Writing…' : 'Draft a reply'}</button>}
          </div>
          {summary && <div className="aisum">{summary}</div>}
          <small className="dim">Uses only this ticket and your guides. Nothing is sent until you press Send.</small>
        </div>
      )}
    </>
  );
}
