import { describe, expect, it } from 'vitest';
import { attentionAnnouncement, attentionBanner, coordinatedAttention, inboxChipLabel, inspectLabel, needsYou, statusWarnings, taskAttention, windowTitle } from './attention';

const RECOVERY = 'Unknown does not mean success and is never retried automatically.';

describe('taskAttention', () => {
  it('takes the higher of the runtime counts and the loaded cards', () => {
    expect(taskAttention({ pendingApprovals: 2, unknownOutcomes: 0 })).toMatchObject({ awaiting: 2, unknown: 0, unknownPublication: 0 });
    expect(taskAttention({ pendingApprovals: 0, unknownOutcomes: 0, approvals: [{ state: 'awaiting-approval' }] })).toMatchObject({ awaiting: 1 });
  });

  it('attributes to publication only the unknown outcomes no loaded card accounts for, never fewer', () => {
    expect(taskAttention({ pendingApprovals: 0, unknownOutcomes: 2 }).unknownPublication).toBe(2);
    expect(taskAttention({ pendingApprovals: 0, unknownOutcomes: 2, approvals: [{ state: 'unknown' }] }).unknownPublication).toBe(1);
    expect(taskAttention({ pendingApprovals: 0, unknownOutcomes: 1, approvals: [{ state: 'unknown' }, { state: 'unknown' }] })).toMatchObject({ unknown: 2, unknownPublication: 0 });
  });
});

describe('coordinatedAttention', () => {
  it('counts agents waiting on approval before their approvals load, and unknown integrations', () => {
    const attention = coordinatedAttention({ approvals: [], runs: [{ lifecycle: 'waiting', waitReason: 'approval' }, { lifecycle: 'running', waitReason: null }], integrations: [{ state: 'unknown' }, { state: 'succeeded' }], partial: true });
    expect(attention).toMatchObject({ awaiting: 1, unknown: 1, unknownIntegrations: 1, partial: true });
    expect(needsYou(attention)).toBe(true);
    expect(needsYou(coordinatedAttention({ approvals: [{ state: 'complete' }], runs: [], integrations: [], partial: false }))).toBe(false);
  });
});

describe('inspectLabel', () => {
  it('keeps the Inspect task name and names what waits inside', () => {
    expect(inspectLabel(taskAttention({ pendingApprovals: 0, unknownOutcomes: 0 }))).toBe('Inspect task');
    expect(inspectLabel(taskAttention({ pendingApprovals: 1, unknownOutcomes: 1 }))).toBe('Inspect task · approval waiting · outcome unknown');
  });
});

describe('attentionBanner', () => {
  it('keeps the existing decision sentences and button name', () => {
    expect(attentionBanner(taskAttention({ pendingApprovals: 1, unknownOutcomes: 0 }))).toEqual({ lines: ['An action is waiting for your decision.'], action: 'Review pending actions', target: 'approvals' });
    expect(attentionBanner(taskAttention({ pendingApprovals: 3, unknownOutcomes: 0 }))?.lines).toEqual(['3 actions are waiting for your decision.']);
    expect(attentionBanner(coordinatedAttention({ approvals: [{ state: 'awaiting-approval' }, { state: 'awaiting-approval' }], runs: [], integrations: [], partial: true }))?.lines).toEqual(['2+ actions are waiting for your decision.']);
  });

  it('names unknown outcomes with the recovery sentence and routes to where they can be checked', () => {
    const card = attentionBanner(taskAttention({ pendingApprovals: 0, unknownOutcomes: 1, approvals: [{ state: 'unknown' }] }));
    expect(card).toEqual({ lines: [`1 outcome needs inspection. ${RECOVERY}`], action: 'Review unknown outcomes', target: 'approvals' });
    expect(attentionBanner(taskAttention({ pendingApprovals: 0, unknownOutcomes: 2, approvals: [] }))?.target).toBe('publish');
    expect(attentionBanner(coordinatedAttention({ approvals: [], runs: [], integrations: [{ state: 'unknown' }], partial: false }))?.target).toBe('orchestration');
    expect(attentionBanner(taskAttention({ pendingApprovals: 1, unknownOutcomes: 2 }))?.lines).toEqual(['An action is waiting for your decision.', `2 outcomes need inspection. ${RECOVERY}`]);
  });

  it('names only what no on-screen card shows', () => {
    const attention = taskAttention({ pendingApprovals: 1, unknownOutcomes: 2, approvals: [{ state: 'awaiting-approval' }, { state: 'unknown' }] });
    expect(attentionBanner(attention, true)).toEqual({ lines: [`1 outcome needs inspection. ${RECOVERY}`], action: 'Review unknown outcomes', target: 'publish' });
    expect(attentionBanner(taskAttention({ pendingApprovals: 1, unknownOutcomes: 1, approvals: [{ state: 'awaiting-approval' }, { state: 'unknown' }] }), true)).toBeUndefined();
    expect(attentionBanner(taskAttention({ pendingApprovals: 0, unknownOutcomes: 0 }))).toBeUndefined();
  });
});

describe('inboxChipLabel and windowTitle', () => {
  it('never shows a false zero', () => {
    expect(inboxChipLabel('unavailable')).toBe('Needs-you count unavailable');
    expect(inboxChipLabel({ needsDecision: 0 })).toBeUndefined();
    expect(inboxChipLabel(undefined)).toBeUndefined();
    expect(inboxChipLabel({ needsDecision: 1 })).toBe('1 needs you');
    expect(inboxChipLabel({ needsDecision: 3 })).toBe('3 need you');
  });

  it('prefixes the title only while something needs Rudy', () => {
    const none = taskAttention({ pendingApprovals: 0, unknownOutcomes: 0 });
    expect(windowTitle('Foundry Agent Workspace', { needsDecision: 0 }, none)).toBe('Foundry Agent Workspace');
    expect(windowTitle('Foundry Agent Workspace', { needsDecision: 2 }, none)).toBe('Needs you (2) · Foundry Agent Workspace');
    expect(windowTitle('Foundry Agent Workspace', 'unavailable', taskAttention({ pendingApprovals: 1, unknownOutcomes: 0 }))).toBe('Needs you (1) · Foundry Agent Workspace');
  });
});

describe('statusWarnings', () => {
  it('uses the runtime thresholds and adds words, not only colour', () => {
    expect(statusWarnings({ usedTokens: 79, tokenBudget: 100, contextPercent: 79, warningPercent: 80 })).toEqual([]);
    expect(statusWarnings({ usedTokens: 80, tokenBudget: 100, contextPercent: 80, warningPercent: 80 })).toEqual(['context warning', 'budget warning']);
    expect(statusWarnings({ usedTokens: 10, tokenBudget: 0 })).toEqual([]);
  });
});

describe('attentionAnnouncement', () => {
  const quiet = { taskId: 't', awaiting: 0, unknown: 0, running: false };

  it('says nothing on the first observation of a task', () => {
    expect(attentionAnnouncement({ awaiting: 0, unknown: 0 }, { taskId: 't', awaiting: 1, unknown: 1, running: false }, 'banner')).toBeUndefined();
    expect(attentionAnnouncement({ ...quiet, taskId: 'a' }, { ...quiet, taskId: 'b', awaiting: 1 }, 'banner')).toBeUndefined();
  });

  it('announces a new decision with where to make it, and a new unknown outcome assertively', () => {
    expect(attentionAnnouncement(quiet, { ...quiet, awaiting: 1 }, 'approvals')).toEqual({ text: 'An action is waiting for your decision in Approvals.', tone: 'info' });
    expect(attentionAnnouncement(quiet, { ...quiet, awaiting: 1 }, 'banner')?.text).toBe('An action is waiting for your decision. Use Review pending actions.');
    expect(attentionAnnouncement(quiet, { ...quiet, awaiting: 1 }, 'tray')?.text).toBe('An action is waiting for your decision in Pending actions.');
    expect(attentionAnnouncement(quiet, { ...quiet, unknown: 1 }, 'banner')).toEqual({ text: `1 outcome needs inspection. ${RECOVERY}`, tone: 'error' });
    expect(attentionAnnouncement({ ...quiet, awaiting: 1 }, { ...quiet, awaiting: 2 }, 'banner')).toBeUndefined();
  });

  it('announces the end of a run only after seeing it run', () => {
    expect(attentionAnnouncement({ ...quiet, running: true }, { ...quiet, running: false, finished: 'Response complete.' }, 'banner')).toEqual({ text: 'Response complete.', tone: 'info' });
    expect(attentionAnnouncement({ ...quiet, running: undefined }, { ...quiet, running: false, finished: 'Response complete.' }, 'banner')).toBeUndefined();
  });
});
