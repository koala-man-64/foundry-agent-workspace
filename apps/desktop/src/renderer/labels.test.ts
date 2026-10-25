import { describe, expect, it } from 'vitest';
import type { ApprovalState, TaskStatus } from '../../../../packages/protocol/src/index';
import { actionDetailLabel, actionStateLabel, approvalStateLabel, formatDateTime, formatWhen, humanize, relativeTime, taskStatusLabel } from './labels';

describe('labels', () => {
  it('names every task status and keeps the failure wording explicit', () => {
    const statuses: TaskStatus[] = ['idle', 'running', 'cancelled', 'interrupted', 'failed', 'retired'];
    expect(statuses.map(status => taskStatusLabel[status])).toEqual(['Ready', 'Working', 'Cancelled', 'Interrupted', 'Needs attention', 'Retired']);
  });

  it('keeps the raw keyword in every approval state label', () => {
    const states: ApprovalState[] = ['awaiting-approval', 'approved', 'executing', 'complete', 'rejected', 'revoked', 'unknown', 'failed'];
    for (const state of states) expect(approvalStateLabel[state]).toContain(state.split('-')[0]);
    expect(approvalStateLabel.unknown).toBe('unknown outcome');
  });

  it('describes Inbox items without raw enums and never softens unknown outcomes', () => {
    expect(actionStateLabel({ kind: 'approval', state: 'awaiting-approval' })).toBe('Approval waiting for you');
    expect(actionStateLabel({ kind: 'approval', state: 'unknown' })).toBe('Approval outcome unknown');
    expect(actionStateLabel({ kind: 'intent', state: 'unknown' })).toBe('Outcome unknown');
    expect(actionStateLabel({ kind: 'run', state: 'waiting' })).toBe('Agent waiting');
    expect(actionStateLabel({ kind: 'outcome', state: 'task.completed' })).toBe('Finished');
    expect(actionStateLabel({ kind: 'outcome', state: 'task.stopped' })).toBe('Stopped');
    expect(actionStateLabel({ kind: 'validation', state: 'failed' })).toBe('Validation failed');
    expect(actionDetailLabel({ kind: 'run', detail: 'children' })).toBe('Waiting on children');
    expect(actionDetailLabel({ kind: 'draft', detail: 'promptDraft' })).toBe('Prompt draft');
    expect(actionDetailLabel({ kind: 'intent', detail: 'git.push' })).toBe('Git push');
    expect(actionDetailLabel({ kind: 'approval', detail: 'Reviewed tool action' })).toBe('Reviewed tool action');
  });

  it('humanises identifiers', () => {
    expect(humanize('task-budget')).toBe('Task budget');
    expect(humanize('promptDraft')).toBe('Prompt draft');
    expect(humanize('assignment.admitted')).toBe('Assignment admitted');
  });

  it('says how long ago with the unit, never "now ago"', () => {
    const now = Date.parse('2026-10-25T12:00:00.000Z');
    expect(relativeTime('2026-10-25T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-10-25T11:55:00.000Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-10-25T09:00:00.000Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-23T12:00:00.000Z', now)).toBe('2 d ago');
    expect(relativeTime('not a date', now)).toBe('not a date');
  });

  it('formats dates for display and passes invalid input through', () => {
    expect(formatDateTime('2026-10-25T12:00:00.000Z')).toMatch(/2026/);
    expect(formatDateTime('nope')).toBe('nope');
    const now = new Date('2026-10-25T12:00:00.000Z');
    expect(formatWhen('2026-10-25T08:00:00.000Z', now)).not.toMatch(/2026/);
    expect(formatWhen('2026-09-01T08:00:00.000Z', now)).toMatch(/2026/);
  });
});
