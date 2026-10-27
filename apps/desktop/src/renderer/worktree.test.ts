import { describe, expect, it } from 'vitest';
import type { WorkspaceEvent } from '../../../../packages/protocol/src/index';
import { diffSummaryText, mayChangeWorktree } from './worktree';

const event = (type: string, data: unknown = {}): WorkspaceEvent => ({ sequence: 1, type, taskId: 'task', data, createdAt: '2026-10-27T00:00:00.000Z' });

describe('mayChangeWorktree', () => {
  it('re-reads after a run ends and after an approval settles in a state that may have touched files', () => {
    expect(mayChangeWorktree(event('task.completed'))).toBe(true);
    expect(mayChangeWorktree(event('task.stopped'))).toBe(true);
    for (const state of ['complete', 'failed', 'unknown']) expect(mayChangeWorktree(event('approval.changed', { approvalId: 'a', state }))).toBe(true);
  });

  it('ignores approvals that have not run or never will, other events and malformed payloads', () => {
    for (const state of ['awaiting-approval', 'approved', 'executing', 'rejected', 'revoked']) expect(mayChangeWorktree(event('approval.changed', { approvalId: 'a', state }))).toBe(false);
    for (const type of ['task.progress', 'task.started', 'task.tool-result', 'message.completed', 'usage.changed']) expect(mayChangeWorktree(event(type))).toBe(false);
    for (const data of [null, 'complete', ['complete'], { state: 1 }, {}]) expect(mayChangeWorktree(event('approval.changed', data))).toBe(false);
  });
});

describe('diffSummaryText', () => {
  it('says when there are no changes to show instead of staying blank', () => {
    expect(diffSummaryText(undefined)).toBe('Loading changes…');
    expect(diffSummaryText({ summary: '', patch: '', truncated: false })).toBe('No uncommitted changes to show.');
  });

  it('never calls a truncated empty diff unchanged', () => {
    expect(diffSummaryText({ summary: '', patch: '', truncated: true })).toBe('Some changes are not shown (truncated).');
  });

  it('keeps the summary, and marks truncation', () => {
    expect(diffSummaryText({ summary: ' a.txt | 1 +\n', patch: 'diff --git', truncated: false })).toBe(' a.txt | 1 +\n');
    expect(diffSummaryText({ summary: ' a.txt | 1 +\n', patch: 'diff --git', truncated: true })).toBe(' a.txt | 1 +\n (truncated)');
    expect(diffSummaryText({ summary: '', patch: 'diff --git', truncated: false })).toBe('');
  });
});
