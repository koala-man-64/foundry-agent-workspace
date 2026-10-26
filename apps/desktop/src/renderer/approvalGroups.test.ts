import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Approval } from '../../../../packages/protocol/src/index';
import { decidedSummaryDetail, foldableDecided, partitionApprovals } from './approvalGroups';
import { Disclosure, disclosureLabel } from './Disclosure';
import { ToolReadinessNotes } from './ToolReadiness';

const HELP = 'Command review hashes regular files, including ignored dependencies, within limits of 50,000 files / 1 GiB and 10,000 directories + links.';

describe('foldableDecided', () => {
  it('folds only rejections and clean completions with complete evidence', () => {
    expect(foldableDecided({ state: 'rejected' }, true, false)).toBe(true);
    expect(foldableDecided({ state: 'complete', result: { content: 'ok', isError: false, exitCode: 0, cleanupVerified: true } }, true, false)).toBe(true);
    expect(foldableDecided({ state: 'complete', result: { content: 'edited', isError: false } }, true, false)).toBe(true);
  });

  it('keeps every live, failed, revoked or anomalous card open', () => {
    for (const state of ['awaiting-approval', 'approved', 'executing', 'unknown', 'failed', 'revoked'] as const) expect(foldableDecided({ state }, true, false)).toBe(false);
    expect(foldableDecided({ state: 'complete', result: { content: 'x', isError: true } }, true, false)).toBe(false);
    expect(foldableDecided({ state: 'complete', result: { content: 'x', isError: false, exitCode: 2 } }, true, false)).toBe(false);
    expect(foldableDecided({ state: 'complete', result: { content: 'x', isError: false, exitCode: 0, cleanupVerified: false } }, true, false)).toBe(false);
    expect(foldableDecided({ state: 'complete' }, false, false)).toBe(false);
    expect(foldableDecided({ state: 'rejected' }, true, true)).toBe(false);
  });
});

describe('partitionApprovals', () => {
  const card = (id: string, state: Approval['state']) => ({ id, state });
  const foldable = (approval: { state: Approval['state'] }) => approval.state === 'complete' || approval.state === 'rejected';

  it('keeps order within each group and leaves cards seen live where they were', () => {
    const seen = new Set<string>();
    const first = partitionApprovals([card('a', 'awaiting-approval'), card('b', 'complete'), card('c', 'unknown'), card('d', 'rejected')], foldable, seen);
    expect(first.live.map(item => item.id)).toEqual(['a', 'c']);
    expect(first.decided.map(item => item.id)).toEqual(['b', 'd']);
    const afterDecision = partitionApprovals([card('a', 'complete'), card('b', 'complete'), card('c', 'unknown'), card('d', 'rejected')], foldable, seen);
    expect(afterDecision.live.map(item => item.id)).toEqual(['a', 'c']);
    expect(partitionApprovals([card('a', 'complete')], foldable, new Set()).decided.map(item => item.id)).toEqual(['a']);
  });

  it('summarises the folded group by state', () => {
    expect(decidedSummaryDetail([{ state: 'complete' }, { state: 'rejected' }, { state: 'complete' }])).toBe('2 complete, 1 rejected');
    expect(disclosureLabel('Decided approvals', 3, { more: true, detail: '2 complete, 1 rejected' })).toBe('Decided approvals (3+: 2 complete, 1 rejected)');
    expect(disclosureLabel('Events', 14)).toBe('Events (14)');
  });
});

describe('Disclosure', () => {
  it('is a native details element with its counted summary, closed unless asked', () => {
    expect(renderToStaticMarkup(createElement(Disclosure, { summary: 'Events (2)', className: 'event-log', children: 'body' }))).toBe('<details class="disclosure event-log"><summary>Events (2)</summary>body</details>');
    expect(renderToStaticMarkup(createElement(Disclosure, { summary: 'x (1)', forceOpen: true, children: 'body' }))).toContain('<details class="disclosure" open="">');
  });
});

describe('ToolReadinessNotes', () => {
  const render = (props: Partial<Parameters<typeof ToolReadinessNotes>[0]>) => renderToStaticMarkup(createElement(ToolReadinessNotes, { readiness: 'offline', commandReviewHelp: HELP, hasCards: true, commandDecisionOpen: false, ...props }));

  it('keeps the command-review limits on screen while a command decision is open, word for word', () => {
    const html = render({ commandDecisionOpen: true });
    expect(html).toContain(`<p class="tool-readiness" data-testid="command-review-limits">${HELP}</p>`);
    expect(html.indexOf('command-review-limits')).toBeLessThan(html.indexOf('<details') === -1 ? Infinity : html.indexOf('<details'));
    expect(html).toContain('<summary>Tool review notes (1)</summary>');
  });

  it('folds reference notes once cards exist and never folds the unavailable warning', () => {
    expect(render({})).toContain('<summary>Tool review notes (2)</summary>');
    expect(render({}).match(/data-testid="command-review-limits"/g)).toHaveLength(1);
    const warning = render({ readiness: 'unavailable' });
    expect(warning.startsWith('<p class="tool-readiness">Tool execution unavailable until this profile is re-probed')).toBe(true);
    expect(render({ hasCards: false, commandDecisionOpen: true })).not.toContain('<details');
  });
});
