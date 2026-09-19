import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CompactionRecord, ModelProfile, ProviderAdapter, ProviderEvent, ProviderRequest, Task, UsageReport } from '../../packages/protocol/src/index';
import { RuntimeService, profileFingerprint } from '../../packages/runtime/src/service';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';

let directory: string; let store: Store; let runtime: RuntimeService; let project: string;
const events: { type: string; taskId?: string; data: unknown }[] = [];
const requests: ProviderRequest[] = [];
function git(...args: string[]): string { return execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }

/** Chat-style provider: echoes the last user message, reports usage with cache detail, and keeps a Chat-Completions-shaped native continuation the way the real adapter does. */
const chatProvider: ProviderAdapter = {
  probe: async () => { throw new Error('not used'); },
  async *streamTurn(request): AsyncIterable<ProviderEvent> {
    requests.push(request);
    const previous = request.continuation ? (request.continuation.data as { messages: Record<string, unknown>[]; calls: { id: string; name: string }[] }) : undefined;
    const messages: Record<string, unknown>[] = previous ? [...previous.messages] : request.messages.map(message => ({ role: message.role, content: message.content }));
    if (previous) {
      for (const result of request.toolResults ?? []) messages.push({ role: 'tool', tool_call_id: result.id, content: result.content });
      messages.push(...request.messages.map(message => ({ role: message.role, content: message.content })));
    }
    const lastUser = [...request.messages].reverse().find(message => message.role === 'user')?.content ?? '';
    if (request.tools?.length && lastUser.startsWith('/read') && !(request.toolResults?.length)) {
      const call = { id: `call-${requests.length}`, name: 'read_file', arguments: { path: 'hello.txt' } };
      yield { type: 'tool_call', call };
      yield { type: 'usage', inputTokens: 40, outputTokens: 5 };
      yield { type: 'done', continuation: { apiKind: 'chat-completions', data: { messages: [...messages, { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }], calls: [call] } } };
      return;
    }
    const text = `Reply: ${lastUser.slice(0, 200)}`;
    yield { type: 'text', text };
    yield { type: 'usage', inputTokens: 30, outputTokens: 7, cacheReadTokens: 12, cacheCreationTokens: 3 };
    yield { type: 'done', ...(request.tools ? { continuation: { apiKind: 'chat-completions', data: { messages: [...messages, { role: 'assistant', content: text }], calls: [] } } } : {}) };
  }
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-compaction-')); project = join(directory, 'source'); await mkdir(project);
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'hello.txt'), 'original\n'); git('add', 'hello.txt'); git('commit', '-m', 'fixture');
  store = new Store(join(directory, 'state', 'workspace.db'));
  runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event), () => chatProvider);
  events.length = 0; requests.length = 0;
});
afterEach(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });

const waitDone = async (id: string): Promise<void> => { await expect.poll(() => store.task(id).status, { timeout: 5000 }).not.toBe('running'); };
const send = async (id: string, content: string): Promise<void> => { await runtime.dispatch('task.send', { taskId: id, content }); await waitDone(id); };

describe('controlled compaction and usage visibility', () => {
  it('warns at 80% of the context limit, compacts retained history into a summary, and keeps every original message', async () => {
    const profile = store.profile(FAKE_PROFILE_ID)!;
    store.saveProfile({ ...profile, contextLimit: 8192, outputLimit: 64 });
    const task = await runtime.dispatch('task.create', { title: 'Compaction', projectPath: project, profileId: FAKE_PROFILE_ID, tokenBudget: 1000000 }) as Task;
    const filler = (index: number): string => `Turn ${index}: ${'lorem ipsum '.repeat(100).trim()}`;
    for (let index = 1; index <= 4; index++) await send(task.id, filler(index));
    expect(events.filter(event => event.type === 'task.context-warning' && event.taskId === task.id)).toHaveLength(0);
    await send(task.id, filler(5));
    const warning = events.find(event => event.type === 'task.context-warning' && event.taskId === task.id);
    expect(warning).toBeDefined();
    expect((warning!.data as { percent: number }).percent).toBeGreaterThanOrEqual(80);
    const before = await runtime.dispatch('task.usage', { taskId: task.id }) as UsageReport;
    expect(before.contextPercent).toBeGreaterThanOrEqual(80);
    expect(before.totals).toMatchObject({ requests: 5, knownRequests: 5, unknownRequests: 0, prompt: 150, completion: 35, cacheRead: 60, cacheCreation: 15, reservedUnknown: 0 });
    expect(before.records).toHaveLength(5);
    expect(before.records[0]).toMatchObject({ usageKnown: true, promptTokens: 30, completionTokens: 7, cacheReadTokens: 12, cacheCreationTokens: 3 });

    const record = await runtime.dispatch('task.compact', { taskId: task.id, keepRecent: 2 }) as CompactionRecord;
    expect(record.messageIds).toHaveLength(8);
    expect(record.summary).toContain('runtime-generated');
    expect(record.summary).toContain('Turn 1');
    expect(record.estimatedTokensAfter).toBeLessThan(record.estimatedTokensBefore);
    expect(events.some(event => event.type === 'task.compacted' && event.taskId === task.id)).toBe(true);
    // Originals are retained; the detail exposes the compaction range for display.
    expect(store.detail(task.id).messages).toHaveLength(10);
    expect(store.detail(task.id).compactions?.[0]?.id).toBe(record.id);
    const after = await runtime.dispatch('task.usage', { taskId: task.id }) as UsageReport;
    expect(after.estimatedContextTokens).toBeLessThan(before.estimatedContextTokens);
    expect(after.compactions).toHaveLength(1);

    await send(task.id, 'After compaction');
    const request = requests[requests.length - 1]!;
    expect(request.messages[0]).toEqual({ role: 'user', content: record.summary });
    expect(request.messages.map(message => message.content)).not.toContain(filler(1));
    expect(request.messages.map(message => message.content)).toContain(filler(5));
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'After compaction' });
    await expect(runtime.dispatch('task.compact', { taskId: task.id, keepRecent: 20 })).rejects.toThrow('Nothing to compact');
  });

  it('compacts provider-native continuation, preserves system instructions and tool units, and sends the compacted context on the next turn', async () => {
    const remote: ModelProfile = { id: '00000000-0000-4000-8000-000000000002', name: 'Chat', apiKind: 'chat-completions', endpoint: 'https://resource.openai.azure.com', deployment: 'model', credentialRef: '00000000-0000-4000-8000-000000000002', contextLimit: 200000, outputLimit: 256 };
    store.saveProfile(remote);
    runtime.setCredential(remote.id, 'fixture-credential-value');
    // Verification is recorded after the credential, exactly as a successful runtime probe would leave it.
    store.saveProfile({ ...remote, verifiedAt: new Date().toISOString(), verificationFingerprint: profileFingerprint(remote), capabilities: { streaming: true, tools: true, continuation: true, cancellation: true, usage: true } });
    const task = await runtime.dispatch('task.create', { title: 'Native', projectPath: project, profileId: remote.id, mode: 'coding', tokenBudget: 1000000 }) as Task;
    await send(task.id, '/read first'); await send(task.id, 'second turn'); await send(task.id, 'third turn');
    const state = store.providerState(task.id)!;
    const items = (state.continuation.data as { messages: Record<string, unknown>[] }).messages;
    expect(items[0]?.role).toBe('system');
    expect(items.filter(item => item.role === 'user')).toHaveLength(3);
    expect(items.some(item => item.role === 'tool')).toBe(true);

    const record = await runtime.dispatch('task.compact', { taskId: task.id, keepRecent: 2 }) as CompactionRecord;
    const compacted = (store.providerState(task.id)!.continuation.data as { messages: Record<string, unknown>[] }).messages;
    expect(compacted[0]).toEqual(items[0]);
    expect(compacted[1]).toEqual({ role: 'user', content: record.summary });
    expect(compacted[2]).toEqual({ role: 'user', content: 'third turn' });
    expect(compacted.some(item => item.role === 'tool')).toBe(false);
    expect(record.estimatedTokensAfter).toBeLessThan(record.estimatedTokensBefore);

    await send(task.id, 'fourth turn');
    const request = requests[requests.length - 1]!;
    expect((request.continuation!.data as { messages: unknown[] }).messages).toEqual(compacted);
    expect(store.task(task.id).status).toBe('idle');
    expect(store.detail(task.id).messages.filter(message => message.role === 'user')).toHaveLength(4);
  });

  it('refuses to compact while a response is active and never persists an invalid compacted context', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ProviderAdapter = { probe: chatProvider.probe, async *streamTurn(request) { yield { type: 'text', text: 'partial' }; await gate; request.signal.throwIfAborted(); yield { type: 'done' }; } };
    await runtime.shutdown(); store = new Store(join(directory, 'state', 'workspace.db'));
    runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event), () => slow);
    const task = await runtime.dispatch('task.create', { title: 'Busy', projectPath: project, profileId: FAKE_PROFILE_ID, tokenBudget: 100000 }) as Task;
    await runtime.dispatch('task.send', { taskId: task.id, content: 'start' });
    await expect(runtime.dispatch('task.compact', { taskId: task.id })).rejects.toThrow('active response');
    release(); await waitDone(task.id);
    // A completed request without a usage report keeps its full conservative reservation and is counted as unknown.
    const usage = await runtime.dispatch('task.usage', { taskId: task.id }) as UsageReport;
    expect(usage.totals).toMatchObject({ requests: 1, knownRequests: 0, unknownRequests: 1, prompt: 0, completion: 0 });
    expect(usage.totals.reservedUnknown).toBeGreaterThan(0);
    expect(usage.records[0]).toMatchObject({ usageKnown: false, reason: expect.stringContaining('without reporting usage') });
    // A corrupted native state (pending call without its assistant turn) fails validation and leaves the record untouched.
    const profile = store.profile(FAKE_PROFILE_ID)!;
    const coding = await runtime.dispatch('task.create', { title: 'Corrupt', projectPath: project, profileId: FAKE_PROFILE_ID, mode: 'coding', tokenBudget: 100000 }) as Task;
    for (let index = 1; index <= 4; index++) store.saveMessage({ id: `m${index}`, taskId: coding.id, role: index % 2 ? 'user' : 'assistant', content: `msg ${index}`, createdAt: new Date().toISOString(), status: 'complete' });
    const broken = { fingerprint: profileFingerprint(profile), continuation: { apiKind: 'chat-completions' as const, data: { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }], calls: [{ id: 'ghost', name: 'read_file', arguments: {} }] } }, pending: [], results: [] };
    store.saveProviderState(coding.id, broken);
    await expect(runtime.dispatch('task.compact', { taskId: coding.id, keepRecent: 1 })).rejects.toThrow('failed provider continuation validation');
    expect(store.providerState(coding.id)).toEqual(broken);
    expect(store.compactions(coding.id)).toEqual([]);
  });

  it('refuses compaction when the summary would not reduce context size', async () => {
    const task = await runtime.dispatch('task.create', { title: 'Tiny', projectPath: project, profileId: FAKE_PROFILE_ID, tokenBudget: 100000 }) as Task;
    await send(task.id, 'short 1');
    await send(task.id, 'short 2');
    await send(task.id, 'short 3');
    await expect(runtime.dispatch('task.compact', { taskId: task.id, keepRecent: 1 })).rejects.toThrow('would not reduce context size');
  });

  it('synthesizes unknown usage records during recovery when process restarts during an active request', async () => {
    const task = await runtime.dispatch('task.create', { title: 'Crash', projectPath: project, profileId: FAKE_PROFILE_ID, tokenBudget: 100000 }) as Task;
    // Durably charge an in-flight request directly in SQLite as if a crash occurred while running
    store.saveTask({ ...store.task(task.id), status: 'running', usedTokens: 5000 });
    expect(store.usageRecords(task.id).records).toHaveLength(0);
    // Shut down the active runtime so SQLite is unlocked
    await runtime.shutdown();
    // Simulate process recovery by opening a fresh Store
    const freshStore = new Store(join(directory, 'state', 'workspace.db'));
    try {
      const recoveredTask = freshStore.task(task.id);
      expect(recoveredTask.status).toBe('interrupted');
      expect(recoveredTask.usedTokens).toBe(5000);
      const totals = freshStore.usageTotals(task.id);
      expect(totals.requests).toBe(1);
      expect(totals.unknownRequests).toBe(1);
      expect(totals.knownRequests).toBe(0);
      expect(totals.reservedUnknown).toBe(5000);
      const records = freshStore.usageRecords(task.id);
      expect(records.records).toHaveLength(1);
      expect(records.records[0]).toMatchObject({
        usageKnown: false,
        reservedTokens: 5000,
        reason: expect.stringContaining('Runtime restarted before usage was recorded')
      });
    } finally {
      freshStore.close();
    }
  });
});
