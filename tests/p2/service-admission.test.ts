import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { RuntimeService } from '../../packages/runtime/src/service';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { GitOperations, type WorktreeState } from '../../packages/runtime/src/git-operations';
import { profileFingerprint } from '../../packages/runtime/src/profile-fingerprint';
import { AutomationService } from '../../packages/runtime/src/automation';
import { Redactor } from '../../packages/runtime/src/redaction';
import type { RpcMethod, WorkspaceEvent } from '../../packages/protocol/src/index';
import { regenerating } from './oracle-node.mjs';

const stamp = '2026-01-02T03:04:05.678Z';
const projectId = '17171717-0000-4000-8000-000000000001';
const missing = '17171717-0000-4000-8000-000000000099';
const project = { id: projectId, path: 'C:\\never-probe-admission-fixture', name: 'Original', hidden: false, kind: 'folder', createdAt: stamp, updatedAt: stamp, opaque: { retained: true } };
const preferences = { profileId: FAKE_PROFILE_ID, mode: 'chat' as const, collapsedProjectIds: [], opaque: { retained: true } };
const inputs: Array<[RpcMethod, unknown]> = [
  ['workspace.schema', {}], ['project.update', { projectId: missing, name: 'Missing' }],
  ['project.update', { projectId }], ['project.update', { projectId, name: '  Renamed  ' }],
  ['project.update', { projectId, hidden: true }], ['project.update', { projectId, name: 'Visible', hidden: false }],
  ['workspace.preferences.save', { profileId: missing }], ['workspace.preferences.save', { collapsedProjectIds: [missing] }],
  ['workspace.preferences.save', {}], ['workspace.preferences.save', { collapsedProjectIds: [projectId, 'none', projectId, 'none'] }],
  ['workspace.preferences.save', { mode: 'coding', profileId: FAKE_PROFILE_ID }], ['workspace.preferences.save', { collapsedProjectIds: [] }]
];

it('pins saved-project and preference service admission across disposable eras', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(stamp));
  try {
    const cases = [];
    for (const era of ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal']) {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-admission-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(name => name.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db')); const notifications: WorkspaceEvent[] = [];
        const service = new RuntimeService(store, new RepositoryService(join(scratch, 'wt')), event => notifications.push(event), undefined, undefined, { coordinatedMode: false });
        try {
          if (store.schemaVersion >= 3) {
            store.db.prepare('INSERT INTO projects(id,path_key,data) VALUES(?,?,?)').run(projectId, 'preserve-this-path-key', JSON.stringify(project));
            store.savePreferences(preferences);
          }
          const firstSequence = (store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM events').get() as { value: number }).value;
          notifications.length = 0;
          const steps = [];
          for (const [method, params] of inputs) {
            let value: unknown = null; let error: string | null = null;
            try { value = await service.dispatch(method, params); } catch (cause) { error = (cause as Error).message; }
            steps.push({ method, params, value, error,
              project: store.schemaVersion >= 3 ? store.db.prepare('SELECT rowid,* FROM projects WHERE id=?').get(projectId) : null,
              preferences: store.preferences(),
              events: store.db.prepare('SELECT * FROM events WHERE sequence>? ORDER BY sequence').all(firstSequence), notifications: [...notifications] });
          }
          cases.push({ era, firstSequence, steps });
        } finally { await service.shutdown(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
    const corpus = { stamp, project, preferences, cases };
    if (regenerating('P2_WRITE_ADMISSION')) writeFileSync('tests/p2/service-admission-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/service-admission-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});

it('automation close prevents launch after an asynchronous pin check', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-admission-automation-'));
  const store = new Store(join(scratch, 'workspace.db'));
  const execute = vi.fn(async () => ({ stdout: '[]', stderr: '', exitCode: 0, cancelled: false, timedOut: false, cleanupVerified: true }));
  const automation = new AutomationService(store, new Redactor(), () => {}, { scriptDirectory: join(scratch, 'scripts'), executor: { execute }, now: () => new Date(stamp), resolveInterpreter: async () => ({ path: process.execPath, version: process.version }) });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void; const arrival = new Promise<void>(resolve => { arrived = resolve; });
  try {
    const revision = await automation.dispatch('automation.script.register', { id: projectId, name: 'never launch', language: 'javascript', source: 'process.stdout.write("[]")', triggers: ['task.completed'], projectPath: null, arguments: [], cwd: scratch, inputFields: ['sequence', 'type'], timeoutMs: 1000 }) as { id: string };
    await automation.dispatch('automation.script.grant', { revisionId: revision.id, expiresAt: '2026-01-03T03:04:05.678Z', maxRunsPer24h: 10 });
    // Complete the real pin validation, then hold its continuation so closing
    // happens at a deterministic await boundary without weakening its checks.
    const preflight = automation as unknown as { validateRevision: (...args: unknown[]) => Promise<void> };
    const validate = preflight.validateRevision.bind(preflight);
    vi.spyOn(preflight, 'validateRevision').mockImplementation(async (...args) => { await validate(...args); arrived(); await gate; });
    const event = store.event('task.completed', {});
    const running = automation.onEvent(event); await arrival;
    const closing = automation.close(); release(); await running; await closing;
    expect(execute).not.toHaveBeenCalled();
    expect(store.db.prepare('SELECT state FROM automation_runs').all()).toEqual([{ state: 'queued' }]);
  } finally { release(); await automation.close(); vi.restoreAllMocks(); store.close(); rmSync(scratch, { recursive: true, force: true }); }
});

for (const method of ['project.update', 'workspace.preferences.save'] as const) {
  it(`${method} rolls back state when its event insert fails`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-admission-rollback-'));
    const store = new Store(join(scratch, 'workspace.db')); const notifications: WorkspaceEvent[] = [];
    const service = new RuntimeService(store, new RepositoryService(join(scratch, 'wt')), event => notifications.push(event));
    try {
      store.db.prepare('INSERT INTO projects(id,path_key,data) VALUES(?,?,?)').run(projectId, 'stable', JSON.stringify(project));
      store.savePreferences(preferences); notifications.length = 0;
      const before = { project: store.project(projectId), preferences: store.preferences(), events: store.recentEvents(50) };
      store.db.exec("CREATE TEMP TRIGGER fail_admission_event BEFORE INSERT ON events WHEN NEW.type IN ('projects.changed','preferences.changed') BEGIN SELECT RAISE(ABORT,'Injected event failure'); END");
      await expect(service.dispatch(method, method === 'project.update' ? { projectId, hidden: true } : { mode: 'coding' })).rejects.toThrow('Injected event failure');
      expect({ project: store.project(projectId), preferences: store.preferences(), events: store.recentEvents(50) }).toEqual(before);
      expect(notifications).toEqual([]);
      store.db.exec('DROP TRIGGER fail_admission_event');
      await expect(service.dispatch('workspace.schema', {})).resolves.toMatchObject({ version: 5 });
    } finally { await service.shutdown(); rmSync(scratch, { recursive: true, force: true }); }
  });

  it(`${method} retains its committed event and closes admission after delivery failure`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-admission-notify-'));
    const store = new Store(join(scratch, 'workspace.db')); let deliveries = 0;
    const service = new RuntimeService(store, new RepositoryService(join(scratch, 'wt')), event => {
      expect(store.db.inTransaction).toBe(false);
      if (event.type === 'projects.changed' || event.type === 'preferences.changed') { deliveries++; throw new Error('private-emitter-secret'); }
    });
    try {
      store.db.prepare('INSERT INTO projects(id,path_key,data) VALUES(?,?,?)').run(projectId, 'stable', JSON.stringify(project));
      store.savePreferences(preferences);
      const input = method === 'project.update' ? { projectId, hidden: true } : { mode: 'coding' };
      await expect(service.dispatch(method, input)).rejects.toThrow('The mutation committed, but event delivery failed.');
      expect(method === 'project.update' ? store.project(projectId)?.hidden : store.preferences().mode).toBe(method === 'project.update' ? true : 'coding');
      const persisted = store.recentEvents(50); expect(persisted).toHaveLength(1);
      await expect(service.dispatch(method, input)).rejects.toThrow('Runtime is shutting down.');
      expect(store.recentEvents(50)).toEqual(persisted); expect(deliveries).toBe(1);
    } finally { await service.shutdown(); rmSync(scratch, { recursive: true, force: true }); }
  });
}

it('delivery failure stops queued orchestration before child admission and closes automation', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-admission-queued-'));
  const store = new Store(join(scratch, 'workspace.db')); const git = new GitOperations(join(scratch, 'wt'));
  let release!: (value: WorktreeState) => void; let arrived!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const state = new Promise<WorktreeState>(resolve => { release = resolve; });
  vi.spyOn(git, 'state').mockImplementation(() => { arrived(); return state; });
  const create = vi.spyOn(git, 'createChildWorktree').mockRejectedValue(new Error('Never create a worktree in this test.'));
  const closeAutomation = vi.spyOn(AutomationService.prototype, 'close');
  const service = new RuntimeService(store, new RepositoryService(join(scratch, 'wt')), event => { if (event.type === 'preferences.changed') throw new Error('Injected delivery failure'); }, undefined, undefined, { git });
  try {
    const rootId = '17171717-0000-4000-8000-000000000010';
    const root = { id: rootId, title: 'Root', projectPath: 'C:\\never-probe', worktreePath: 'C:\\never-probe-worktree', branch: 'codex/task/root', baseCommit: 'b'.repeat(40), profileId: FAKE_PROFILE_ID, status: 'idle' as const, createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0, mode: 'coordinated' as const, role: 'coordinator' as const, rootTaskId: rootId, coordination: { childProfileIds: [], requiredValidation: { command: 'exit 0', cwd: '', timeoutMs: 1000 } } };
    store.saveTask(root); service.orchestrator.createRoot(root);
    service.orchestrator.records.insertAssignment({ rootTaskId: rootId, key: 'queued', spec: { objective: 'fixture', acceptance: ['fixture'], readPaths: [''], writePaths: ['fixture.txt'], profileId: FAKE_PROFILE_ID, profileFingerprint: profileFingerprint(store.profile(FAKE_PROFILE_ID)!), allocation: 10000, validation: null }, createdBy: 'coordinator', creatorCallId: null, supersedesId: null });
    const snapshot = () => JSON.stringify({ tasks: store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all(), intents: store.db.prepare('SELECT * FROM intents ORDER BY rowid').all(), assignments: store.db.prepare('SELECT * FROM assignments ORDER BY rowid').all(), runs: store.db.prepare('SELECT * FROM agent_runs ORDER BY rowid').all() });
    const before = snapshot();
    service.orchestrator.schedule(rootId); await arrival;
    await expect(service.dispatch('workspace.preferences.save', { mode: 'coding' })).rejects.toThrow('The mutation committed, but event delivery failed.');
    expect(closeAutomation).toHaveBeenCalledTimes(1);
    release({ head: root.baseCommit, tree: 'c'.repeat(40), branch: root.branch, clean: true, stagedClean: true, operation: 'none', cherryPickHead: null, unmergedPaths: [] });
    await vi.waitFor(() => expect(service.orchestrator.isBusy()).toBe(false));
    expect(snapshot()).toBe(before); expect(create).not.toHaveBeenCalled();
  } finally {
    release({ head: 'b'.repeat(40), tree: 'c'.repeat(40), branch: 'codex/task/root', clean: true, stagedClean: true, operation: 'none', cherryPickHead: null, unmergedPaths: [] });
    await service.shutdown(); vi.restoreAllMocks(); rmSync(scratch, { recursive: true, force: true });
  }
});
