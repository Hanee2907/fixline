export const ROLES = ['requester', 'agent', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const STATUSES = ['new', 'open', 'waiting', 'solved'] as const;
export type Status = (typeof STATUSES)[number];

export const CATEGORIES = ['Access', 'Email', 'Hardware', 'Network', 'Printing', 'Software', 'Onboarding', 'Other'] as const;
export type Category = (typeof CATEGORIES)[number];

export type Priority = 1 | 2 | 3 | 4;

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  department: string;
  workspaceId: number;
  workspaceName: string;
  demo: boolean;
  hours: import('./hours.js').Hours;
}

export interface Person {
  id: number;
  name: string;
  email: string;
  role: Role;
  department: string;
}

export interface Ticket {
  id: number;
  key: string; // FX-1048
  subject: string;
  description: string;
  category: Category;
  priority: Priority;
  status: Status;
  waitingReason: string;
  requester: Person;
  assignee: Person | null;
  device: string;
  location: string;
  channel: 'portal' | 'email' | 'phone';
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  responseDueAt: string;
  dueAt: string;
  pausedAt: string | null;
  /** working time left on the fix clock when the ticket was paused */
  pausedRemaining: number | null;
  solvedAt: string | null;
  resolution: string;
  rating: 'good' | 'bad' | null;
  incidentId: number | null;
}

export interface Attachment {
  id: number;
  messageId: number | null;
  name: string;
  type: string;
  size: number;
  internal: boolean;
}

export interface Message {
  id: number;
  ticketId: number;
  kind: 'reply' | 'note' | 'event';
  body: string;
  author: Person | null;
  createdAt: string;
  via: 'web' | 'email';
  attachments: Attachment[];
}

/** A file on its way up: base64 data from the browser or an inbound email. */
export interface Upload {
  name: string;
  type: string;
  data: string;
}

export interface Email {
  id: number;
  to: string;
  subject: string;
  body: string;
  kind: string;
  ticketId: number | null;
  status: 'sent' | 'logged' | 'failed';
  createdAt: string;
}

export interface WorkspaceSettings {
  name: string;
  joinCode: string | null;
  inboundAddress: string | null;
  hours: import('./hours.js').Hours;
  emailDelivery: 'smtp' | 'log';
}

export interface Article {
  id: number;
  title: string;
  body: string;
  category: Category;
  uses: number;
  updatedAt: string;
}

export interface Suggestion {
  type: 'article' | 'ticket';
  id: number;
  title: string;
  detail: string;
  score: number;
}

export interface Macro {
  id: number;
  title: string;
  body: string;
}

export interface Incident {
  id: number;
  title: string;
  message: string;
  status: 'active' | 'resolved';
  createdAt: string;
  resolvedAt: string | null;
  linked: number;
}

export interface Kpis {
  open: number;
  dueSoon: number;
  breached: number;
  unassigned: number;
  mine: number;
  waiting: number;
  firstResponseMinutes: number | null;
  solvedToday: number;
  avgFixMinutes: number | null;
  satisfaction: number | null;
  ratings: number;
  onTimeRate: number | null;
  agentsOnline: number;
}

export interface Reports {
  volume: { day: string; created: number; solved: number }[];
  byCategory: { category: Category; count: number }[];
  byAgent: { name: string; solved: number; open: number; avgFixMinutes: number | null }[];
  onTimeRate: number | null;
  firstResponseMinutes: number | null;
  satisfaction: number | null;
  topArticles: { title: string; uses: number }[];
}

/** What travels over the live stream. Only ids, never ticket contents. */
export interface LiveEvent {
  type: 'ticket' | 'message' | 'incident' | 'presence' | 'article';
  ticketId?: number;
  requesterId?: number;
  actorId?: number;
}
