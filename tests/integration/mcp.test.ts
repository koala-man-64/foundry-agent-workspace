import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Approval, McpServerStatus, ProviderAdapter, ProviderEvent, ProviderToolResult, Task, ToolCall } from '../../packages/protocol/src/index';
import { RuntimeService } from '../../packages/runtime/src/service';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { createProvider } from '../../packages/providers/src/index';

const FIXTURE = resolve('tests/fixtures/mcp-fixture-server.mjs');
const CANARY = 'mcp-canary-secret-value-8899';
let directory: string; let store: Store; let runtime: RuntimeService; let project: string; let notes: string;
const events: { type: string; taskId?: string; data: unknown }[] = [];
function git(...args: string[]): string { return execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
function alive(pid: number): boolean { return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }).includes(String(pid)); }

/** Scripted tool-calling provider: each turn emits the next step's calls, records results, and ends with text. */
class ScriptProvider implements ProviderAdapter {
  readonly results: ProviderToolResult[] = [];
  constructor(private readonly steps: ToolCall[][]) {}
  async probe(): Promise<never> { throw new Error('not used'); }
  async *streamTurn(request: Parameters<ProviderAdapter['streamTurn']>[0]): AsyncIterable<ProviderEvent> {
    this.results.push(...(request.toolResults ?? []));
    const calls = this.steps.shift();
    if (calls?.length) { for (const call of calls) yield { type: 'tool_call', call }; yield { type: 'done', continuation: { apiKind: 'fake', data: { stage: 'script', calls } } }; return; }
    yield { type: 'text', text: 'script complete' }; yield { type: 'done', continuation: { apiKind: 'fake', data: { stage: 'complete', calls: [] } } };
  }
}

const config = (overrides: Partial<McpServerStatus> = {}): Record<string, unknown> => ({ id: randomUUID(), key: 'fixture', name: 'Fixture server', command: process.execPath, arguments: [FIXTURE], cwd: '', environment: { MCP_FIXTURE_NOTES: notes, MCP_FIXTURE_CANARY: CANARY }, enabled: true, readOnlyTools: ['echo', 'secret_echo', 'huge'], callTimeoutMs: 1500, ...overrides });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-mcp-')); project = join(directory, 'source'); await mkdir(project); notes = join(directory, 'notes.txt');
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), '# Fixture\n'); git('add', 'README.md'); git('commit', '-m', 'fixture');
  store = new Store(join(directory, 'state', 'workspace.db'));
  runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event));
  events.length = 0;
});
afterEach(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });

const waitFor = async (check: () => boolean, timeout = 15000): Promise<void> => { await expect.poll(check, { timeout, interval: 25 }).toBe(true); };
const done = (id: string): Promise<void> => waitFor(() => store.task(id).status !== 'running');
const proposal = async (id: string): Promise<Approval> => { await waitFor(() => store.approvals(id).some(item => item.state === 'awaiting-approval')); return store.approvals(id).find(item => item.state === 'awaiting-approval')!; };
const decide = (approval: Approval, decision: 'approve' | 'reject' = 'approve') => runtime.dispatch('approval.decide', { taskId: approval.taskId, approvalId: approval.id, nonce: approval.nonce, decision });
const codingTask = async (): Promise<Task> => await runtime.dispatch('task.create', { title: 'MCP', projectPath: project, profileId: FAKE_PROFILE_ID, mode: 'coding', tokenBudget: 500000 }) as Task;
const withProvider = async (provider: ProviderAdapter): Promise<void> => {
  await runtime.shutdown(); store = new Store(join(directory, 'state', 'workspace.db'));
  runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event), kind => kind === 'fake' ? provider : createProvider(kind));
};

describe('MCP servers under runtime policy', () => {
  it('lists tools from a real supervised launch, skips unsupported names, and rejects unsafe configuration', async () => {
    const saved = await runtime.dispatch('mcp.save', config()) as McpServerStatus;
    expect(saved.tools.map(tool => tool.name).sort()).toEqual(['echo', 'fail', 'huge', 'secret_echo', 'slow', 'spawn_child', 'write_note']);
    expect(saved.tools.find(tool => tool.name === 'echo')?.readOnlyHint).toBe(true);
    expect(saved.serverInfo).toEqual({ name: 'foundry-fixture', version: '1.0.0' });
    expect(saved.lastError).toContain('bad.name');
    expect(saved.running).toBe(true);
    const listed = await runtime.dispatch('mcp.list', {}) as McpServerStatus[];
    expect(listed).toHaveLength(1);
    await expect(runtime.dispatch('mcp.save', config({ key: 'other', command: 'node' }))).resolves.toMatchObject({ tools: [], lastError: expect.stringContaining('absolute path') });
    await expect(runtime.dispatch('mcp.save', config({ key: 'fixture', id: randomUUID() }))).rejects.toThrow('already uses the key');
    await expect(runtime.dispatch('mcp.save', config({ key: 'env', environment: { API_KEY: 'x' } }))).resolves.toMatchObject({ tools: [], lastError: expect.stringContaining('not permitted') });
    const missing = await runtime.dispatch('mcp.save', config({ key: 'missing', arguments: [join(directory, 'nope.mjs')] })) as McpServerStatus;
    expect(missing.tools).toEqual([]); expect(missing.lastError).toContain('failed to start');
    expect((await runtime.dispatch('mcp.remove', { serverId: saved.id })) as { removed: boolean }).toEqual({ removed: true });
  });

  it('follows tools/list pagination cursors up to MAX_TOOLS', async () => {
    const paginated = await runtime.dispatch('mcp.save', config({
      key: 'paginated',
      environment: { MCP_FIXTURE_NOTES: notes, MCP_FIXTURE_CANARY: CANARY, MCP_FIXTURE_PAGINATE: '1' },
    })) as McpServerStatus;
    expect(paginated.tools.map(tool => tool.name).sort()).toEqual(['page1_tool', 'page2_tool']);
    expect((await runtime.dispatch('mcp.remove', { serverId: paginated.id })) as { removed: boolean }).toEqual({ removed: true });
  });

  it('runs allowlisted read-only tools within policy and requires a one-shot decision for everything else', async () => {
    await runtime.dispatch('mcp.save', config());
    const rejected = await codingTask();
    await runtime.dispatch('task.send', { taskId: rejected.id, content: '/mcp-demo' });
    const write = await proposal(rejected.id);
    expect(write.tool).toBe('mcp__fixture__write_note');
    expect(write.mcp).toMatchObject({ serverKey: 'fixture', tool: 'write_note' });
    expect(JSON.parse(write.mcp!.arguments)).toEqual({ text: 'echo said: echo: ping from the offline demo' });
    // The read-only echo ran without any approval record.
    expect(store.approvals(rejected.id)).toHaveLength(1);
    await expect(runtime.dispatch('approval.decide', { taskId: rejected.id, approvalId: write.id, nonce: randomUUID(), decision: 'approve' })).rejects.toThrow('stale');
    await decide(write, 'reject'); await done(rejected.id);
    expect(store.approval(write.id).state).toBe('rejected');
    await expect(stat(notes)).rejects.toThrow();
    expect(store.detail(rejected.id).messages.at(-1)?.content).toContain('not written');

    const approved = await codingTask();
    await runtime.dispatch('task.send', { taskId: approved.id, content: '/mcp-demo' });
    const second = await proposal(approved.id);
    await decide(second); await done(approved.id);
    expect(store.task(approved.id).status).toBe('idle');
    expect(store.approval(second.id)).toMatchObject({ state: 'complete', result: { isError: false, content: expect.stringContaining('note written') } });
    expect(await readFile(notes, 'utf8')).toBe('echo said: echo: ping from the offline demo\n');
    expect(events.filter(event => event.type === 'task.tool-result' && event.taskId === approved.id)).toHaveLength(2);
  });

  it('screens secrets in arguments and outputs, bounds large results, and reports server errors as failed calls', async () => {
    await runtime.dispatch('mcp.save', config({ readOnlyTools: ['echo', 'secret_echo', 'huge', 'fail'] }));
    const provider = new ScriptProvider([[
      { id: 'c1', name: 'mcp__fixture__secret_echo', arguments: {} },
      { id: 'c3', name: 'mcp__fixture__huge', arguments: { bytes: 200000 } },
      { id: 'c4', name: 'mcp__fixture__echo', arguments: 'not-an-object' },
      { id: 'c5', name: 'mcp__fixture__missing', arguments: {} },
      { id: 'c6', name: 'mcp__fixture__fail', arguments: {} }
    ], [], [{ id: 'c2', name: 'mcp__fixture__echo', arguments: { text: 'leak api_key=abcdef123456' } }]]);
    await withProvider(provider);
    runtime.setCredential(FAKE_PROFILE_ID, CANARY);
    // A bounded 64 KB result still has to fit the conservative context reservation of the next request.
    store.saveProfile({ ...store.profile(FAKE_PROFILE_ID)!, contextLimit: 400000 });
    const task = await codingTask();
    await runtime.dispatch('task.send', { taskId: task.id, content: 'go' }); await done(task.id);
    expect(store.task(task.id).status).toBe('idle');
    const byId = Object.fromEntries(provider.results.map(result => [result.id, result]));
    expect(byId.c1).toMatchObject({ isError: false, content: 'canary=[REDACTED]' });
    expect(byId.c3?.isError).toBe(false);
    expect(byId.c3?.content).toContain('[MCP output truncated');
    expect(Buffer.byteLength(byId.c3!.content, 'utf8')).toBeLessThan(70 * 1024);
    expect(byId.c4).toMatchObject({ isError: true, content: expect.stringContaining('JSON object') });
    expect(byId.c5).toMatchObject({ isError: true, content: 'Tool is not available.' });
    // A server-reported error from an allowlisted tool is a known failure, not an unknown outcome, and leaves no approval record.
    expect(byId.c6).toMatchObject({ isError: true, content: 'fixture failure' });
    expect(store.approvals(task.id)).toEqual([]);
    expect(JSON.stringify(store.detail(task.id))).not.toContain(CANARY);
    expect(JSON.stringify(store.providerState(task.id))).not.toContain(CANARY);
    expect(JSON.stringify(events)).not.toContain(CANARY);
    // Secret-like model output is refused before any external tool runs: the whole response is discarded and the task stops visibly.
    const leaking = await codingTask();
    await runtime.dispatch('task.send', { taskId: leaking.id, content: 'go' }); await done(leaking.id);
    expect(store.task(leaking.id).status).toBe('failed');
    expect(provider.results.some(result => result.id === 'c2')).toBe(false);
    expect(store.approvals(leaking.id)).toEqual([]);
    expect(store.detail(leaking.id).messages.at(-1)?.content ?? '').not.toContain('abcdef123456');
  });

  it('treats an approved call that times out as an unknown outcome, never replays it, and restarts the server for later calls', async () => {
    await runtime.dispatch('mcp.save', config({ readOnlyTools: ['echo'] }));
    const provider = new ScriptProvider([[{ id: 's1', name: 'mcp__fixture__slow', arguments: { ms: 4000 } }], [{ id: 'e1', name: 'mcp__fixture__echo', arguments: { text: 'after' } }]]);
    await withProvider(provider);
    const task = await codingTask();
    await runtime.dispatch('task.send', { taskId: task.id, content: 'go' });
    const slow = await proposal(task.id); await decide(slow); await done(task.id);
    expect(store.approval(slow.id)).toMatchObject({ state: 'unknown', result: { isError: true, content: expect.stringContaining('timed out') } });
    expect(store.task(task.id).status).toBe('failed');
    await expect(runtime.dispatch('task.send', { taskId: task.id, content: 'again' })).rejects.toThrow('unknown mutation outcome');
    await expect(runtime.dispatch('task.compact', { taskId: task.id })).rejects.toThrow('unknown mutation outcome');
    expect(store.compactions(task.id)).toEqual([]);
    const checked = await runtime.dispatch('approval.reconcile', { taskId: task.id, approvalId: slow.id }) as Approval;
    expect(checked.state).toBe('unknown'); expect(checked.result?.content).toContain('not be replayed');
    // A fresh task uses a freshly started server after the stuck one was terminated.
    const next = await codingTask();
    await runtime.dispatch('task.send', { taskId: next.id, content: 'go' }); await done(next.id);
    expect(provider.results.find(result => result.id === 'e1')).toMatchObject({ isError: false, content: 'echo: after' });
    expect(store.task(next.id).status).toBe('idle');
  });

  it('revokes a pending MCP approval when the runtime stops and never executes it afterwards', async () => {
    await runtime.dispatch('mcp.save', config());
    const task = await codingTask();
    await runtime.dispatch('task.send', { taskId: task.id, content: '/mcp-demo' });
    const write = await proposal(task.id);
    // A graceful stop cancels the waiting turn (revoking its decision); a hard crash would leave it for restart recovery to revoke.
    await runtime.shutdown();
    store = new Store(join(directory, 'state', 'workspace.db'));
    runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event));
    expect(store.approval(write.id).state).toBe('revoked');
    expect(store.task(task.id).status).toBe('cancelled');
    await expect(runtime.dispatch('approval.decide', { taskId: task.id, approvalId: write.id, nonce: write.nonce, decision: 'approve' })).rejects.toThrow('stale');
    await expect(stat(notes)).rejects.toThrow();
    // The interrupted call is answered with an explicit error on the next turn, not replayed.
    await runtime.dispatch('task.send', { taskId: task.id, content: 'continue' }); await done(task.id);
    expect(store.task(task.id).status).toBe('idle');
    expect(store.approvals(task.id)).toHaveLength(1);
    await expect(stat(notes)).rejects.toThrow();
  });

  it('terminates the server and its descendants through the Job Object on shutdown', async () => {
    await runtime.dispatch('mcp.save', config({ readOnlyTools: ['spawn_child'] }));
    const provider = new ScriptProvider([[{ id: 'p1', name: 'mcp__fixture__spawn_child', arguments: {} }]]);
    await withProvider(provider);
    const task = await codingTask();
    await runtime.dispatch('task.send', { taskId: task.id, content: 'go' }); await done(task.id);
    const pid = (JSON.parse(provider.results.find(result => result.id === 'p1')!.content) as { pid: number }).pid;
    expect(alive(pid)).toBe(true);
    await runtime.shutdown();
    await waitFor(() => !alive(pid), 10000);
    store = new Store(join(directory, 'state', 'workspace.db'));
    runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), () => {});
  });
});
