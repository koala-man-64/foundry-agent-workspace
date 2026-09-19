import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssignmentSpec, Task } from '../../protocol/src/index';
import { ORCHESTRATION_LIMITS, boundText } from '../../protocol/src/index';
import { BudgetError, BudgetLedger } from '../src/budget-ledger';
import { OrchestrationRecords } from '../src/orchestration-records';
import { V1_SCHEMA } from '../src/schema';
import { FAKE_PROFILE_ID, Store } from '../src/store';

let directory: string;
const stores: Store[] = [];
const open = (path: string, options?: ConstructorParameters<typeof Store>[1]): Store => { const store = new Store(path, options); stores.push(store); return store; };
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'foundry-orchestration-store-')); });
afterEach(async () => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  await rm(directory, { recursive: true, force: true });
});

/** Byte-for-byte 0.2.0 layout with legacy rows, created without the new application code. */
function createV1Database(path: string): { taskId: string } {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(V1_SCHEMA); db.pragma('user_version = 1');
  const taskId = randomUUID(); const at = new Date().toISOString();
  const task: Task = { id: taskId, title: 'Legacy coding', projectPath: 'C:\\fixture', worktreePath: 'C:\\fixture-wt', branch: 'codex/task/x', baseCommit: 'a'.repeat(40), profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: at, updatedAt: at, tokenBudget: 100000, usedTokens: 1200 };
  db.prepare('INSERT INTO tasks VALUES (?, ?)').run(taskId, JSON.stringify(task));
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, 1)').run(randomUUID(), taskId, JSON.stringify({ id: 'm', taskId, role: 'user', content: 'legacy history', createdAt: at, status: 'complete' }));
  db.prepare("INSERT INTO intents VALUES (?, 'provider.context', ?, 'complete')").run(taskId, JSON.stringify({ opaque: 'provider-state' }));
  db.close();
  return { taskId };
}

function coordinatedRoot(store: Store, cap = 100_000): { rootId: string; records: OrchestrationRecords; ledger: BudgetLedger } {
  const rootId = randomUUID(); const at = new Date().toISOString();
  store.saveTask({ id: rootId, title: 'Root', projectPath: 'C:\\p', worktreePath: 'C:\\w', branch: 'codex/task/r', baseCommit: 'b'.repeat(40), profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: at, updatedAt: at, tokenBudget: cap, usedTokens: 0, mode: 'coordinated', role: 'coordinator', rootTaskId: rootId, coordination: { childProfileIds: [], requiredValidation: { command: 'exit 0', cwd: '', timeoutMs: 1000 } } });
  const records = new OrchestrationRecords(store); const ledger = new BudgetLedger(store);
  records.insertCoordinatorRun(rootId); ledger.openAccount(rootId, cap);
  return { rootId, records, ledger };
}
const spec = (allocation: number, writePaths = ['a.txt']): AssignmentSpec => ({ objective: 'Change a file', acceptance: ['done'], readPaths: [''], writePaths, profileId: FAKE_PROFILE_ID, profileFingerprint: 'f'.repeat(64), allocation, validation: null });
function admitChild(store: Store, rootId: string, records: OrchestrationRecords, allocation: number, ledger?: BudgetLedger): { childId: string; assignmentId: string } {
  const assignment = records.insertAssignment({ rootTaskId: rootId, key: randomUUID().slice(0, 8), spec: spec(allocation), createdBy: 'coordinator', creatorCallId: 'call', supersedesId: null });
  const childId = randomUUID(); const root = store.task(rootId);
  store.transaction(() => {
    store.saveTask({ ...root, id: childId, parentTaskId: rootId, role: 'child', assignmentId: assignment.id, mode: 'coding', coordination: undefined });
    records.admitAssignment(assignment.id, childId);
    records.insertChildRun(rootId, childId, assignment.id);
    ledger?.hold(rootId, assignment.id, childId, allocation);
  });
  return { childId, assignmentId: assignment.id };
}

describe('schema versions and backed-up upgrade', () => {
  it('creates a fresh database directly at v2 with orchestration available', () => {
    const store = open(join(directory, 'fresh.db'));
    expect(store.schemaVersion).toBe(2); expect(store.orchestrationAvailable).toBe(true);
  });
  it('opens an existing v1 database without upgrading it and keeps legacy history', () => {
    const path = join(directory, 'legacy.db'); const { taskId } = createV1Database(path);
    const store = open(path);
    expect(store.schemaVersion).toBe(1); expect(store.orchestrationAvailable).toBe(false);
    expect(store.snapshot().tasks.map(task => task.id)).toEqual([taskId]);
    expect(store.detail(taskId).messages[0]?.content).toBe('legacy history');
    expect(() => store.requireOrchestration()).toThrow('backed-up database upgrade');
  });
  it('upgrades v1 to v2 only after a verified backup and preserves rows and opaque provider state', async () => {
    const path = join(directory, 'legacy.db'); const { taskId } = createV1Database(path);
    const store = open(path);
    const { version, backupPath } = await store.upgradeToV2();
    expect(version).toBe(2); expect(store.orchestrationAvailable).toBe(true);
    expect(store.task(taskId).usedTokens).toBe(1200); expect(store.task(taskId).mode).toBeUndefined();
    expect(store.providerState(taskId)).toEqual({ opaque: 'provider-state' });
    const backup = new Database(backupPath, { readonly: true });
    expect(backup.pragma('user_version', { simple: true })).toBe(1);
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect((backup.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c).toBe(1);
    backup.close();
    await expect(store.upgradeToV2()).rejects.toThrow('already current');
  });
  it('does not change the database when the backup fails or cannot be verified', async () => {
    for (const fault of ['copy', 'verify'] as const) {
      const path = join(directory, `legacy-${fault}.db`); createV1Database(path);
      const store = open(path, { backupFault: fault });
      await expect(store.upgradeToV2(join(directory, `backups-${fault}`))).rejects.toThrow(/Backup/);
      expect(store.schemaVersion).toBe(1);
      expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_runs'").get()).toBeUndefined();
    }
  });
  it('rolls back an interrupted migration completely while retaining the verified backup', async () => {
    const path = join(directory, 'legacy.db'); createV1Database(path);
    const store = open(path, { migrationFault: 'after-ddl' });
    await expect(store.upgradeToV2(join(directory, 'backups'))).rejects.toThrow('Injected migration failure');
    expect(Number(store.db.pragma('user_version', { simple: true }))).toBe(1);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('agent_runs', 'assignments')").all()).toEqual([]);
    expect((await readdir(join(directory, 'backups'))).filter(name => name.endsWith('.db'))).toHaveLength(1);
    store.close();
    const reopened = open(path);
    expect(reopened.schemaVersion).toBe(1);
  });
  it('rejects unsupported future versions and never downgrades a newer database in place', () => {
    const path = join(directory, 'future.db'); const db = new Database(path); db.pragma('user_version = 3'); db.close();
    expect(() => new Store(path)).toThrow('newer application');
    const check = new Database(path); expect(check.pragma('user_version', { simple: true })).toBe(3); check.close();
  });
});

describe('relational constraints', () => {
  it('enforces one coordinator, depth one, immutable assignments, bounded revisions and no resurrection', () => {
    const store = open(join(directory, 'state.db')); const { rootId, records } = coordinatedRoot(store);
    expect(() => records.insertCoordinatorRun(rootId)).toThrow();
    const { childId, assignmentId } = admitChild(store, rootId, records, 1000);
    // A grandchild parented by a child is rejected by the database itself.
    const grandchild = randomUUID(); store.saveTask({ ...store.task(childId), id: grandchild });
    const other = records.insertAssignment({ rootTaskId: rootId, key: 'grand', spec: spec(10), createdBy: 'coordinator', creatorCallId: null, supersedesId: null });
    expect(() => store.db.prepare("INSERT INTO agent_runs(task_id, root_task_id, parent_task_id, role, assignment_id, lifecycle, created_at, updated_at) VALUES (?, ?, ?, 'child', ?, 'queued', 'x', 'x')").run(grandchild, rootId, childId, other.id)).toThrow();
    expect(() => store.db.prepare('UPDATE assignments SET spec = ? WHERE id = ?').run('{}', assignmentId)).toThrow('immutable');
    expect(records.finishRun(childId, 'succeeded')).toBe(true);
    expect(records.finishRun(childId, 'failed')).toBe(false);
    expect(() => store.db.prepare("UPDATE agent_runs SET lifecycle = 'running', outcome = NULL WHERE task_id = ?").run(childId)).toThrow('resurrected');
    for (let i = records.revisionCount(rootId); i < ORCHESTRATION_LIMITS.maxAssignmentRevisions; i++) records.insertAssignment({ rootTaskId: rootId, key: `k${i}`, spec: spec(10), createdBy: 'coordinator', creatorCallId: null, supersedesId: null });
    expect(() => records.insertAssignment({ rootTaskId: rootId, key: 'ninth', spec: spec(10), createdBy: 'coordinator', creatorCallId: null, supersedesId: null })).toThrow('8 assignment revisions');
  });
  it('limits admitted nonterminal children to two and blocks admission under a fenced root', () => {
    const store = open(join(directory, 'state.db')); const { rootId, records } = coordinatedRoot(store);
    admitChild(store, rootId, records, 100); admitChild(store, rootId, records, 100);
    expect(() => admitChild(store, rootId, records, 100)).toThrow('at most two');
    expect(records.activeChildren(rootId)).toBe(2);
    // The failed third admission left no child task, run or admitted assignment behind.
    expect(records.assignments(rootId).filter(item => item.state === 'admitted')).toHaveLength(2);
    records.fence(rootId);
    const { rootId: second, records: secondRecords } = coordinatedRoot(store); secondRecords.fence(second);
    expect(() => admitChild(store, second, secondRecords, 100)).toThrow('cancelled or terminal root');
    expect(store.snapshot().tasks.every(task => !task.parentTaskId)).toBe(true);
  });
  it('rejects self, cross-root and duplicate dependencies and makes child results immutable', () => {
    const store = open(join(directory, 'state.db')); const { rootId, records } = coordinatedRoot(store); const other = coordinatedRoot(store);
    const a = records.insertAssignment({ rootTaskId: rootId, key: 'a', spec: spec(10), createdBy: 'coordinator', creatorCallId: null, supersedesId: null });
    const b = records.insertAssignment({ rootTaskId: rootId, key: 'b', spec: spec(10), createdBy: 'coordinator', creatorCallId: null, supersedesId: null });
    const foreign = other.records.insertAssignment({ rootTaskId: other.rootId, key: 'x', spec: spec(10), createdBy: 'coordinator', creatorCallId: null, supersedesId: null });
    expect(() => records.addDependency(rootId, a.id, a.id)).toThrow();
    expect(() => records.addDependency(rootId, foreign.id, b.id)).toThrow('same root');
    records.addDependency(rootId, a.id, b.id); expect(() => records.addDependency(rootId, a.id, b.id)).toThrow();
    const { childId, assignmentId } = admitChild(store, rootId, records, 10);
    const result = records.insertResult({ rootTaskId: rootId, assignmentId, childTaskId: childId, baseCommit: 'c'.repeat(40), commit: 'd'.repeat(40), tree: 'e'.repeat(40), changedPaths: ['a.txt'], manifestSha256: '1'.repeat(64), manifest: { entries: [], sha256: '1'.repeat(64) }, evidenceIds: [], summary: 's', unresolved: '' });
    expect(() => store.db.prepare('UPDATE child_results SET summary = ? WHERE id = ?').run('forged', result.id)).toThrow('immutable');
    expect(() => store.db.prepare('DELETE FROM child_results WHERE id = ?').run(result.id)).toThrow('retained');
  });
});

describe('aggregate budget authority', () => {
  it('reconciles charged, in-flight, unused holds and unallocated funds to the root cap', () => {
    const store = open(join(directory, 'state.db')); const { rootId, records, ledger } = coordinatedRoot(store, 100_000);
    const { childId } = admitChild(store, rootId, records, 30_000, ledger);
    const request = ledger.reserve(rootId, childId, 1, 10_000);
    let summary = ledger.summary(rootId);
    expect(summary).toMatchObject({ cap: 100_000, protectedCoordinator: 20_000, charged: 0, inFlight: 10_000, unusedHolds: 20_000, unallocated: 70_000 });
    expect(summary.charged + summary.inFlight + summary.unusedHolds + summary.unallocated).toBe(summary.cap);
    expect(ledger.settle(request, 4_000)).toBe(true);
    summary = ledger.summary(rootId);
    expect(summary).toMatchObject({ charged: 4_000, inFlight: 0, unusedHolds: 26_000, unallocated: 70_000 });
    // Duplicate settlement (e.g. replayed after restart) is not counted twice.
    expect(ledger.settle(request, 4_000)).toBe(false); expect(ledger.settle(request, undefined)).toBe(false);
    expect(ledger.summary(rootId).charged).toBe(4_000);
    records.finishRun(childId, 'succeeded');
    expect(ledger.release(childId)).toBe(26_000); expect(ledger.release(childId)).toBe(0);
    summary = ledger.summary(rootId);
    expect(summary).toMatchObject({ charged: 4_000, unusedHolds: 0, unallocated: 96_000 });
  });
  it('never lets competing children or the coordinator oversubscribe held allocations', async () => {
    const store = open(join(directory, 'state.db')); const { rootId, records, ledger } = coordinatedRoot(store, 100_000);
    const a = admitChild(store, rootId, records, 40_000, ledger);
    // Protected coordinator reserve (20k) plus two 40k holds would exceed the cap.
    expect(() => admitChild(store, rootId, records, 40_001, ledger)).toThrow(BudgetError);
    const b = admitChild(store, rootId, records, 40_000, ledger);
    const attempts = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => Promise.resolve().then(() => ledger.reserve(rootId, index % 2 ? a.childId : b.childId, 1, 3_000))));
    const accepted = attempts.filter(item => item.status === 'fulfilled').length;
    expect(accepted).toBe(26); // floor(40k / 3k) = 13 per child
    const summary = ledger.summary(rootId);
    expect(summary.inFlight).toBe(78_000); expect(summary.unusedHolds).toBe(2_000);
    // The coordinator can only use the 20k that is neither held nor reserved.
    expect(() => ledger.reserve(rootId, rootId, 1, 20_001)).toThrow('held child allocations are not borrowed');
    ledger.reserve(rootId, rootId, 1, 20_000);
    expect(ledger.summary(rootId).unallocated).toBe(0);
  });
  it('serializes reservations across two database connections', () => {
    const path = join(directory, 'shared.db'); const first = open(path); const { rootId, records } = coordinatedRoot(first, 50_000);
    const child = admitChild(first, rootId, records, 10_000, new BudgetLedger(first));
    const second = open(path); const ledgers = [new BudgetLedger(first), new BudgetLedger(second)];
    let accepted = 0;
    for (let index = 0; index < 20; index++) { try { ledgers[index % 2]!.reserve(rootId, child.childId, 1, 1_000); accepted++; } catch (error) { expect(error).toBeInstanceOf(BudgetError); } }
    expect(accepted).toBe(10);
  });
  it('retains unknown usage conservatively, records overrun truthfully and blocks further admission', () => {
    const store = open(join(directory, 'state.db')); const { rootId, records, ledger } = coordinatedRoot(store, 10_000);
    const unknown = ledger.reserve(rootId, rootId, 1, 2_000);
    ledger.settle(unknown, undefined, 'transport failed after response bytes');
    expect(ledger.summary(rootId)).toMatchObject({ charged: 2_000, retainedUnknown: 2_000 });
    const over = ledger.reserve(rootId, rootId, 1, 1_000);
    ledger.settle(over, 9_500);
    const summary = ledger.summary(rootId);
    expect(summary).toMatchObject({ charged: 11_500, overrun: true }); expect(summary.unallocated).toBe(-1_500);
    expect(() => ledger.reserve(rootId, rootId, 1, 16)).toThrow('exceeds the task budget');
    expect(() => admitChild(store, rootId, records, 16, ledger)).toThrow(BudgetError);
  });
  it('fences cancelled or superseded generations and retains in-flight reservations across restart', () => {
    const path = join(directory, 'state.db'); const store = open(path); const { rootId, records, ledger } = coordinatedRoot(store, 50_000);
    const { childId } = admitChild(store, rootId, records, 10_000, ledger);
    ledger.reserve(rootId, childId, 1, 4_000);
    records.fence(childId);
    expect(() => ledger.reserve(rootId, childId, 1, 100)).toThrow('cancelled, superseded');
    expect(() => ledger.reserve(rootId, childId, 2, 100)).toThrow('cancelled, superseded');
    expect(() => ledger.release(childId)).toThrow('still in flight');
    store.close();
    const reopened = open(path); const after = new BudgetLedger(reopened);
    expect(after.summary(rootId)).toMatchObject({ charged: 4_000, inFlight: 0, retainedUnknown: 4_000 });
    expect(new OrchestrationRecords(reopened).run(childId)?.lifecycle).toBe('waiting');
    expect(after.release(childId)).toBe(6_000);
  });
});

describe('display bounds', () => {
  it('truncates display text by UTF-8 bytes with an explicit marker', () => {
    const value = 'é'.repeat(5000);
    const bounded = boundText(value, ORCHESTRATION_LIMITS.summaryTextBytes);
    expect(bounded.truncated).toBe(true); expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(ORCHESTRATION_LIMITS.summaryTextBytes);
    expect(bounded.text.endsWith('[truncated]')).toBe(true); expect(bounded.text).not.toContain('\uFFFD');
    expect(boundText('short', 10)).toEqual({ text: 'short', truncated: false });
  });
});
