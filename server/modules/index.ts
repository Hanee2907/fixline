import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { Hours } from '../../shared/hours.js';
import type { Category, LiveEvent, Ticket, User } from '../../shared/types.js';
import type { Env } from '../app.js';
import type { Bus } from '../bus.js';
import type { Db } from '../db.js';
import type { CheckedFile } from '../files.js';
import type { Mailer } from '../mail.js';
import type { Notifier } from '../notify.js';
import { ai } from './ai.js';
import { assets } from './assets.js';
import { changes } from './changes.js';
import { problems } from './problems.js';
import { requests } from './requests.js';
import { rules } from './rules.js';
import { security } from './security.js';
import { sso } from './sso.js';

type Mw = (c: Context<Env>, next: () => Promise<void>) => Promise<Response | void>;

/** What every feature module gets from the app: the database, the live bus, email, and shared helpers. */
export interface ModuleContext {
  db: Db;
  bus: Bus;
  mailer: Mailer;
  notify: Notifier;
  emit: (workspaceId: number, e: LiveEvent) => void;
  later: (job: Promise<unknown>) => void;
  audit: (c: Context, workspaceId: number, actorId: number | null, action: string, target?: string, detail?: string) => Promise<void>;
  appUrl: (c: Context) => string;
  body: (c: Context) => Promise<unknown>;
  firstError: (err: z.ZodError) => { error: string; field?: string };
  idOf: (c: Context) => number;
  isAgent: (u: User) => boolean;
  agentOnly: Mw;
  adminOnly: Mw;
  startSession: (c: Context, userId: number) => Promise<void>;
  createTicket: (c: Context, workspaceId: number, requesterId: number, actor: User | null, d: {
    subject: string; description: string; category?: Category; priority?: 1 | 2 | 3 | 4; device?: string; location?: string; channel: 'portal' | 'email' | 'phone';
  }, files: CheckedFile[]) => Promise<Ticket>;
  resumeSets: (t: Ticket, hours: Hours) => Promise<{ sql: string[]; params: unknown[] }>;
  hooks: { ticketCreated: ((workspaceId: number, ticketId: number) => Promise<void>)[] };
  rateLimit: (max: number, windowMs: number) => (key: string) => boolean;
  clientKey: (c: Context) => string;
}

export interface Module {
  /** routes that work without a session, e.g. one-click approval links from email */
  public?: (app: Hono<Env>, ctx: ModuleContext) => void;
  private: (app: Hono<Env>, ctx: ModuleContext) => void;
}

// Order matters for hooks on new tickets: link the device first, then run automation rules.
export const MODULES: Module[] = [requests, assets, problems, changes, rules, security, ai, sso];
