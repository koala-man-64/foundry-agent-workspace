import { describe, expect, it } from 'vitest';
import type { OrchestrationView } from '../../../../packages/protocol/src/orchestration';
import { createCoordinatedHandoff } from './coordinatedHandoff';

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const ROOT = uuid(1), CHILD = uuid(2), ASSIGNMENT = uuid(3), RESULT = uuid(4), VALIDATION = uuid(5);
const NOW = '2026-10-23T18:00:00.000Z', EARLIER = '2026-10-23T17:00:00.000Z';
const HEAD = 'a'.repeat(40), TREE = 'b'.repeat(40), BASE = 'c'.repeat(40);
const PRIVATE = 'private-canary-do-not-export';

function completedView(): OrchestrationView {
  const rootRun = {
    taskId: ROOT, rootTaskId: ROOT, parentTaskId: null, role: 'coordinator' as const, assignmentId: null,
    lifecycle: 'terminal' as const, waitReason: null, outcome: 'succeeded' as const, generation: 1, cancelRequested: false,
    title: PRIVATE, profileId: uuid(6), worktreePath: `C:/private/${PRIVATE}`, branch: 'foundry/coordinator-123', baseCommit: BASE, createdAt: EARLIER, updatedAt: NOW
  };
  return {
    rootTaskId: ROOT, config: { childProfileIds: [], requiredValidation: { command: PRIVATE, cwd: PRIVATE, timeoutMs: 1000 } },
    runs: [rootRun, { ...rootRun, taskId: CHILD, parentTaskId: ROOT, role: 'child', assignmentId: ASSIGNMENT, branch: 'foundry/child-123' }], runsCursor: null,
    assignments: [{
      id: ASSIGNMENT, rootTaskId: ROOT, revision: 1, supersedesId: null, key: PRIVATE, dependsOn: [], createdBy: 'coordinator', state: 'integrated', childTaskId: CHILD,
      baseCommit: BASE, baseTree: TREE, waitReason: null, createdAt: EARLIER, updatedAt: NOW,
      objective: PRIVATE, acceptance: [PRIVATE], readPaths: [PRIVATE], writePaths: [PRIVATE], profileId: uuid(6), profileFingerprint: 'd'.repeat(64), allocation: 10, validation: null
    }],
    results: [{ id: RESULT, rootTaskId: ROOT, assignmentId: ASSIGNMENT, childTaskId: CHILD, revision: 1, baseCommit: BASE, commit: HEAD, tree: TREE, changedPaths: [PRIVATE], manifestSha256: 'e'.repeat(64), evidenceIds: [uuid(7)], summary: PRIVATE, unresolved: PRIVATE, createdAt: NOW }],
    integrations: [{ id: uuid(8), rootTaskId: ROOT, resultId: RESULT, assignmentId: ASSIGNMENT, kind: 'cherry-pick', parentOperationId: null, state: 'succeeded', approvalId: uuid(9), expectedHead: BASE, expectedTree: TREE, sourceSha: HEAD, manifestSha256: 'e'.repeat(64), resolvedTree: null, observed: { commit: HEAD, tree: TREE, unmergedPaths: [PRIVATE], detail: PRIVATE }, createdAt: NOW, updatedAt: NOW }],
    evidence: [{ id: VALIDATION, rootTaskId: ROOT, runTaskId: ROOT, approvalId: uuid(10), kind: 'combined', command: PRIVATE, cwd: PRIVATE, head: HEAD, tree: TREE, branch: rootRun.branch, clean: true, stateFingerprint: 'f'.repeat(64), exitCode: 0, cleanupVerified: true, passed: true, createdAt: NOW }],
    budget: { cap: 100, protectedCoordinator: 10, charged: 1, inFlight: 0, unusedHolds: 0, unallocated: 89, retainedUnknown: 0, overrun: false, warning: false, runs: [] },
    events: [{ sequence: 1, type: 'private', data: { secret: PRIVATE, nonce: PRIVATE }, createdAt: NOW }], eventsCursor: 1,
    completion: { complete: true, completedAt: NOW, blockers: [] }, truncated: false
  };
}

describe('coordinated handoff metadata', () => {
  it('binds the current combined validation and exports only whitelisted references', () => {
    const view = completedView();
    const original = structuredClone(view);
    const report = createCoordinatedHandoff(view, ROOT, new Date(NOW));
    expect(report).toMatchObject({ format: 'foundry-coordinated-handoff', version: 1, rootTaskId: ROOT, capturedAt: NOW, completionRecordedAt: NOW, containsCode: false, repository: { head: HEAD, tree: TREE, branch: view.runs[0]!.branch }, validation: { id: VALIDATION, head: HEAD, tree: TREE, passed: true, clean: true, cleanupVerified: true, exitCode: 0 } });
    expect(report.integrations[0]!).toMatchObject({ id: uuid(8), sourceCommit: HEAD, observedCommit: HEAD, observedTree: TREE });
    expect(report.childResults[0]).toMatchObject({ id: RESULT, childTaskId: CHILD, commit: HEAD, validationEvidenceIds: [uuid(7)] });
    const encoded = JSON.stringify(report);
    expect(encoded).not.toContain(PRIVATE);
    expect(encoded).not.toContain(uuid(9));
    expect(encoded).not.toContain(uuid(10));
    expect(encoded).not.toMatch(/command|cwd|nonce|approvalId|events|stateFingerprint|worktreePath|changedPaths|summary|profileId/);
    expect(view).toEqual(original);
  });

  it.each(['running', 'waiting', 'preparing', 'queued'] as const)('refuses a %s coordinator even after completion is recorded', lifecycle => {
    const view = completedView(); view.runs[0]!.lifecycle = lifecycle;
    expect(() => createCoordinatedHandoff(view, ROOT)).toThrow('Wait for the coordinator');
  });

  it('refuses cancellation, unsuccessful coordinator and active children', () => {
    const cancelled = completedView(); cancelled.runs[0]!.cancelRequested = true;
    const failed = completedView(); failed.runs[0]!.outcome = 'failed';
    const child = completedView(); child.runs[1]!.lifecycle = 'running';
    for (const view of [cancelled, failed, child]) expect(() => createCoordinatedHandoff(view, ROOT)).toThrow(/Wait for/);
  });

  it('requires current completion and its retained record', () => {
    const stale = completedView(); stale.completion = { complete: false, completedAt: NOW, blockers: ['The task worktree changed after completion was recorded.'] };
    const notRecorded = completedView(); notRecorded.completion.completedAt = null;
    const inconsistent = completedView(); inconsistent.completion.blockers = ['An effect is unknown and must be reconciled.'];
    for (const view of [stale, notRecorded, inconsistent]) expect(() => createCoordinatedHandoff(view, ROOT)).toThrow('not currently verified');
  });

  it('never falls back from the latest failed combined evidence to an older pass', () => {
    const view = completedView();
    view.evidence.unshift({ ...view.evidence[0]!, id: uuid(11), passed: false, exitCode: 1 });
    expect(() => createCoordinatedHandoff(view, ROOT)).toThrow('latest combined validation');
  });

  it('requires combined evidence in the bounded page, verified cleanup, exit success and cleanliness', () => {
    const missing = completedView(); missing.evidence[0]!.kind = 'child';
    expect(() => createCoordinatedHandoff(missing, ROOT)).toThrow('unavailable');
    for (const key of ['cleanupVerified', 'clean', 'passed'] as const) {
      const view = completedView(); view.evidence[0]![key] = false;
      expect(() => createCoordinatedHandoff(view, ROOT)).toThrow('latest combined validation');
    }
    const unknownExit = completedView(); unknownExit.evidence[0]!.exitCode = null;
    expect(() => createCoordinatedHandoff(unknownExit, ROOT)).toThrow('latest combined validation');
  });

  it('refuses incomplete metadata but permits the independent event cursor', () => {
    const truncated = completedView(); truncated.truncated = true;
    const paged = completedView(); paged.runsCursor = 20;
    for (const view of [truncated, paged]) expect(() => createCoordinatedHandoff(view, ROOT)).toThrow('metadata is incomplete');
    expect(createCoordinatedHandoff(completedView(), ROOT).rootTaskId).toBe(ROOT);
  });

  it('requires the exact coordinator identity and validation branch', () => {
    expect(() => createCoordinatedHandoff(completedView(), uuid(22))).toThrow('different coordinated task');
    const duplicate = completedView(); duplicate.runs.push({ ...duplicate.runs[0]! });
    const foreignEvidence = completedView(); foreignEvidence.evidence[0]!.runTaskId = CHILD;
    const branch = completedView(); branch.evidence[0]!.branch = 'different';
    for (const view of [duplicate, foreignEvidence, branch]) expect(() => createCoordinatedHandoff(view, ROOT)).toThrow();
  });

  it('refuses shortened or invalid identifiers and a filesystem path as a branch', () => {
    const hash = completedView(); hash.evidence[0]!.head = HEAD.slice(0, 12);
    const identifier = completedView(); identifier.evidence[0]!.id = '../report';
    const path = completedView(); path.runs[0]!.branch = path.evidence[0]!.branch = 'C:/private/branch';
    const date = completedView(); date.completion.completedAt = '2026-10-23';
    for (const view of [hash, identifier, path, date]) expect(() => createCoordinatedHandoff(view, ROOT)).toThrow();
  });

  it('supports full SHA-256 Git objects', () => {
    const view = completedView(); view.evidence[0]!.head = 'a'.repeat(64); view.evidence[0]!.tree = 'b'.repeat(64);
    expect(createCoordinatedHandoff(view, ROOT).repository.head).toHaveLength(64);
  });

  it('rejects cross-task, missing and inconsistent integration/result references', () => {
    const missing = completedView(); missing.integrations[0]!.resultId = uuid(33);
    const foreign = completedView(); foreign.results[0]!.rootTaskId = uuid(34);
    const mismatched = completedView(); mismatched.integrations[0]!.assignmentId = uuid(35);
    const missingChild = completedView(); missingChild.results[0]!.childTaskId = uuid(36);
    for (const view of [missing, foreign, mismatched, missingChild]) expect(() => createCoordinatedHandoff(view, ROOT)).toThrow(/references are incomplete/);
  });

  it.each(['awaiting-approval', 'executing', 'conflict', 'empty', 'mismatch', 'unknown'] as const)('refuses a contradictory %s integration', state => {
    const view = completedView(); view.integrations[0]!.state = state;
    expect(() => createCoordinatedHandoff(view, ROOT)).toThrow('review or reconciliation');
  });

  it('retains unsuccessful historical metadata and permits resolved conflict continuation', () => {
    const view = completedView(); view.runs[1]!.outcome = 'failed';
    view.integrations[0]!.state = 'continued';
    view.integrations.push({ ...view.integrations[0]!, id: uuid(41), kind: 'continue', state: 'succeeded', parentOperationId: view.integrations[0]!.id, resolvedTree: TREE });
    expect(createCoordinatedHandoff(view, ROOT).integrations.map(item => item.state)).toEqual(['continued', 'succeeded']);
    view.integrations.unshift({ ...view.integrations[0]!, id: uuid(42), state: 'failed' });
    expect(createCoordinatedHandoff(view, ROOT).integrations[0]!.state).toBe('failed');
  });
});
