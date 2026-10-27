import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceEvent } from '../../../../packages/protocol/src/index';
import { ChangesPanel, diffSummaryText, EMPTY_DIFF_TEXT, mayChangeWorktree } from './worktree';

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
  it('says when there are no changes to show instead of staying blank, without calling the worktree clean', () => {
    expect(diffSummaryText(undefined)).toBe('Loading changes…');
    expect(diffSummaryText({ summary: '', patch: '', truncated: false })).toBe(EMPTY_DIFF_TEXT);
    expect(EMPTY_DIFF_TEXT).toMatch(/^No changes to show\. Secret-named files, and new files that are binary or too large to read, are not listed\.$/);
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

describe('ChangesPanel', () => {
  const render = (props: Parameters<typeof ChangesPanel>[0]) => renderToStaticMarkup(createElement(ChangesPanel, props));
  const onRetry = () => undefined;

  it('shows the summary and the patch when the read succeeded', () => {
    const html = render({ diff: { summary: ' a.txt | 1 +', patch: '+added', truncated: false }, error: '', onRetry });
    expect(html).not.toContain('role="alert"');
    expect(html).toContain(' a.txt | 1 +');
    expect(html).toContain('+added');
  });

  it('says a failed first read in place, with Retry, instead of loading forever', () => {
    const html = render({ diff: undefined, error: 'locked', onRetry });
    expect(html).toContain('Could not load changes: locked');
    expect(html).toContain('>Retry</button>');
    expect(html).not.toContain('Loading changes');
  });

  it('keeps an older diff after a failed refresh but says it may be out of date', () => {
    const html = render({ diff: { summary: '', patch: '', truncated: false }, error: 'locked', onRetry });
    expect(html).toContain('Could not load changes: locked What is shown below may be out of date.');
    expect(html).toContain(EMPTY_DIFF_TEXT);
  });
});
