import { ALWAYS_OPEN, addWorkingTime, clockAlwaysRuns, isOpen, workingTimeBetween, type Hours } from './hours.js';
import type { Priority, Ticket } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Time to first reply and time to fix, per priority. */
export const SLA: Record<Priority, { label: string; respond: number; resolve: number }> = {
  1: { label: 'Urgent', respond: 15 * MIN, resolve: 2 * HOUR },
  2: { label: 'High', respond: 30 * MIN, resolve: 4 * HOUR },
  3: { label: 'Normal', respond: 2 * HOUR, resolve: 8 * HOUR },
  4: { label: 'Low', respond: 8 * HOUR, resolve: 5 * 24 * HOUR },
};

/** Deadlines for a ticket that arrives at `from`, counting only working time. */
export function targetsFor(priority: Priority, from: Date, hours: Hours = ALWAYS_OPEN) {
  return {
    responseDueAt: new Date(addWorkingTime(from.getTime(), SLA[priority].respond, hours, priority)),
    dueAt: new Date(addWorkingTime(from.getTime(), SLA[priority].resolve, hours, priority)),
  };
}

export type Clock = 'respond' | 'resolve' | 'paused' | 'met' | 'missed';

export interface SlaState {
  clock: Clock;
  /** working milliseconds left until the active target; negative once it's missed */
  left: number;
  /** total length of the active target, for the progress bar */
  total: number;
  /** 0..1 of the target used up */
  used: number;
  tone: 'ok' | 'warn' | 'danger' | 'muted' | 'done';
  /** the desk is closed right now, so this clock isn't moving */
  afterHours: boolean;
}

type SlaTicket = Pick<Ticket, 'priority' | 'status' | 'createdAt' | 'firstResponseAt' | 'responseDueAt' | 'dueAt' | 'pausedAt' | 'solvedAt'> & { pausedRemaining?: number | null };

/**
 * Where a ticket stands against its targets right now, in working time.
 * Before anyone replies, the first-response clock runs; after that, the fix clock.
 * While a ticket waits on the user or a part, the clock is paused; outside working hours it stands still.
 */
export function slaState(t: SlaTicket, now = Date.now(), hours: Hours = ALWAYS_OPEN): SlaState {
  const p = t.priority;
  const created = Date.parse(t.createdAt);
  const between = (a: number, b: number) => workingTimeBetween(a, b, hours, p);
  if (t.status === 'solved') {
    const solved = Date.parse(t.solvedAt ?? t.createdAt);
    const due = Date.parse(t.dueAt);
    const total = SLA[p].resolve;
    return { clock: solved <= due ? 'met' : 'missed', left: between(solved, due), total, used: Math.min(1, between(created, solved) / total), tone: 'done', afterHours: false };
  }
  if (t.status === 'waiting' && t.pausedAt) {
    const total = SLA[p].resolve;
    const left = t.pausedRemaining ?? between(Date.parse(t.pausedAt), Date.parse(t.dueAt));
    return { clock: 'paused', left, total, used: Math.min(1, Math.max(0, 1 - left / total)), tone: 'muted', afterHours: false };
  }
  const responding = !t.firstResponseAt;
  const due = Date.parse(responding ? t.responseDueAt : t.dueAt);
  const total = responding ? SLA[p].respond : SLA[p].resolve;
  const left = between(now, due);
  const used = Math.min(1, Math.max(0, 1 - left / total));
  const afterHours = !clockAlwaysRuns(hours, p) && !isOpen(now, hours);
  // Amber from halfway, red in the last stretch (or the final 10 minutes).
  const tone = left < 0 || used >= 0.85 || left < 10 * MIN ? 'danger' : used >= 0.5 ? 'warn' : 'ok';
  return { clock: left < 0 ? 'missed' : responding ? 'respond' : 'resolve', left, total, used, tone, afterHours };
}

/** Working time left on each clock at the moment a ticket is paused, so resuming can pick up exactly there. */
export function remainingAtPause(t: Pick<Ticket, 'priority' | 'dueAt' | 'responseDueAt'>, now: Date, hours: Hours = ALWAYS_OPEN) {
  return {
    resolve: workingTimeBetween(now.getTime(), Date.parse(t.dueAt), hours, t.priority),
    respond: workingTimeBetween(now.getTime(), Date.parse(t.responseDueAt), hours, t.priority),
  };
}

/** New deadlines when a paused ticket starts again: the same working time that was left, counted from now. */
export function resumeTargets(remaining: { resolve: number; respond: number }, priority: Priority, now: Date, hours: Hours = ALWAYS_OPEN) {
  return {
    dueAt: new Date(addWorkingTime(now.getTime(), Math.max(0, remaining.resolve), hours, priority)),
    responseDueAt: new Date(addWorkingTime(now.getTime(), Math.max(0, remaining.respond), hours, priority)),
  };
}

/** "12m", "1h 05m", "2d 4h", "−8m" */
export function formatLeft(ms: number): string {
  const neg = ms < 0;
  let m = Math.floor(Math.abs(ms) / MIN);
  const d = Math.floor(m / (24 * 60));
  m -= d * 24 * 60;
  const h = Math.floor(m / 60);
  m -= h * 60;
  const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  return neg ? `−${text}` : text;
}

/** "12:04" countdown for the big timer, or "1:02:30" past an hour. */
export function formatClock(ms: number): string {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const text = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return neg ? `−${text}` : text;
}

export function formatMinutes(min: number | null): string {
  if (min == null) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
