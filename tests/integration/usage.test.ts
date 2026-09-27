import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { GitTask, Project, ProviderAdapter, ProviderEvent, Task, UsageReport, UsageRequests, UsageSummary } from '../../packages/protocol/src/index';
import { RuntimeService } from '../../packages/runtime/src/service';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';

let directory: string; let store: Store; let runtime: RuntimeService; let task: GitTask; let repositories: RepositoryService;
let stream: ProviderAdapter['streamTurn']; let probe: ProviderAdapter['probe'];
const events: string[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-usage-runtime-'));
  execFileSync('git', ['init', '--quiet', directory], { windowsHide: true });
  store = new Store(join(directory, 'workspace.db'));
  task = { id: randomUUID(), title: 'Measured conversation', workspaceKind: 'git', projectPath: directory, worktreePath: directory, branch: 'fixture', baseCommit: '0'.repeat(40), profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tokenBudget: 100000, usedTokens: 0, mode: 'chat' };
  store.saveTask(task); events.length = 0;
  stream = async function* () { yield { type: 'usage', inputTokens: 100, outputTokens: 20 }; yield { type: 'done', continuation: { apiKind: 'fake', data: {} } }; };
  probe = async () => { throw new Error('unused probe'); };
  repositories = new RepositoryService(join(directory, 'worktrees'));
  runtime = new RuntimeService(store, repositories, event => events.push(event.type), () => ({ streamTurn: request => stream(request), probe: (...args) => probe(...args) }));
});
afterEach(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
async function send(): Promise<void> {
  await runtime.dispatch('task.send', { taskId: task.id, content: 'hello' });
  await expect.poll(() => store.task(task.id).status).not.toBe('running');
}
async function records(): Promise<UsageRequests> { return await runtime.dispatch('usage.requests', { filters: { includeDemo: true } }) as UsageRequests; }
async function summary(): Promise<UsageSummary> { return await runtime.dispatch('usage.summary', { filters: { includeDemo: true } }) as UsageSummary; }

describe('runtime usage accounting', () => {
  it.each(['folder', 'none'] as const)('accounts once for an idempotent first-send %s chat', async workspaceKind => {
    let projectId: string | null = null;
    if (workspaceKind === 'folder') {
      const folder = join(directory, 'plain-folder'); await mkdir(folder);
      projectId = (await runtime.dispatch('project.add', { path: folder }) as Project).id;
    }
    let attempts = 0;
    stream = async function* (request) {
      attempts++;
      expect(request.tools).toBeUndefined();
      yield { type: 'metadata', reportedModel: 'measured-chat-model' };
      yield { type: 'usage', inputTokens: 11, outputTokens: 3 };
      yield { type: 'done' };
    };
    const input = { requestId: randomUUID(), projectId, content: 'First measured message', profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000 };
    const created = await runtime.dispatch('task.start', input) as Task;
    await expect.poll(() => store.task(created.id).status).toBe('idle');
    expect((await runtime.dispatch('task.start', input) as Task).id).toBe(created.id);
    expect(attempts).toBe(1);
    expect(store.task(created.id)).toMatchObject({ workspaceKind, usedTokens: 14 });
    expect((await records()).records).toMatchObject([{ taskId: created.id, outcome: 'completed', usageKnown: true, reportedModel: 'measured-chat-model' }]);
    expect((await summary()).totals).toMatchObject({ total: 14, attemptedRequests: 1, knownRequests: 1, reservedUnknown: 0 });
  });

  it('accounts for each project-channel tool continuation with a distinct request identity', async () => {
    stream = async function* (request) {
      if (!request.toolResults?.length) {
        yield { type: 'usage', inputTokens: 5, outputTokens: 2 };
        yield { type: 'tool_call', call: { id: 'channel-list', name: 'list_project_agents', arguments: {} } };
      } else {
        expect(request.toolResults[0]?.isError).toBe(false);
        yield { type: 'usage', inputTokens: 10, outputTokens: 3 };
      }
      yield { type: 'done', continuation: { apiKind: 'fake', data: {} } };
    };
    await send();
    const rows = (await records()).records;
    expect(store.task(task.id)).toMatchObject({ status: 'idle', usedTokens: 20 });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.requestId)).size).toBe(2);
    expect(rows.every(row => row.outcome === 'completed' && row.usageKnown)).toBe(true);
    expect((await summary()).totals).toMatchObject({ total: 20, attemptedRequests: 2, knownRequests: 2, reservedUnknown: 0 });
  });

  it('retains measured tokens on a failed request without executing a supplied tool', async () => {
    stream = async function* (): AsyncIterable<ProviderEvent> {
      yield { type: 'metadata', reportedModel: 'actual-model', responseId: 'response-fixture' };
      yield { type: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 15 };
      yield { type: 'tool_call', call: { id: 'denied', name: 'run_command', arguments: { command: 'must not execute' } } };
    };
    await send();
    expect(store.task(task.id)).toMatchObject({ status: 'failed', usedTokens: 120 });
    expect(store.approvals(task.id)).toHaveLength(0);
    expect((await records()).records).toMatchObject([{ reportedModel: 'actual-model', responseId: 'response-fixture', outcome: 'failed', usageKnown: true, inputTokens: 100, outputTokens: 20, reasoningTokens: 15 }]);
    expect((await summary()).totals).toMatchObject({ total: 120, reservedUnknown: 0, cacheRead: 30, reasoning: 15, knownRequests: 1 });
  });

  it('counts cancellation with final usage as measured while leaving the task cancelled', async () => {
    stream = async function* () {
      yield { type: 'usage', inputTokens: 10, outputTokens: 4 };
      await runtime.dispatch('task.cancel', { taskId: task.id });
      yield { type: 'done' };
    };
    await send();
    expect(store.task(task.id)).toMatchObject({ status: 'cancelled', usedTokens: 14 });
    expect((await records()).records[0]).toMatchObject({ outcome: 'cancelled', usageKnown: true, inputTokens: 10, outputTokens: 4 });
    expect(events).toContain('usage.changed');
  });

  it('keeps a full reservation when the stream fails without final usage', async () => {
    stream = async function* () { yield { type: 'text', text: 'partial' }; throw new Error('network failure'); };
    await send();
    const row = (await records()).records[0]!;
    expect(row).toMatchObject({ outcome: 'failed', usageKnown: false, inputTokens: null });
    expect(row.attemptedAt).not.toBeNull();
    expect(store.task(task.id).usedTokens).toBe(row.reservedTokens);
    expect((await summary()).totals).toMatchObject({ total: 0, unknownRequests: 1, reservedUnknown: row.reservedTokens });
  });

  it('snapshots request identity and reports absent breakdowns as unavailable', async () => {
    await send();
    const original = store.profile(FAKE_PROFILE_ID)!;
    store.saveProfile({ ...original, name: 'Renamed', deployment: 'different' });
    const row = (await records()).records[0]!;
    expect(row.profileName).toBe(original.name); expect(row.deployment).toBe(original.deployment);
    expect((await summary()).totals).toMatchObject({ total: 120, cacheRead: null, cacheCreation: null, reasoning: null });
    const hidden = await runtime.dispatch('usage.summary', {}) as UsageSummary;
    expect(hidden.totals.requests).toBe(0);
  });

  it('journals each profile check, including cancellation, without charging a conversation', async () => {
    probe = async (profile, _credential, observe) => {
      if (!observe) throw new Error('Missing runtime observer');
      for (const index of [0, 1]) {
        const abort = new AbortController();
        for await (const event of observe({ profile, messages: [], signal: abort.signal }, async function* () {
          yield { type: 'metadata', reportedModel: 'probe-model' };
          if (index === 0) { yield { type: 'usage', inputTokens: 5, outputTokens: 2 }; yield { type: 'done' }; }
          else { abort.abort(); throw new Error('probe cancelled'); }
        })) { expect(event.type).toBeTruthy(); }
      }
      throw new Error('Expected cancelled check');
    };
    await expect(runtime.dispatch('profile.probe', { profileId: FAKE_PROFILE_ID })).rejects.toThrow('probe cancelled');
    const rows = (await records()).records;
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.purpose === 'probe' && row.taskId === null)).toBe(true);
    expect(rows.map(row => row.outcome).sort()).toEqual(['cancelled', 'completed']);
    expect(store.task(task.id).usedTokens).toBe(0);
    expect((await summary()).totals).toMatchObject({ knownRequests: 1, unknownRequests: 1, total: 7 });
  });

  it('validates IPC filters and pagination before querying storage', async () => {
    await expect(runtime.dispatch('usage.requests', { limit: 101 })).rejects.toThrow();
    await expect(runtime.dispatch('usage.summary', { filters: { from: '2026-02-02T00:00:00Z', to: '2026-01-01T00:00:00Z' } })).rejects.toThrow();
    await expect(runtime.dispatch('usage.summary', { timeZone: 'Invalid/Timezone' })).rejects.toThrow();
    await expect(runtime.dispatch('usage.requests', { filters: { sql: 'select *' } })).rejects.toThrow();
    await expect(runtime.dispatch('usage.breakdown', { groupBy: 'credential' })).rejects.toThrow();
  });

  it('blocks an upgrade while even one profile check remains active', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    probe = async () => { await pending; return { ok: false, capabilities: { streaming: false, tools: false, continuation: false, cancellation: false, usage: false }, detail: 'fixture', fingerprint: '' }; };
    const operation = runtime.dispatch('profile.probe', { profileId: FAKE_PROFILE_ID });
    try { await expect(runtime.dispatch('workspace.upgrade', { confirm: 'backup-and-upgrade' })).rejects.toThrow('active work'); }
    finally { release(); await operation; }
  });

  it('allows an upgrade while the inspector is awaiting a read-only file operation', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repositories, 'readFile').mockImplementation(async () => {
      await pending; return { path: 'fixture.txt', content: 'fixture', hash: '0'.repeat(64) };
    });
    // Exercise admission without migrating the already-current fixture database.
    vi.spyOn(store, 'upgradeToCurrent').mockResolvedValue({ version: 4, backupPath: join(directory, 'fixture-backup.db') });
    const operation = runtime.dispatch('files.read', { taskId: task.id, path: 'fixture.txt' });
    try { await expect(runtime.dispatch('workspace.upgrade', { confirm: 'backup-and-upgrade' })).resolves.toMatchObject({ version: 4 }); }
    finally { release(); await operation; }
  });

  it('allows pending channel reads during upgrade admission but blocks channel sends', async () => {
    vi.spyOn(store, 'upgradeToCurrent').mockResolvedValue({ version: 4, backupPath: join(directory, 'fixture-backup.db') });
    const read = runtime.dispatch('channel.get', { taskId: task.id });
    await expect(runtime.dispatch('workspace.upgrade', { confirm: 'backup-and-upgrade' })).resolves.toMatchObject({ version: 4 });
    await read;
    const write = runtime.dispatch('channel.send', { taskId: task.id, requestId: randomUUID(), content: 'Fixture broadcast' });
    await expect(runtime.dispatch('workspace.upgrade', { confirm: 'backup-and-upgrade' })).rejects.toThrow('active work');
    await write;
  });

  it('blocks an upgrade while an asynchronous task creation still owns a mutation intent', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repositories, 'createTaskWorktree').mockImplementation(async () => {
      await pending; return { worktreePath: directory, branch: 'fixture-child', baseCommit: '0'.repeat(40) };
    });
    const operation = runtime.dispatch('task.create', { title: 'Pending creation', projectPath: directory, profileId: FAKE_PROFILE_ID });
    try { await expect(runtime.dispatch('workspace.upgrade', { confirm: 'backup-and-upgrade' })).rejects.toThrow('active work'); }
    finally { release(); await operation; }
  });

  it('includes child requests exactly once in the coordinated conversation panel', async () => {
    const root = { ...task, mode: 'coordinated' as const, rootTaskId: task.id, role: 'coordinator' as const };
    const child = { ...task, id: randomUUID(), title: 'Child', parentTaskId: root.id, rootTaskId: root.id, role: 'child' as const, mode: 'coding' as const };
    store.saveTask(root); store.saveTask(child);
    for (const current of [root, child]) {
      const id = randomUUID(); store.beginUsage(id, current, store.profile(current.profileId)!, 100, 'conversation'); store.attemptUsage(id);
      store.finishUsage(id, { type: 'usage', inputTokens: 20, outputTokens: 5 }, 'completed');
    }
    const rootReport = await runtime.dispatch('task.usage', { taskId: root.id }) as UsageReport;
    const childReport = await runtime.dispatch('task.usage', { taskId: child.id }) as UsageReport;
    expect(rootReport.metrics?.total).toBe(50); expect(rootReport.totals.requests).toBe(2);
    expect(new Set(rootReport.records.map(record => record.taskId))).toEqual(new Set([root.id, child.id]));
    expect(childReport.metrics?.total).toBe(25); expect(childReport.totals.requests).toBe(1);
  });
});
