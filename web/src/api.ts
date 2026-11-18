import type {
  Article, Asset, Attachment, AuditEntry, CatalogItem, Category, Change, Email, Incident, Kpis, LiveEvent, Macro, Message, Person, Priority, Problem, ProblemCandidate,
  Reports, Rule, RuleAction, RuleCondition, Suggestion, Ticket, Upload, User, WorkspaceSettings,
} from '../../shared/types';
import type { Hours } from '../../shared/hours';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly field?: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'Something went wrong', res.status, data.field);
  return data as T;
}

/** Signing in either finishes, or asks for the code from an authenticator app. */
export interface SignIn { user?: User; twoFactor?: true; challenge?: string }
export interface ChangeDraft { title: string; description?: string; plan: string; rollback: string; affects: string; plannedStart: string; plannedEnd: string; problemId?: number | null }
export interface AssetDraft { tag: string; name: string; type: string; model: string; serial: string; status: Asset['status']; assignedTo: number | null; location: string; purchasedOn: string | null; warrantyUntil: string | null; notes: string }

export type View = 'all' | 'mine' | 'unassigned' | 'breaching' | 'waiting' | 'solved' | `incident:${number}`;
export interface TicketDetail { ticket: Ticket; messages: Message[]; attachments: Attachment[]; suggestions: Suggestion[] }

export const api = {
  me: () => call<{ user: User | null }>('GET', '/api/auth/me'),
  login: (b: { email: string; password: string }) => call<SignIn>('POST', '/api/auth/login', b),
  secondFactor: (challenge: string, code: string) => call<{ user: User }>('POST', '/api/auth/2fa', { challenge, code }),
  ssoProviders: () => call<{ providers: { id: string; name: string }[] }>('GET', '/api/sso/providers'),
  signup: (b: { name: string; email: string; password: string; workspaceName?: string; joinCode?: string }) => call<{ user: User }>('POST', '/api/auth/signup', b),
  demo: (as: 'agent' | 'requester') => call<{ user: User }>('POST', '/api/auth/demo', { as, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  forgot: (email: string) => call<{ message: string }>('POST', '/api/auth/forgot', { email }),
  reset: (token: string, password: string) => call<SignIn>('POST', '/api/auth/reset', { token, password }),
  switchDemo: () => call<{ user: User }>('POST', '/api/demo/switch', {}),
  logout: () => call('POST', '/api/auth/logout', {}),

  tickets: (view: View = 'all', q = '') => call<{ tickets: Ticket[] }>('GET', `/api/tickets?view=${encodeURIComponent(view)}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  ticket: (id: number) => call<TicketDetail>('GET', `/api/tickets/${id}`),
  create: (b: { subject: string; description?: string; category?: Category; priority?: Priority; device?: string; location?: string; requesterId?: number; channel?: string; attachments?: Upload[] }) =>
    call<{ ticket: Ticket }>('POST', '/api/tickets', b),
  update: (id: number, b: Partial<{ status: 'new' | 'open' | 'waiting'; waitingReason: string; priority: Priority; category: Category; assigneeId: number | null; incidentId: number | null }>) =>
    call<{ ticket: Ticket }>('PATCH', `/api/tickets/${id}`, b),
  message: (id: number, b: { kind: 'reply' | 'note'; body: string; articleId?: number; attachments?: Upload[] }) => call<{ ticket: Ticket; messages: Message[] }>('POST', `/api/tickets/${id}/messages`, b),
  resolve: (id: number, b: { resolution: string; notify?: boolean; saveArticle?: string }) => call<{ ticket: Ticket; articleId: number | null }>('POST', `/api/tickets/${id}/resolve`, b),
  reopen: (id: number) => call<{ ticket: Ticket }>('POST', `/api/tickets/${id}/reopen`, {}),
  rate: (id: number, rating: 'good' | 'bad', comment?: string) => call<{ ticket: Ticket }>('POST', `/api/tickets/${id}/rate`, { rating, comment }),

  suggest: (q: string) => call<{ suggestions: Suggestion[]; category: Category; priority: Priority }>('GET', `/api/suggest?q=${encodeURIComponent(q)}`),
  articles: (q = '') => call<{ articles: Article[] }>('GET', `/api/articles${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  article: (id: number) => call<{ article: Article }>('GET', `/api/articles/${id}`),
  helped: (id: number) => call('POST', `/api/articles/${id}/helped`, {}),
  saveArticle: (b: { title: string; body: string; category: Category }, id?: number) =>
    id ? call<{ article: Article }>('PUT', `/api/articles/${id}`, b) : call<{ article: Article }>('POST', '/api/articles', b),
  deleteArticle: (id: number) => call('DELETE', `/api/articles/${id}`),
  macros: () => call<{ macros: Macro[] }>('GET', '/api/macros'),

  incidents: () => call<{ incidents: Incident[] }>('GET', '/api/incidents'),
  createIncident: (b: { title: string; message: string; ticketIds?: number[] }) => call<{ id: number }>('POST', '/api/incidents', b),
  resolveIncident: (id: number, resolution: string) => call<{ solved: number }>('POST', `/api/incidents/${id}/resolve`, { resolution }),

  people: () => call<{ people: (Person & { open: number; managerId: number | null })[] }>('GET', '/api/people'),
  setManager: (id: number, managerId: number | null) => call('PATCH', `/api/people/${id}/manager`, { managerId }),
  setRole: (id: number, role: Person['role']) => call('PATCH', `/api/people/${id}`, { role }),
  settings: () => call<WorkspaceSettings>('GET', '/api/settings'),
  saveSettings: (b: { name?: string; hours?: Hours; ssoDomain?: string }) => call<{ user: User }>('PUT', '/api/settings', b),
  emails: () => call<{ emails: Email[] }>('GET', '/api/emails'),
  /** The same address an email provider would post to; used by the "send a test email" box. */
  inbound: (address: string, b: { from: string; subject: string; text: string }) => call<{ ticketId: number; action: string }>('POST', new URL(address).pathname, b),
  kpis: () => call<{ kpis: Kpis }>('GET', '/api/kpis'),

  // Requests and approvals
  catalog: () => call<{ items: CatalogItem[] }>('GET', '/api/catalog'),
  matchCatalog: (q: string) => call<{ matches: { item: CatalogItem; prefill: Record<string, string> }[] }>('GET', `/api/catalog/match?q=${encodeURIComponent(q)}`),
  saveCatalogItem: (b: Omit<CatalogItem, 'id'>, id?: number) => (id ? call<{ item: CatalogItem }>('PUT', `/api/catalog/${id}`, b) : call<{ item: CatalogItem }>('POST', '/api/catalog', b)),
  request: (b: { itemId: number; form: Record<string, string>; note?: string }) => call<{ ticket: Ticket }>('POST', '/api/requests', b),
  approvals: () => call<{ tickets: Ticket[] }>('GET', '/api/approvals'),
  decide: (id: number, decision: 'approve' | 'decline', comment = '') => call<{ ticket: Ticket }>('POST', `/api/approvals/${id}`, { decision, comment }),
  approvalLink: (token: string) => call<{ approver: string; ticket: { key: string; subject: string; requester: string; department: string; form: Record<string, string>; description: string; approval: Ticket['approval']; createdAt: string } }>('GET', `/api/approve/${encodeURIComponent(token)}`),
  decideLink: (token: string, decision: 'approve' | 'decline', comment = '') => call('POST', `/api/approve/${encodeURIComponent(token)}`, { decision, comment }),

  // Devices
  assets: (q = '') => call<{ assets: Asset[] }>('GET', `/api/assets${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  asset: (id: number) => call<{ asset: Asset; tickets: Ticket[] }>('GET', `/api/assets/${id}`),
  myAssets: () => call<{ assets: Asset[] }>('GET', '/api/my/assets'),
  saveAsset: (b: AssetDraft, id?: number) => (id ? call<{ asset: Asset }>('PUT', `/api/assets/${id}`, b) : call<{ asset: Asset }>('POST', '/api/assets', b)),
  importAssets: (csv: string) => call<{ imported: number; updated: number; skipped: string[] }>('POST', '/api/assets/import', { csv }),
  linkAsset: (ticketId: number, assetId: number | null) => call('PUT', `/api/tickets/${ticketId}/asset`, { assetId }),

  // Problems
  problems: () => call<{ problems: Problem[] }>('GET', '/api/problems'),
  problemCandidates: () => call<{ candidates: ProblemCandidate[] }>('GET', '/api/problems/candidates'),
  problem: (id: number) => call<{ problem: Problem; tickets: Ticket[] }>('GET', `/api/problems/${id}`),
  createProblem: (b: { title: string; description?: string; ticketIds?: number[] }) => call<{ id: number }>('POST', '/api/problems', b),
  updateProblem: (id: number, b: Partial<{ title: string; description: string; status: Problem['status']; rootCause: string; workaround: string; assigneeId: number | null }>) => call('PATCH', `/api/problems/${id}`, b),
  shareWorkaround: (id: number) => call<{ sent: number }>('POST', `/api/problems/${id}/share-workaround`, {}),
  linkProblem: (ticketId: number, problemId: number | null) => call('PUT', `/api/tickets/${ticketId}/problem`, { problemId }),

  // Changes
  changes: () => call<{ changes: Change[] }>('GET', '/api/changes'),
  maintenance: () => call<{ maintenance: { title: string; affects: string; start: string; end: string }[] }>('GET', '/api/maintenance'),
  changeRisk: (b: ChangeDraft) => call<{ risk: Change['risk'] }>('POST', '/api/changes/risk', b),
  createChange: (b: ChangeDraft) => call<{ id: number; status: Change['status']; risk: Change['risk'] }>('POST', '/api/changes', b),
  decideChange: (id: number, decision: 'approve' | 'reject') => call('POST', `/api/changes/${id}/decide`, { decision }),
  completeChange: (id: number, result: 'done' | 'failed' | 'cancelled', outcome: string) => call('POST', `/api/changes/${id}/complete`, { result, outcome }),

  // Automation
  rules: () => call<{ rules: Rule[] }>('GET', '/api/rules'),
  testRule: (conditions: RuleCondition[]) => call<{ checked: number; matched: number; examples: { id: number; key: string; subject: string }[] }>('POST', '/api/rules/test', { conditions }),
  saveRule: (b: { name: string; enabled: boolean; conditions: RuleCondition[]; actions: RuleAction[] }, id?: number) => (id ? call<{ rule: Rule }>('PUT', `/api/rules/${id}`, b) : call<{ rule: Rule }>('POST', '/api/rules', b)),
  deleteRule: (id: number) => call('DELETE', `/api/rules/${id}`),

  // Security
  audit: (q = '') => call<{ entries: AuditEntry[] }>('GET', `/api/audit${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  setup2fa: () => call<{ secret: string; uri: string; qr: string }>('POST', '/api/2fa/setup', {}),
  enable2fa: (code: string) => call<{ recoveryCodes: string[] }>('POST', '/api/2fa/enable', { code }),
  disable2fa: (password: string) => call('POST', '/api/2fa/disable', { password }),

  // AI assistant
  aiStatus: () => call<{ enabled: boolean }>('GET', '/api/ai/status'),
  aiSummary: (id: number) => call<{ summary: string }>('POST', `/api/ai/tickets/${id}/summary`, {}),
  aiDraft: (id: number, instruction = '') => call<{ draft: string; guides: { id: number; title: string }[] }>('POST', `/api/ai/tickets/${id}/draft`, { instruction }),
  aiAsk: (question: string) => call<{ answer: string | null; sources: { id: number; title: string }[]; suggestTicket: boolean }>('POST', '/api/ai/ask', { question }),
  reports: () => call<{ reports: Reports }>('GET', '/api/reports'),
};

/**
 * One live connection per tab (Server-Sent Events). The browser reconnects by itself if it drops;
 * after a reconnect we ask for a full refresh, in case we missed something while offline.
 */
export function connectLive(onEvent: (e: LiveEvent | { type: 'resync' }) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let first = true;
  let lastSeen = Date.now();
  let retry: ReturnType<typeof setTimeout> | null = null;
  const open = () => {
    es?.close();
    lastSeen = Date.now();
    es = new EventSource('/api/live');
    const seen = () => { lastSeen = Date.now(); };
    es.addEventListener('ready', () => {
      seen();
      // Once connected, refresh presence; after a reconnect, refresh everything we may have missed.
      onEvent(first ? { type: 'presence' } : { type: 'resync' });
      first = false;
    });
    es.addEventListener('ping', seen);
    es.addEventListener('change', (m) => {
      seen();
      try { onEvent(JSON.parse((m as MessageEvent).data)); } catch { /* ignore a bad frame */ }
    });
    es.onerror = () => {
      if (closed || retry) return;
      if (es?.readyState === EventSource.CLOSED) retry = setTimeout(() => { retry = null; if (!closed) open(); }, 2000);
    };
  };
  // Watchdog: the server pings every 15s. If the line goes quiet (a restart, a sleeping laptop,
  // a proxy that dropped us without saying), open a fresh connection and catch up.
  const watchdog = setInterval(() => { if (!closed && Date.now() - lastSeen > 40_000) open(); }, 10_000);
  const wake = () => { if (document.visibilityState === 'visible' && Date.now() - lastSeen > 20_000) open(); };
  document.addEventListener('visibilitychange', wake);
  open();
  return () => {
    closed = true;
    clearInterval(watchdog);
    if (retry) clearTimeout(retry);
    document.removeEventListener('visibilitychange', wake);
    es?.close();
  };
}
