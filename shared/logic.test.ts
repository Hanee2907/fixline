import { describe, expect, it } from 'vitest';
import { searchTerms, suggestCategory, suggestPriority } from './classify.js';
import { formatClock, formatLeft, slaState, targetsFor } from './sla.js';

const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();

describe('time limits', () => {
  const created = Date.parse('2026-11-17T09:00:00Z');
  const base = { priority: 2 as const, createdAt: at(created), firstResponseAt: null, pausedAt: null, solvedAt: null,
    responseDueAt: at(created + 30 * MIN), dueAt: at(created + 240 * MIN) };

  it('runs the first-response clock until IT replies, then the fix clock', () => {
    expect(slaState({ ...base, status: 'new' }, created + 18 * MIN)).toMatchObject({ clock: 'respond', left: 12 * MIN, tone: 'warn' });
    expect(slaState({ ...base, status: 'new' }, created + 40 * MIN)).toMatchObject({ clock: 'missed', tone: 'danger' });
    expect(slaState({ ...base, status: 'open', firstResponseAt: at(created + 5 * MIN) }, created + 60 * MIN)).toMatchObject({ clock: 'resolve', left: 180 * MIN, tone: 'ok' });
  });
  it('freezes while waiting, and reports met or missed once solved', () => {
    expect(slaState({ ...base, status: 'waiting', pausedAt: at(created + 60 * MIN) }, created + 999 * MIN)).toMatchObject({ clock: 'paused', left: 180 * MIN });
    expect(slaState({ ...base, status: 'solved', solvedAt: at(created + 100 * MIN) })).toMatchObject({ clock: 'met' });
    expect(slaState({ ...base, status: 'solved', solvedAt: at(created + 300 * MIN) })).toMatchObject({ clock: 'missed' });
  });
  it('sets targets by priority and formats them like the design', () => {
    const t = targetsFor(1, new Date(created));
    expect((t.responseDueAt.getTime() - created) / MIN).toBe(15);
    expect(formatLeft(12 * MIN)).toBe('12m');
    expect(formatLeft(65 * MIN)).toBe('1h 05m');
    expect(formatLeft((2 * 24 + 4) * 60 * MIN)).toBe('2d 4h');
    expect(formatLeft(-8 * MIN)).toBe('−8m');
    expect(formatClock(12 * MIN + 4000)).toBe('12:04');
  });
});

describe('sorting tickets as they arrive', () => {
  it('guesses the category from what people write', () => {
    expect(suggestCategory('Outlook keeps asking for my password')).toBe('Access');
    expect(suggestCategory('VPN disconnects every 10 minutes')).toBe('Network');
    expect(suggestCategory('Can’t print to 2nd floor printer')).toBe('Printing');
    expect(suggestCategory('new hire starting Monday needs a laptop')).toBe('Onboarding');
    expect(suggestCategory('hello')).toBe('Other');
  });
  it('guesses urgency', () => {
    expect(suggestPriority('Production line PC is down')).toBe(1);
    expect(suggestPriority('Outlook keeps asking for password')).toBe(2);
    expect(suggestPriority('Request: Adobe licence, no rush')).toBe(4);
    expect(suggestPriority('Second monitor flickers sometimes')).toBe(3);
  });
  it('keeps only useful search words', () => {
    expect(searchTerms('My VPN keeps disconnecting since yesterday!')).toEqual(['vpn', 'disconnecting']);
  });
});
