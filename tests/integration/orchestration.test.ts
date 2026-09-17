import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrchestrationView, ProviderAdapter, Task } from '../../packages/protocol/src/index';
import { createProvider } from '../../packages/providers/src/index';
import { FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { approveUntil, bound, createCoordinated, createHarness, decide, git, pendingApprovals, SECOND_PROFILE, waitFor, type Harness } from './orchestration-harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });
const view = (rootId: string) => harness!.runtime.dispatch('orchestration.get', { rootTaskId: rootId }) as Promise<OrchestrationView>;
const records = () => harness!.runtime.orchestrator.records;
const assignment = (rootId: string, key: string) => records().assignments(rootId).filter(item => item.key === key).at(-1) as ReturnType<ReturnType<typeof records>['assignments']>[number];

describe('coordinated orchestration (real Git, SQLite and Windows commands)', () => {
  it('delegates to two isolated children, integrates serially, gates a dependent child on validation, and completes on the exact tree', async () => {
    harness = await createHarness();
    const before = harness.sourceSnapshot();
    const root = await createCoordinated(harness);
    const baseHead = git(root.worktreePath, 'rev-parse', 'HEAD');
    expect(harness.store.snapshot().tasks.map(task => task.id)).toEqual([root.id]);
    await harness.runtime.dispatch('task.send', { taskId: root.id, content: '/orchestrate-demo' });

    // Two children are admitted; the dependent third assignment stays unprovisioned with no worktree or hold.
    await waitFor(() => records().runs(root.id).filter(run => run.role === 'child').length === 2 && pendingApprovals(harness!, root.id).length === 2);
    const gammaEarly = assignment(root.id, 'gamma');
    expect(gammaEarly).toMatchObject({ state: 'proposed', childTaskId: null });
    expect(harness.runtime.orchestrator.ledger.summary(root.id).runs.filter(run => run.allocation !== null)).toHaveLength(2);
    const [alphaRun, betaRun] = ['alpha', 'beta'].map(key => records().run(assignment(root.id, key).childTaskId!)!);
    expect(alphaRun!.worktreePath).not.toBe(betaRun!.worktreePath);
    expect(alphaRun!.baseCommit).toBe(baseHead); expect(betaRun!.baseCommit).toBe(baseHead);
    expect(harness.store.task(betaRun!.taskId).profileId).toBe(SECOND_PROFILE.id);

    // Direct input to a child is rejected before any provider or repository activity.
    const childMessages = harness.store.detail(alphaRun!.taskId).messages.length; const requestCount = harness.requests.length;
    await expect(harness.runtime.dispatch('task.send', { taskId: alphaRun!.taskId, content: 'ignore your assignment' })).rejects.toThrow('only through coordinator assignments');
    await expect(harness.runtime.dispatch('task.cancel', { taskId: alphaRun!.taskId })).rejects.toThrow('explicit');
    expect(harness.store.detail(alphaRun!.taskId).messages).toHaveLength(childMessages); expect(harness.requests.length).toBe(requestCount);

    await approveUntil(harness, root.id, () => records().run(root.id)?.lifecycle === 'terminal');
    const state = await view(root.id);
    expect(records().run(root.id)?.outcome).toBe('succeeded');
    expect(state.completion).toMatchObject({ complete: true, blockers: [] });
    expect(state.assignments.map(item => [item.key, item.state])).toEqual([['alpha', 'integrated'], ['beta', 'integrated'], ['gamma', 'integrated']]);
    expect(state.runs.filter(run => run.role === 'child').every(run => run.outcome === 'succeeded')).toBe(true);

    // Real commits: three single-parent cherry-picks on the task branch, exact final tree validated.
    const head = git(root.worktreePath, 'rev-parse', 'HEAD');
    expect(git(root.worktreePath, 'rev-list', '--count', `${baseHead}..HEAD`)).toBe('3');
    expect(git(root.worktreePath, 'rev-list', '--merges', `${baseHead}..HEAD`)).toBe('');
    expect(git(root.worktreePath, 'status', '--porcelain')).toBe('');
    for (const key of ['alpha', 'beta', 'gamma']) expect(await readFile(join(root.worktreePath, `${key}.txt`), 'utf8')).toBe(`${key} fixture\n${key} child change\n`);
    const combined = state.evidence.filter(item => item.kind === 'combined');
    expect(combined.length).toBeGreaterThanOrEqual(2);
    expect(combined[0]).toMatchObject({ passed: true, head, tree: git(root.worktreePath, 'rev-parse', 'HEAD^{tree}'), exitCode: 0, cleanupVerified: true });
    expect(state.integrations.filter(item => item.state === 'succeeded')).toHaveLength(3);

    // The dependent child started only after alpha was integrated and the combined validation passed on that HEAD.
    const gamma = assignment(root.id, 'gamma');
    const firstValidation = combined.at(-1)!;
    expect(gamma.baseCommit).toBe(firstValidation.head);
    expect(new Date(harness.store.task(gamma.childTaskId!).createdAt).getTime()).toBeGreaterThanOrEqual(new Date(firstValidation.createdAt).getTime());
    expect(git(root.worktreePath, 'merge-base', '--is-ancestor', assignment(root.id, 'alpha').baseCommit!, gamma.baseCommit!)).toBe('');

    // Aggregate budget reconciles to the cap; no in-flight or held funds remain; usage counted once.
    const budget = state.budget;
    expect(budget.inFlight).toBe(0); expect(budget.unusedHolds).toBe(0);
    expect(budget.charged + budget.inFlight + budget.unusedHolds + budget.unallocated).toBe(budget.cap);
    expect(budget.runs.reduce((sum, run) => sum + run.charged, 0)).toBe(budget.charged);
    expect(harness.store.task(root.id).usedTokens).toBe(budget.runs.find(run => run.role === 'coordinator')!.charged);

    // Distinct profiles were used through the injected transports.
    expect(new Set(harness.requests.map(item => item.profileId))).toEqual(new Set([FAKE_PROFILE_ID, SECOND_PROFILE.id]));

    // The source checkout's files, index, HEAD, main branch and uncommitted work are unchanged; nothing was pushed.
    expect(harness.sourceSnapshot()).toEqual(before);
    expect(await readFile(join(harness.project, 'notes.untracked'), 'utf8')).toBe('user untracked file\n');

    // Evidence survives restart; completion is re-verified against the exact tree.
    await harness.restart();
    const restored = await view(root.id);
    expect(restored.completion.complete).toBe(true);
    expect(restored.integrations).toHaveLength(3); expect(restored.results).toHaveLength(3);
    await expect(harness.runtime.dispatch('task.send', { taskId: root.id, content: 'more' })).rejects.toThrow('finished or cancelled');
  }, 240_000);

  it('rejects forged, sibling, stale and legacy-path approval decisions without side effects', async () => {
    harness = await createHarness();
    const root = await createCoordinated(harness);
    await harness.runtime.dispatch('task.send', { taskId: root.id, content: '/orchestrate-demo' });
    const [first, second] = await waitFor(() => { const items = pendingApprovals(harness!, root.id); return items.length === 2 ? items : undefined; });
    expect(first!.tool).toBe('replace_text');
    const attempts = [
      { ...bound(first!), assignmentId: second!.assignmentId ?? null },
      { ...bound(first!), taskId: second!.taskId },
      { ...bound(first!), generation: first!.generation! + 1 },
      { ...bound(first!), fingerprint: second!.fingerprint },
      { ...bound(first!), nonce: second!.nonce },
      { ...bound(first!), rootTaskId: (await createCoordinated(harness)).id }
    ];
    for (const attempt of attempts) await expect(harness.runtime.dispatch('orchestration.decide', { ...attempt, decision: 'approve' })).rejects.toThrow(/stale|does not belong|not match/);
    await expect(harness.runtime.dispatch('approval.decide', { taskId: first!.taskId, approvalId: first!.id, nonce: first!.nonce, decision: 'approve' })).rejects.toThrow('bound decision');
    expect(harness.store.approval(first!.id).state).toBe('awaiting-approval');
    expect(await readFile(join(harness.store.task(first!.taskId).worktreePath, first!.path!), 'utf8')).toBe(first!.before);
    await harness.runtime.dispatch('orchestration.cancelRoot', { rootTaskId: root.id });
    await waitFor(() => records().runs(root.id).every(run => run.lifecycle === 'terminal'));
    await expect(decide(harness, first!)).rejects.toThrow();
    expect(harness.store.approval(first!.id).state).toBe('revoked');
  }, 120_000);

  it('isolates child cancellation, revokes dependent work, and fences the root against resurrection', async () => {
    harness = await createHarness();
    const root = await createCoordinated(harness);
    await harness.runtime.dispatch('task.send', { taskId: root.id, content: '/orchestrate-demo' });
    await waitFor(() => pendingApprovals(harness!, root.id).length === 2);
    const alpha = assignment(root.id, 'alpha'); const alphaRun = records().run(alpha.childTaskId!)!;
    await expect(harness.runtime.dispatch('orchestration.cancelChild', { rootTaskId: root.id, childTaskId: alphaRun.taskId, generation: alphaRun.generation + 5 })).rejects.toThrow('stale child generation');
    await harness.runtime.dispatch('orchestration.cancelChild', { rootTaskId: root.id, childTaskId: alphaRun.taskId, generation: alphaRun.generation });
    await waitFor(() => records().run(alphaRun.taskId)?.lifecycle === 'terminal');
    expect(records().run(alphaRun.taskId)?.outcome).toBe('cancelled');
    expect(assignment(root.id, 'alpha').state).toBe('cancelled');
    expect(harness.store.approvals(alphaRun.taskId).every(item => item.state !== 'awaiting-approval')).toBe(true);
    expect(harness.runtime.orchestrator.ledger.summary(root.id).runs.find(run => run.taskId === alphaRun.taskId)?.released).toBe(true);
    // Beta (sibling) continues through its own reviewed handoff; gamma depends on alpha and is revoked, never provisioned.
    await approveUntil(harness, root.id, () => assignment(root.id, 'beta').state === 'result-submitted' && records().run(assignment(root.id, 'beta').childTaskId!)?.lifecycle === 'terminal');
    await waitFor(() => assignment(root.id, 'gamma').state === 'revoked');
    expect(assignment(root.id, 'gamma').childTaskId).toBeNull();
    await waitFor(() => records().run(root.id)?.lifecycle === 'waiting');
    // Completion is refused while an assignment is unresolved.
    expect((await view(root.id)).completion.blockers.join(' ')).toContain('alpha');
    await harness.runtime.dispatch('orchestration.cancelRoot', { rootTaskId: root.id });
    await waitFor(() => records().runs(root.id).every(run => run.lifecycle === 'terminal'));
    expect(records().run(root.id)?.outcome).toBe('cancelled');
    await expect(harness.runtime.dispatch('orchestration.resume', { rootTaskId: root.id, content: 'continue' })).rejects.toThrow('finished or cancelled');
    expect(() => harness!.store.db.prepare("UPDATE agent_runs SET lifecycle = 'running', outcome = NULL WHERE task_id = ?").run(root.id)).toThrow('resurrected');
  }, 180_000);

  it('denies coordinator-only calls from a child at the runtime policy boundary', async () => {
    const fake = createProvider('fake');
    const provider: ProviderAdapter = { probe: profile => fake.probe(profile), async *streamTurn(request) {
      if (request.tools?.some(tool => tool.name === 'submit_handoff') && !request.continuation) {
        const forged = { id: 'forged-delegate', name: 'delegate_assignments', arguments: { assignments: [{ key: 'evil', objective: 'x', acceptance: ['x'], writePaths: ['README.md'], allocation: 2048, dependsOn: [] }] } };
        yield { type: 'tool_call', call: forged }; yield { type: 'done', continuation: { apiKind: 'fake', data: { fixture: 'child', stage: 'submit', calls: [forged], memo: {} } } }; return;
      }
      if (request.tools?.some(tool => tool.name === 'submit_handoff')) {
        expect(request.toolResults?.[0]).toMatchObject({ isError: true }); expect(request.toolResults?.[0]?.content).toContain('not available to the child role');
        yield { type: 'text', text: 'denied' }; yield { type: 'done', continuation: { apiKind: 'fake', data: { fixture: 'child', stage: 'complete', calls: [], memo: {} } } }; return;
      }
      yield* fake.streamTurn(request);
    } };
    harness = await createHarness(() => provider);
    const root = await createCoordinated(harness);
    await harness.runtime.dispatch('task.send', { taskId: root.id, content: '/orchestrate-demo' });
    await waitFor(() => records().runs(root.id).filter(run => run.role === 'child' && run.lifecycle === 'terminal').length === 2);
    expect(records().assignments(root.id).map(item => item.key).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(harness.events.filter(event => event.type === 'orchestration.policy-denied')).toHaveLength(2);
    expect(records().runs(root.id).filter(run => run.role === 'child').map(run => run.outcome)).toEqual(['incomplete', 'incomplete']);
  }, 120_000);

  it('preserves an integration conflict, requires a newly reviewed resolved tree, and invalidates stale validation', async () => {
    harness = await createHarness();
    const root = await createCoordinated(harness);
    await harness.runtime.dispatch('task.send', { taskId: root.id, content: '/orchestrate-demo' });
    // Let children finish their handoffs, but hold integration approvals.
    await approveUntil(harness, root.id, () => ['alpha', 'beta'].every(key => assignment(root.id, key)?.state === 'result-submitted'), { skip: item => item.tool === 'integrate_result' });
    // The integration approval is prepared against the current HEAD; then external drift lands on the task branch.
    const stale = await waitFor(() => pendingApprovals(harness!, root.id).find(item => item.tool === 'integrate_result'));
    await writeFile(join(root.worktreePath, 'alpha.txt'), 'alpha fixture\nuser conflicting change\n');
    git(root.worktreePath, 'add', 'alpha.txt'); git(root.worktreePath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'user drift');
    const drifted = git(root.worktreePath, 'rev-parse', 'HEAD');
    // Approving the stale proposal runs no cherry-pick.
    expect(stale.integration?.expectedHead).not.toBe(drifted);
    await decide(harness, stale);
    await waitFor(() => records().integration(stale.integration!.operationId)?.state === 'failed');
    expect(git(root.worktreePath, 'rev-parse', 'HEAD')).toBe(drifted);
    await waitFor(() => records().run(root.id)?.lifecycle === 'waiting');

    // A fresh request integrates against the drifted HEAD and conflicts; the conflict is preserved, not aborted.
    const scripted = createProvider('fake');
    const resultId = records().latestResult(assignment(root.id, 'alpha').id)!.id;
    await harness.restart(() => ({ probe: profile => scripted.probe(profile), async *streamTurn(request) {
      if (request.tools?.some(tool => tool.name === 'integrate_result') && request.messages.some(message => message.content === 'integrate alpha')) {
        const call = { id: `retry-${resultId}`, name: 'integrate_result', arguments: { resultId } };
        yield { type: 'tool_call', call }; yield { type: 'done', continuation: { apiKind: 'fake', data: { fixture: 'coordinator', stage: 'complete', calls: [call], memo: {} } } }; return;
      }
      yield* scripted.streamTurn(request);
    } }));
    await harness.runtime.dispatch('orchestration.resume', { rootTaskId: root.id, content: 'integrate alpha' });
    const conflictApproval = await waitFor(() => pendingApprovals(harness!, root.id).find(item => item.tool === 'integrate_result'));
    await decide(harness, conflictApproval);
    const conflict = await waitFor(() => { const item = records().integration(conflictApproval.integration!.operationId); return item?.state === 'conflict' ? item : undefined; });
    expect(conflict.observed?.unmergedPaths).toEqual(['alpha.txt']);
    expect(git(root.worktreePath, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toBe(records().latestResult(assignment(root.id, 'alpha').id)!.commit);
    await expect(harness.runtime.dispatch('orchestration.prepareContinue', { rootTaskId: root.id, operationId: conflict.id })).rejects.toThrow();

    // External resolution, then a newly bound continuation of exactly the resolved index tree.
    await writeFile(join(root.worktreePath, 'alpha.txt'), 'alpha fixture\nuser conflicting change\nalpha child change\n');
    git(root.worktreePath, 'add', 'alpha.txt');
    const resolvedTree = git(root.worktreePath, 'write-tree');
    const { approvalId } = await harness.runtime.dispatch('orchestration.prepareContinue', { rootTaskId: root.id, operationId: conflict.id }) as { approvalId: string };
    const continuation = harness.store.approval(approvalId);
    expect(continuation.integration).toMatchObject({ kind: 'continue', resolvedTree });
    await expect(harness.runtime.dispatch('approval.decide', { taskId: root.id, approvalId, nonce: continuation.nonce, decision: 'approve' })).rejects.toThrow('bound decision');
    await decide(harness, continuation);
    await waitFor(() => records().integration(continuation.integration!.operationId)?.state === 'succeeded');
    expect(git(root.worktreePath, 'rev-parse', 'HEAD^{tree}')).toBe(resolvedTree);
    expect(git(root.worktreePath, 'rev-parse', 'HEAD^')).toBe(drifted);
    expect(assignment(root.id, 'alpha').state).toBe('integrated');
    // No combined validation on this tree yet: completion is blocked and dependent gamma still waits.
    const blocked = await view(root.id);
    expect(blocked.completion.complete).toBe(false);
    expect(blocked.completion.blockers.join(' ')).toMatch(/combined validation has not run|stale/);
    expect(assignment(root.id, 'gamma').state).toBe('proposed');
  }, 240_000);

  it('classifies an already-present effect as a blocked empty cherry-pick without skip, continue or empty commit', async () => {
    harness = await createHarness();
    const root = await createCoordinated(harness);
    await harness.runtime.dispatch('task.send', { taskId: root.id, content: '/orchestrate-demo' });
    await approveUntil(harness, root.id, () => assignment(root.id, 'alpha')?.state === 'result-submitted' && assignment(root.id, 'beta')?.state === 'result-submitted', { skip: item => item.tool === 'integrate_result' });
    const approval = await waitFor(() => pendingApprovals(harness!, root.id).find(item => item.tool === 'integrate_result'));
    expect(approval.integration?.patch).toContain('+alpha child change');
    await decide(harness, approval, 'reject');
    await waitFor(() => records().run(root.id)?.lifecycle === 'waiting');
    // The user lands the identical effect on the task branch first.
    await writeFile(join(root.worktreePath, 'alpha.txt'), 'alpha fixture\nalpha child change\n');
    git(root.worktreePath, 'add', 'alpha.txt'); git(root.worktreePath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'same effect');
    const head = git(root.worktreePath, 'rev-parse', 'HEAD');
    const scripted = createProvider('fake');
    const resultId = records().latestResult(assignment(root.id, 'alpha').id)!.id;
    await harness.restart(() => ({ probe: profile => scripted.probe(profile), async *streamTurn(request) {
      if (request.messages.some(message => message.content === 'integrate again')) {
        const call = { id: 'empty-integration', name: 'integrate_result', arguments: { resultId } };
        yield { type: 'tool_call', call }; yield { type: 'done', continuation: { apiKind: 'fake', data: { fixture: 'coordinator', stage: 'complete', calls: [call], memo: {} } } }; return;
      }
      yield* scripted.streamTurn(request);
    } }));
    await harness.runtime.dispatch('orchestration.resume', { rootTaskId: root.id, content: 'integrate again' });
    const next = await waitFor(() => pendingApprovals(harness!, root.id).find(item => item.tool === 'integrate_result'));
    await decide(harness, next);
    const empty = await waitFor(() => { const item = records().integration(next.integration!.operationId); return item?.state === 'empty' ? item : undefined; });
    expect(git(root.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    await expect(harness.runtime.dispatch('orchestration.prepareContinue', { rootTaskId: root.id, operationId: empty.id })).rejects.toThrow('preserved conflict');
    expect(assignment(root.id, 'alpha').state).toBe('result-submitted');
    expect((await view(root.id)).completion.blockers.join(' ')).toContain('empty');
  }, 240_000);

  it('retains the reservation after a provider failure following response bytes and never retries automatically, even across restart', async () => {
    let calls = 0;
    const provider: ProviderAdapter = { probe: async () => { throw new Error('unused'); }, async *streamTurn() { calls++; yield { type: 'text', text: 'partial output' }; throw new Error('connection reset after first bytes'); } };
    harness = await createHarness(() => provider);
    const root = await createCoordinated(harness);
    await harness.runtime.dispatch('task.send', { taskId: root.id, content: 'start' });
    await waitFor(() => records().run(root.id)?.lifecycle === 'waiting' && harness!.store.task(root.id).status === 'failed');
    expect(calls).toBe(1);
    const summary = harness.runtime.orchestrator.ledger.summary(root.id);
    expect(summary.inFlight).toBe(0); expect(summary.retainedUnknown).toBeGreaterThan(2048); expect(summary.charged).toBe(summary.retainedUnknown);
    await harness.restart(() => provider);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(calls).toBe(1);
    expect(harness.runtime.orchestrator.ledger.summary(root.id).retainedUnknown).toBe(summary.retainedUnknown);
    expect(records().run(root.id)).toMatchObject({ lifecycle: 'waiting', waitReason: 'user-continuation' });
  }, 60_000);

  it('does not silently resume children after restart and delivers a recorded wait exactly once on explicit resume', async () => {
    harness = await createHarness();
    const root = await createCoordinated(harness);
    await harness.runtime.dispatch('task.send', { taskId: root.id, content: '/orchestrate-demo' });
    await waitFor(() => pendingApprovals(harness!, root.id).length === 2 && records().run(root.id)?.waitReason === 'children');
    const childIds = records().runs(root.id).filter(run => run.role === 'child').map(run => run.taskId);
    await harness.restart();
    const requestsAfterRestart = harness.requests.length;
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(harness.requests.length).toBe(requestsAfterRestart);
    for (const id of childIds) {
      expect(records().run(id)).toMatchObject({ lifecycle: 'waiting', waitReason: 'user-continuation' });
      expect(harness.store.approvals(id).every(item => item.state === 'revoked')).toBe(true);
    }
    expect(harness.runtime.orchestrator.ledger.summary(root.id).inFlight).toBe(0);
    const resumed = await harness.runtime.dispatch('orchestration.resume', { rootTaskId: root.id, content: 'Resume after restart.' }) as { delivered: number };
    expect(resumed.delivered).toBe(1);
    for (const id of childIds) expect(records().run(id)?.outcome).toBe('incomplete');
    // No child model request was replayed; only the explicit coordinator continuation ran.
    await waitFor(() => harness!.store.task(root.id).status !== 'running');
    expect(harness.requests.slice(requestsAfterRestart).every(item => item.request.tools?.some(tool => tool.name === 'delegate_assignments'))).toBe(true);
    const wait = harness.store.db.prepare('SELECT state, result FROM wait_operations WHERE root_task_id = ?').get(root.id) as { state: string; result: string };
    expect(wait.state).toBe('delivered');
    expect(() => harness!.store.db.prepare("UPDATE wait_operations SET result = 'x' WHERE root_task_id = ?").run(root.id)).toThrow('at most once');
  }, 120_000);

  it('keeps coordinated mode behind the build gate and the backed-up database upgrade while legacy tasks keep working', async () => {
    harness = await createHarness();
    const { RuntimeService } = await import('../../packages/runtime/src/service');
    const { RepositoryService } = await import('../../packages/runtime/src/repository');
    const gated = new RuntimeService(harness.store, new RepositoryService(join(harness.directory, 'gated')), () => {}, undefined, undefined, { coordinatedMode: false });
    await expect(gated.dispatch('task.create', { title: 'x', projectPath: harness.project, profileId: FAKE_PROFILE_ID, mode: 'coordinated', coordination: { childProfileIds: [], requiredValidation: { command: 'exit 0' } } })).rejects.toThrow('not available in this build');
    await expect(gated.dispatch('orchestration.cancelRoot', { rootTaskId: FAKE_PROFILE_ID })).rejects.toThrow('not available');
    expect(await gated.dispatch('workspace.schema', {})).toMatchObject({ version: 2, coordinatedAvailable: false });
    const legacy = await harness.runtime.dispatch('task.create', { title: 'Legacy chat', projectPath: harness.project, profileId: FAKE_PROFILE_ID }) as Task;
    expect(legacy.mode).toBe('chat'); expect(legacy.rootTaskId).toBeUndefined();
    await harness.runtime.dispatch('task.send', { taskId: legacy.id, content: 'hello' });
    await waitFor(() => harness!.store.task(legacy.id).status === 'idle');
    expect(harness.store.detail(legacy.id).messages.at(-1)?.content).toBe('Fake response: hello');
    await expect(harness.runtime.dispatch('task.create', { title: 'bad', projectPath: harness.project, profileId: FAKE_PROFILE_ID, mode: 'chat', coordination: { childProfileIds: [], requiredValidation: { command: 'exit 0' } } })).rejects.toThrow('only to coordinated');
  }, 60_000);
});
