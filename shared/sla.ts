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

export function targetsFor(priority: Priority, from: Date) {
  return {
    responseDueAt: new Date(from.getTime() + SLA[priority].respond),
    dueAt: new Date(from.getTime() + SLA[priority].resolve),
  };
}

export type Clock = 'respond' | 'resolve' | 'paused' | 'met' | 'missed';

export interface SlaState {
  clock: Clock;
  /** milliseconds left until the active target; negative once it's missed */
  left: number;
  /** total length of the active target, for the progress bar */
  total: number;
  /** 0..1 of the target used up */
  used: number;
  tone: 'ok' | 'warn' | 'danger' | 'muted' | 'done';
}

/**
 * Where a ticket stands against its targets right now.
 * Before anyone replies, the first-response clock runs; after that, the fix clock.
 * While a ticket waits on the user or a part, the clock is paused.
 */
export function slaState(t: Pick<Ticket, 'priority' | 'status' | 'createdAt' | 'firstResponseAt' | 'responseDueAt' | 'dueAt' | 'pausedAt' | 'solvedAt'>, now = Date.now()): SlaState {
  const created = Date.parse(t.createdAt);
  if (t.status === 'solved') {
    const solved = Date.parse(t.solvedAt ?? t.createdAt);
    const due = Date.parse(t.dueAt);
    const total = due - created;
    return { clock: solved <= due ? 'met' : 'missed', left: due - solved, total, used: Math.min(1, (solved - created) / total), tone: 'done' };
  }
  if (t.status === 'waiting' && t.pausedAt) {
    const due = Date.parse(t.dueAt);
    const paused = Date.parse(t.pausedAt);
    const total = due - created;
    return { clock: 'paused', left: due - paused, total, used: Math.min(1, (paused - created) / total), tone: 'muted' };
  }
  const responding = !t.firstResponseAt;
  const due = Date.parse(responding ? t.responseDueAt : t.dueAt);
  const total = Math.max(1, due - created);
  const left = due - now;
  const used = Math.min(1, Math.max(0, (now - created) / total));
  // Amber from halfway, red in the last stretch (or the final 10 minutes).
  const tone = left < 0 || used >= 0.85 || left < 10 * MIN ? 'danger' : used >= 0.5 ? 'warn' : 'ok';
  return { clock: left < 0 ? 'missed' : responding ? 'respond' : 'resolve', left, total, used, tone };
}

/** When a paused ticket starts again, the deadlines move by however long it waited. */
export function resumeShift(pausedAt: string, now: Date) {
  return Math.max(0, now.getTime() - Date.parse(pausedAt));
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
