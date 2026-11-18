import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Avatar, colourFor, initials, slaLabel } from './ui';
import type { Ticket } from '../../shared/types';

afterEach(cleanup);

const MIN = 60_000;
const created = Date.parse('2026-11-17T09:00:00Z');
const ticket = (over: Partial<Ticket>): Ticket => ({
  id: 1, key: 'FX-1001', subject: 's', description: '', category: 'Email', priority: 2, status: 'open', waitingReason: '',
  requester: { id: 1, name: 'Maya Rodriguez', email: '', role: 'requester', department: '' }, assignee: null, device: '', location: '', channel: 'portal',
  createdAt: new Date(created).toISOString(), updatedAt: new Date(created).toISOString(), firstResponseAt: null,
  responseDueAt: new Date(created + 30 * MIN).toISOString(), dueAt: new Date(created + 240 * MIN).toISOString(),
  pausedAt: null, pausedRemaining: null, solvedAt: null, resolution: '', rating: null, incidentId: null, ...over,
});

describe('people', () => {
  it('shows initials with a stable colour, and "?" when nobody is assigned', () => {
    expect(initials('Maya Rodriguez')).toBe('MR');
    expect(colourFor('Maya Rodriguez')).toBe(colourFor('Maya Rodriguez'));
    render(<><Avatar person={{ name: 'Jordan Smith' }} /><Avatar person={null} /></>);
    expect(screen.getByTitle('Jordan Smith').textContent).toBe('JS');
    expect(screen.getByTitle('Unassigned').textContent).toBe('?');
  });
});

describe('queue countdown labels', () => {
  it('reads like the design: minutes left, overdue, paused, solved time', () => {
    expect(slaLabel(ticket({}), created + 18 * MIN)).toMatchObject({ text: '12m', tone: 'warn' });
    expect(slaLabel(ticket({}), created + 38 * MIN)).toMatchObject({ text: '−8m', tone: 'danger' });
    expect(slaLabel(ticket({ status: 'waiting', pausedAt: new Date(created + 5 * MIN).toISOString() }), created + 99 * MIN).text).toBe('paused');
    expect(slaLabel(ticket({ status: 'solved', solvedAt: new Date(created + 9 * MIN).toISOString() }), created + 99 * MIN)).toMatchObject({ text: '9m', tone: 'done' });
  });
});
