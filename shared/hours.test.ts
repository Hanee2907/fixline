import { describe, expect, it } from 'vitest';
import { DEFAULT_HOURS, addWorkingTime, isOpen, local, nextOpen, opensLabel, workingTimeBetween, zoned } from './hours.js';

const H = 3_600_000;
const tz = 'America/Toronto';
const at = (y: number, m: number, d: number, hh: number, mm = 0) => zoned(y, m, d, hh * 60 + mm, tz);
const show = (ms: number) => { const l = local(ms, tz); return `${l.y}-${l.m}-${l.d} ${Math.floor(l.minutes / 60)}:${String(l.minutes % 60).padStart(2, '0')}`; };

describe('time zones', () => {
  it('turns local wall-clock times into instants and back, across daylight saving', () => {
    expect(new Date(at(2026, 11, 17, 9)).toISOString()).toBe('2026-11-17T14:00:00.000Z'); // EST, UTC−5
    expect(new Date(at(2026, 7, 15, 9)).toISOString()).toBe('2026-07-15T13:00:00.000Z'); // EDT, UTC−4
    expect(show(at(2026, 11, 1, 12))).toBe('2026-11-1 12:00'); // the day clocks fall back
  });
});

describe('working hours (Mon–Fri 8:00–17:00, Toronto)', () => {
  // 2026-11-20 is a Friday.
  it('knows when the desk is open', () => {
    expect(isOpen(at(2026, 11, 20, 9), DEFAULT_HOURS)).toBe(true);
    expect(isOpen(at(2026, 11, 20, 18), DEFAULT_HOURS)).toBe(false);
    expect(isOpen(at(2026, 11, 21, 10), DEFAULT_HOURS)).toBe(false); // Saturday
    expect(show(nextOpen(at(2026, 11, 20, 18), DEFAULT_HOURS))).toBe('2026-11-23 8:00'); // → Monday
  });

  it('a 4-hour target on Friday at 3 PM lands on Monday at 10 AM', () => {
    expect(show(addWorkingTime(at(2026, 11, 20, 15), 4 * H, DEFAULT_HOURS, 2))).toBe('2026-11-23 10:00');
  });

  it('a ticket that arrives at night starts counting when the desk opens', () => {
    expect(show(addWorkingTime(at(2026, 11, 17, 22), 30 * 60_000, DEFAULT_HOURS, 2))).toBe('2026-11-18 8:30');
  });

  it('urgent tickets keep running around the clock', () => {
    expect(show(addWorkingTime(at(2026, 11, 20, 16), 2 * H, DEFAULT_HOURS, 1))).toBe('2026-11-20 18:00');
  });

  it('measures only working time between two moments', () => {
    expect(workingTimeBetween(at(2026, 11, 20, 15), at(2026, 11, 23, 10), DEFAULT_HOURS, 2)).toBe(4 * H);
    expect(workingTimeBetween(at(2026, 11, 23, 10), at(2026, 11, 20, 15), DEFAULT_HOURS, 2)).toBe(-4 * H);
    expect(workingTimeBetween(at(2026, 11, 21, 9), at(2026, 11, 22, 17), DEFAULT_HOURS, 2)).toBe(0); // a weekend
  });

  it('says when the desk opens again', () => {
    expect(opensLabel(at(2026, 11, 20, 18), DEFAULT_HOURS)).toBe('opens Mon 8:00 AM');
    expect(opensLabel(at(2026, 11, 17, 6), DEFAULT_HOURS)).toBe('opens today 8:00 AM');
    expect(opensLabel(at(2026, 11, 17, 20), DEFAULT_HOURS)).toBe('opens tomorrow 8:00 AM');
  });
});
