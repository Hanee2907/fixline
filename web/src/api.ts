import type {
  Article, Category, Incident, Kpis, LiveEvent, Macro, Message, Person, Priority, Reports, Suggestion, Ticket, User,
} from '../../shared/types';

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

export type View = 'all' | 'mine' | 'unassigned' | 'breaching' | 'waiting' | 'solved' | `incident:${number}`;
export interface TicketDetail { ticket: Ticket; messages: Message[]; suggestions: Suggestion[] }

export const api = {
  me: () => call<{ user: User | null }>('GET', '/api/auth/me'),
  login: (b: { email: string; password: string }) => call<{ user: User }>('POST', '/api/auth/login', b),
  signup: (b: { name: string; email: string; password: string; workspaceName?: string; joinCode?: string }) => call<{ user: User }>('POST', '/api/auth/signup', b),
  demo: (as: 'agent' | 'requester') => call<{ user: User }>('POST', '/api/auth/demo', { as }),
  switchDemo: () => call<{ user: User }>('POST', '/api/demo/switch', {}),
  logout: () => call('POST', '/api/auth/logout', {}),

  tickets: (view: View = 'all', q = '') => call<{ tickets: Ticket[] }>('GET', `/api/tickets?view=${encodeURIComponent(view)}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  ticket: (id: number) => call<TicketDetail>('GET', `/api/tickets/${id}`),
  create: (b: { subject: string; description?: string; category?: Category; priority?: Priority; device?: string; location?: string; requesterId?: number; channel?: string }) =>
    call<{ ticket: Ticket }>('POST', '/api/tickets', b),
  update: (id: number, b: Partial<{ status: 'new' | 'open' | 'waiting'; waitingReason: string; priority: Priority; category: Category; assigneeId: number | null; incidentId: number | null }>) =>
    call<{ ticket: Ticket }>('PATCH', `/api/tickets/${id}`, b),
  message: (id: number, b: { kind: 'reply' | 'note'; body: string; articleId?: number }) => call<{ ticket: Ticket; messages: Message[] }>('POST', `/api/tickets/${id}/messages`, b),
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

  people: () => call<{ people: (Person & { open: number })[] }>('GET', '/api/people'),
  setRole: (id: number, role: Person['role']) => call('PATCH', `/api/people/${id}`, { role }),
  workspace: () => call<{ name: string; joinCode: string | null }>('GET', '/api/workspace'),
  kpis: () => call<{ kpis: Kpis }>('GET', '/api/kpis'),
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
