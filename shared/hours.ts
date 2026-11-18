/**
 * Working-hours calendar. Time limits only count while the desk is open
 * (e.g. Mon–Fri, 8:00–17:00 in the desk's own time zone), so a ticket that
 * arrives on Friday evening isn't "late" on Saturday morning.
 * No date library: the time zone maths uses the built-in Intl API, which
 * also handles daylight saving changes.
 */
export interface Hours {
  timeZone: string;
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** minutes after midnight, local time */
  start: number;
  end: number;
  /** urgent (P1) tickets keep their clock running around the clock */
  urgent24x7: boolean;
}

export const DEFAULT_HOURS: Hours = { timeZone: 'America/Toronto', days: [1, 2, 3, 4, 5], start: 8 * 60, end: 17 * 60, urgent24x7: true };
export const ALWAYS_OPEN: Hours = { timeZone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 24 * 60, urgent24x7: true };

const DAY = 86_400_000;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function fmt(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    fmt(tz).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Local calendar parts of an instant in a time zone. */
export function local(ms: number, timeZone: string) {
  const p: Record<string, string> = {};
  for (const part of fmt(timeZone).formatToParts(ms)) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: WEEKDAYS[p.weekday],
    minutes: hour * 60 + Number(p.minute), seconds: Number(p.second),
  };
}

/** The instant when the local clock in `timeZone` shows y-m-d at `minutes` past midnight. */
export function zoned(y: number, m: number, d: number, minutes: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const offsetAt = (ms: number) => {
    const l = local(ms, timeZone);
    return Date.UTC(l.y, l.m - 1, l.d, 0, l.minutes, l.seconds) - Math.floor(ms / 1000) * 1000;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t); // second pass settles daylight-saving edges
  return t;
}

const runsAllDay = (h: Hours) => h.days.length === 7 && h.start <= 0 && h.end >= 24 * 60;
export const clockAlwaysRuns = (h: Hours, priority: number) => runsAllDay(h) || (priority === 1 && h.urgent24x7);

/** Start of the next open period at or after `ms` (or `ms` itself if the desk is open). */
export function nextOpen(ms: number, h: Hours): number {
  if (runsAllDay(h)) return ms;
  if (!h.days.length || h.end <= h.start) return ms; // misconfigured: fall back to always counting
  let t = ms;
  for (let i = 0; i < 15; i++) {
    const l = local(t, h.timeZone);
    if (h.days.includes(l.weekday)) {
      if (l.minutes < h.start) return zoned(l.y, l.m, l.d, h.start, h.timeZone);
      if (l.minutes < h.end) return t;
    }
    t = zoned(l.y, l.m, l.d + 1, 0, h.timeZone);
  }
  return ms;
}

/** When today's open period ends, for an instant inside it. */
function closesAt(ms: number, h: Hours): number {
  const l = local(ms, h.timeZone);
  return zoned(l.y, l.m, l.d, h.end, h.timeZone);
}

export function isOpen(ms: number, h: Hours): boolean {
  return nextOpen(ms, h) === ms;
}

/** Adds `duration` of working time to `from`. */
export function addWorkingTime(from: number, duration: number, h: Hours, priority: number): number {
  if (clockAlwaysRuns(h, priority) || !h.days.length || h.end <= h.start) return from + duration;
  let t = from;
  let left = duration;
  for (let i = 0; i < 400 && left > 0; i++) {
    t = nextOpen(t, h);
    const close = closesAt(t, h);
    if (left <= close - t) return t + left;
    left -= close - t;
    t = close;
  }
  return nextOpen(t, h) + Math.max(0, left);
}

/** Working time between two instants (negative if `to` is earlier). */
export function workingTimeBetween(from: number, to: number, h: Hours, priority: number): number {
  if (to < from) return -workingTimeBetween(to, from, h, priority);
  if (clockAlwaysRuns(h, priority) || !h.days.length || h.end <= h.start) return to - from;
  let sum = 0;
  let t = nextOpen(from, h);
  for (let i = 0; i < 400 && t < to; i++) {
    const close = Math.min(closesAt(t, h), to);
    sum += close - t;
    t = nextOpen(closesAt(t, h), h);
  }
  return sum;
}

/** "Opens Mon 8:00" for the after-hours message. */
export function opensLabel(ms: number, h: Hours): string {
  const next = nextOpen(ms, h);
  const l = local(next, h.timeZone);
  const sameDay = local(ms, h.timeZone);
  const hh = Math.floor(l.minutes / 60);
  const mm = String(l.minutes % 60).padStart(2, '0');
  const time = `${((hh + 11) % 12) + 1}:${mm} ${hh < 12 ? 'AM' : 'PM'}`;
  const days = Math.round((Date.UTC(l.y, l.m - 1, l.d) - Date.UTC(sameDay.y, sameDay.m - 1, sameDay.d)) / DAY);
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : Object.keys(WEEKDAYS)[l.weekday];
  return `opens ${day} ${time}`;
}

export const minutesLabel = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
