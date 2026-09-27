import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitTask, Message, Task } from '../../protocol/src/index';
import type { TaskCursor } from '../../protocol/src/workspace';
import { Redactor } from '../src/redaction';
import { PHASE4_SCHEMA, V1_SCHEMA, V2_MIGRATION, V3_MIGRATION } from '../src/schema';
import { FAKE_PROFILE_ID, Store } from '../src/store';
import { WorkspaceQueries } from '../src/workspace-queries';

let directory: string;
const stores: Store[] = [];
const open = (name: string): Store => { const store = new Store(join(directory, name)); stores.push(store); return store; };
const task = (n: number, changes: Partial<GitTask> = {}): GitTask => ({
  id: randomUUID(), title: `Task ${n}`, workspaceKind: 'git', projectPath: 'C:\\project', worktreePath: 'C:\\worktree', branch: `codex/task/${n}`,
  baseCommit: 'a'.repeat(40), profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), tokenBudget: 1000, usedTokens: 0, mode: 'chat', ...changes
});
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'foundry-workspace-queries-')); });
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await rm(directory, { recursive: true, force: true }); });

describe('workspace read projections', () => {
  it('keeps timeline pages bounded after redaction expands retained payloads', () => {
    const store = open('event-bounds.db'); const redactor = new Redactor(); redactor.add('Qv8!');
    const queries = new WorkspaceQueries(store, redactor); const item = task(0); store.saveTask(item);
    for (let index = 0; index < 65; index++) store.event('fixture.recorded', { content: 'Qv8!'.repeat(950) }, item.id);
    const first = queries.dispatch('task.timeline', { taskId: item.id }) as { events: { type: string; data: unknown }[]; nextBefore: number | null };
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
    expect(first.events).toHaveLength(50); expect(first.events.every(event => (event.data as { truncated?: boolean }).truncated)).toBe(true);
    const second = queries.dispatch('task.timeline', { taskId: item.id, before: first.nextBefore! }) as typeof first;
    expect([...first.events, ...second.events].filter(event => event.type === 'fixture.recorded')).toHaveLength(65);
    const forward = queries.dispatch('workspace.events', {}) as typeof first;
    expect(Buffer.byteLength(JSON.stringify(forward))).toBeLessThan(256 * 1024);
    expect(JSON.stringify(forward)).not.toContain('Qv8!');
  });
  it('pages every existing profile within bounded responses and supports exact profile reads', () => {
    const store = open('profiles.db'), queries = new WorkspaceQueries(store, new Redactor());
    const original = store.profile(FAKE_PROFILE_ID)!;
    const ids = Array.from({ length: 110 }, () => randomUUID());
    for (const id of ids) store.saveProfile({ ...original, id, name: id, endpoint: 'x'.repeat(2048) });
    const summary = queries.dispatch('workspace.summary', {}) as { profiles: { id: string }[]; nextProfileAfter: string | null };
    expect(summary.profiles).toHaveLength(25); expect(summary.nextProfileAfter).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(256 * 1024);
    const seen = [...summary.profiles.map(profile => profile.id)]; let after = summary.nextProfileAfter;
    while (after) {
      const page = queries.dispatch('workspace.profiles', { after, limit: 50 }) as { profiles: { id: string }[]; nextAfter: string | null };
      expect(page.profiles.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(128 * 1024);
      seen.push(...page.profiles.map(profile => profile.id)); after = page.nextAfter;
    }
    expect(seen).toEqual([...ids, FAKE_PROFILE_ID].sort());
    expect((queries.dispatch('profile.read', { profileId: ids[0] }) as { id: string }).id).toBe(ids[0]);
    expect(queries.dispatch('profile.read', { profileId: randomUUID() })).toBeNull();
  });
  it('commits canonical transition events with state and rolls them back together', () => {
    const store = open('events.db'); const root = task(1);
    expect(() => store.transaction(() => { store.saveTask(root); throw new Error('rollback'); })).toThrow('rollback');
    expect(store.db.prepare('SELECT id FROM tasks WHERE id = ?').get(root.id)).toBeUndefined();
    expect(store.lastEvent('task.created', root.id)).toBeUndefined();
    store.saveTask(root);
    store.saveTask({ ...root, status: 'running' });
    store.saveTask({ ...root, status: 'idle' });
    expect(store.lastEvent('task.started', root.id)?.data).toMatchObject({ status: 'running' });
    expect(store.lastEvent('task.started', root.id)).toMatchObject({ version: 1, source: 'runtime', rootTaskId: root.id });
    expect(store.lastEvent('task.completed', root.id)?.data).toMatchObject({ status: 'idle' });
    const message: Message = { id: randomUUID(), taskId: root.id, role: 'assistant', content: 'finished', createdAt: root.createdAt, status: 'streaming' };
    store.saveMessage(message); expect(store.lastEvent('message.completed', root.id)).toBeUndefined();
    store.saveMessage({ ...message, status: 'complete' });
    expect(store.lastEvent('message.completed', root.id)?.data).toMatchObject({ messageId: message.id });
  });

  it('keeps archive visibility separate from task status and preserves pending approvals', () => {
    const store = open('workspace.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(1, { status: 'running' }); store.saveTask(root);
    store.saveApproval({ id: randomUUID(), taskId: root.id, tool: 'run_command', state: 'awaiting-approval', nonce: randomUUID(), createdAt: root.createdAt, command: 'echo safe' } as Parameters<Store['saveApproval']>[0]);
    const archived = queries.dispatch('task.setArchived', { taskId: root.id, archived: true }) as Task;
    expect(archived.status).toBe('running'); expect(archived.archivedAt).toBeTruthy();
    expect(store.approvals(root.id)[0]?.state).toBe('awaiting-approval');
    expect((queries.dispatch('workspace.tasks', { visibility: 'active' }) as { tasks: Task[] }).tasks).toEqual([]);
    expect((queries.dispatch('workspace.tasks', { visibility: 'archived' }) as { tasks: Task[] }).tasks[0]?.id).toBe(root.id);
    const actions = queries.dispatch('workspace.actions', {}) as { items: { taskId: string; archived: boolean; state: string }[] };
    expect(actions.items).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: root.id, archived: true, state: 'awaiting-approval' })]));
    const restored = queries.dispatch('task.setArchived', { taskId: root.id, archived: false }) as Task;
    expect(restored.archivedAt).toBeUndefined(); expect(store.approvals(root.id)[0]?.state).toBe('awaiting-approval');
  });

  it('pages global actions including archived running work and unlinked unknown intents', () => {
    const store = open('actions.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(1, { mode: 'coordinated', status: 'running' });
    const child = task(2, { parentTaskId: root.id, rootTaskId: root.id });
    store.saveTask(root); store.saveTask(child);
    queries.dispatch('task.setArchived', { taskId: root.id, archived: true });
    const approvalId = randomUUID();
    store.saveApproval({ id: approvalId, taskId: child.id, tool: 'run_command', state: 'awaiting-approval', nonce: randomUUID(), createdAt: child.createdAt, command: 'echo safe' } as Parameters<Store['saveApproval']>[0]);
    for (let i = 0; i < 55; i++) store.db.prepare('INSERT INTO intents(id, kind, data, state) VALUES(?,?,?,?)')
      .run(randomUUID(), 'worktree.create', JSON.stringify({ createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString() }), 'unknown');
    for (let i = 0; i < 65; i++) store.event('task.completed', { status: 'idle' }, root.id);
    const firstPage = queries.dispatch('workspace.actions', { limit: 20 }) as { items: { kind: string; tier: number }[]; counts: { needsDecision: number; inProgress: number; recent: number } };
    expect(firstPage.items[0]?.tier).toBe(0);
    expect(firstPage.counts).toMatchObject({ needsDecision: 56, inProgress: 1, recent: 65 });
    const seen = new Set<string>(); let cursor: { tier: 0 | 1 | 2; at: string; id: string } | null = null;
    do {
      const page = queries.dispatch('workspace.actions', { limit: 20, ...(cursor ? { cursor } : {}) }) as { items: { id: string; taskId: string | null; sourceTaskId?: string; sourceId: string; archived: boolean; kind: string }[]; nextCursor: { tier: 0 | 1 | 2; at: string; id: string } | null };
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
      for (const item of page.items) { expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
      const approval = page.items.find(item => item.sourceId === approvalId);
      if (approval) expect(approval).toMatchObject({ taskId: root.id, sourceTaskId: child.id, archived: true, kind: 'approval' });
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(122);
  });

  it('bounds approval evidence and retrieves the full retained review by chunks', () => {
    const store = open('approval.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(1); store.saveTask(root);
    const approvalId = randomUUID();
    store.saveApproval({ id: approvalId, taskId: root.id, toolCallId: randomUUID(), nonce: randomUUID(), tool: 'edit_file',
      state: 'awaiting-approval', createdAt: root.createdAt, summary: 'Review full patch', fingerprint: 'a'.repeat(64),
      before: '🧪'.repeat(50_000), after: '🧪'.repeat(50_000) });
    const read = queries.dispatch('approval.get', { taskId: root.id, approvalId }) as { approval: { nonce: string; before?: string }; truncatedFields: string[]; fullBytes: number };
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(256 * 1024);
    expect(read.truncatedFields).toContain('full'); expect(read.approval.before).toBeUndefined();
    let offset = 0, full = '';
    do { const chunk = queries.dispatch('approval.content', { taskId: root.id, approvalId, field: 'full', offset }) as { content: string; nextOffset: number | null };
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(256 * 1024);
      full += chunk.content; offset = chunk.nextOffset ?? -1;
    } while (offset >= 0);
    const restored = JSON.parse(full) as { before: string; after: string; nonce: string };
    expect(restored.before).toBe('🧪'.repeat(50_000)); expect(restored.after).toBe('🧪'.repeat(50_000));
    expect(restored.nonce).toBe(read.approval.nonce);
  });

  it('indexes updated messages transactionally and finds child text through its root', () => {
    const store = open('search.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(1, { mode: 'coordinated' }), child = task(2, { parentTaskId: root.id, rootTaskId: root.id });
    store.saveTask(root); store.saveTask(child);
    const message: Message = { id: randomUUID(), taskId: child.id, role: 'assistant', content: 'first search phrase', createdAt: root.createdAt, status: 'complete' };
    store.saveMessage(message);
    expect((queries.dispatch('workspace.search', { query: 'first search' }) as { hits: { taskId: string; rootTaskId: string }[] }).hits[0]).toMatchObject({ taskId: child.id, rootTaskId: root.id });
    store.saveMessage({ ...message, content: 'replacement phrase' });
    expect((queries.dispatch('workspace.search', { query: 'first search' }) as { hits: unknown[] }).hits).toEqual([]);
    expect((queries.dispatch('workspace.search', { query: 'replacement phrase' }) as { hits: { messageId: string }[] }).hits[0]?.messageId).toBe(message.id);
    expect((queries.dispatch('workspace.search', { query: 'replacement phrase', status: 'running' }) as { hits: unknown[] }).hits).toEqual([]);
    store.saveTask({ ...root, status: 'running' });
    expect((queries.dispatch('workspace.search', { query: 'replacement phrase', status: 'running' }) as { hits: { messageId: string }[] }).hits[0]?.messageId).toBe(message.id);
  });

  it('bounds serialized pages and chunks legacy large Unicode messages', () => {
    const store = open('messages.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(1); store.saveTask(root);
    const message: Message = { id: randomUUID(), taskId: root.id, role: 'assistant', content: '🧪'.repeat(130_000), createdAt: root.createdAt, status: 'complete' };
    store.saveMessage(message);
    const page = queries.dispatch('task.messages', { taskId: root.id }) as { items: { message: Message & { truncated?: boolean } }[] };
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
    expect(page.items[0]?.message.truncated).toBe(true);
    let offset = 0, restored = '';
    do {
      const chunk = queries.dispatch('task.messageContent', { taskId: root.id, messageId: message.id, offset }) as { content: string; nextOffset: number | null };
      restored += chunk.content; offset = chunk.nextOffset ?? -1;
    } while (offset >= 0);
    expect(restored).toBe(message.content);
  });

  it('retrieves control-heavy message and compaction text without oversized serialized chunks', () => {
    const store = open('escaped-chunks.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(1); store.saveTask(root);
    const content = '\u0000\u0001\n\t🧪'.repeat(25_000);
    const message: Message = { id: randomUUID(), taskId: root.id, role: 'assistant', content, createdAt: root.createdAt, status: 'complete' };
    store.saveMessage(message);
    const compactionId = randomUUID();
    store.saveCompaction({ id: compactionId, taskId: root.id, fromOrdinal: 1, toOrdinal: 1,
      messageIds: [message.id], summary: content, estimatedTokensBefore: 100, estimatedTokensAfter: 20, createdAt: root.createdAt }, undefined, undefined);
    for (const method of ['task.messageContent', 'task.compactionContent'] as const) {
      let offset = 0, restored = '', chunks = 0;
      do {
        const params = method === 'task.messageContent' ? { taskId: root.id, messageId: message.id, offset } : { taskId: root.id, compactionId, offset };
        const chunk = queries.dispatch(method, params) as { content: string; offset: number; nextOffset: number | null; totalBytes: number };
        expect(Buffer.byteLength(JSON.stringify(chunk), 'utf8')).toBeLessThanOrEqual(256 * 1024);
        expect(chunk.offset).toBe(offset);
        expect(chunk.nextOffset === null || chunk.nextOffset > offset).toBe(true);
        restored += chunk.content; offset = chunk.nextOffset ?? -1; chunks++;
      } while (offset >= 0);
      expect(chunks).toBeGreaterThan(1);
      expect(restored).toBe(content);
    }
  });

  it('bounds control-heavy usage and compaction marker pages without losing records', () => {
    const store = open('escaped-pages.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(1); store.saveTask(root);
    const profile = store.profile(FAKE_PROFILE_ID)!;
    for (let i = 0; i < 60; i++) {
      const requestId = randomUUID(); store.usage.beginUsage(requestId, root, profile, 1, 'conversation');
      store.usage.attemptUsage(requestId); store.usage.finishUsage(requestId, undefined, 'failed', '\u0000'.repeat(1000));
      store.saveCompaction({ id: randomUUID(), taskId: root.id, fromOrdinal: i, toOrdinal: i + 1,
        messageIds: [], summary: '\u0000'.repeat(3000), estimatedTokensBefore: 1, estimatedTokensAfter: 1, createdAt: root.createdAt }, undefined, undefined);
    }
    for (const method of ['task.usageRecords', 'task.compactions'] as const) {
      let before: number | undefined, seen = 0, pages = 0;
      do {
        const page = queries.dispatch(method, { taskId: root.id, before, limit: 50 }) as
          { records?: unknown[]; compactions?: unknown[]; nextBefore: number | null };
        expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(256 * 1024);
        seen += (page.records ?? page.compactions ?? []).length; pages++;
        before = page.nextBefore ?? undefined;
      } while (before !== undefined);
      expect(pages).toBeGreaterThan(1); expect(seen).toBe(60);
    }
  });

  it('reads canonical requests with coordinated children, probes, and distinct reservation states', () => {
    const store = open('canonical-usage.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(1, { mode: 'coordinated', role: 'coordinator' }); root.rootTaskId = root.id;
    const child = task(2, { mode: 'coding', role: 'child', parentTaskId: root.id, rootTaskId: root.id });
    store.saveTask(root); store.saveTask(child);
    const profile = store.profile(FAKE_PROFILE_ID)!;
    const known = randomUUID(); store.usage.beginUsage(known, root, profile, 50, 'conversation'); store.usage.attemptUsage(known);
    store.usage.finishUsage(known, { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 }, 'completed');
    const unknown = randomUUID(); store.usage.beginUsage(unknown, child, profile, 40, 'conversation'); store.usage.attemptUsage(unknown);
    store.usage.finishUsage(unknown, undefined, 'failed', 'Provider did not report usage.');
    const notSent = randomUUID(); store.usage.beginUsage(notSent, child, profile, 30, 'conversation'); store.usage.finishUsage(notSent, undefined, 'cancelled');
    const pending = randomUUID(); store.usage.beginUsage(pending, child, profile, 20, 'conversation');
    const probe = randomUUID(); store.usage.beginUsage(probe, undefined, profile, 10, 'probe'); store.usage.attemptUsage(probe);
    store.usage.finishUsage(probe, { type: 'usage', inputTokens: 3, outputTokens: 1 }, 'completed');
    const page = queries.dispatch('task.usageRecords', { taskId: root.id, limit: 2 }) as { records: { id: string; outcome: string; attemptedAt: string | null }[]; nextBefore: number | null };
    const older = queries.dispatch('task.usageRecords', { taskId: root.id, before: page.nextBefore, limit: 2 }) as typeof page;
    expect([...page.records, ...older.records].map(record => record.id).sort()).toEqual([known, unknown, notSent].sort());
    expect([...page.records, ...older.records].find(record => record.id === notSent)).toMatchObject({ outcome: 'cancelled', attemptedAt: null });
    expect((queries.dispatch('task.usageRecords', { taskId: child.id }) as typeof page).records.map(record => record.id).sort()).toEqual([unknown, notSent].sort());
    const taskTrend = queries.dispatch('workspace.usageTrend', { groupBy: 'task', taskId: root.id }) as { buckets: unknown[] };
    expect(taskTrend.buckets).toEqual([expect.objectContaining({ key: root.id, requests: 4, knownRequests: 1, unknownRequests: 1,
      pendingRequests: 1, notSentRequests: 1, observedPrompt: 10, observedCompletion: 5, cacheRead: 2,
      reservedUnknown: 40, reservedPending: 20, reservedNotSent: 30 })]);
    const day = queries.dispatch('workspace.usageTrend', { groupBy: 'day' }) as { buckets: { requests: number; knownRequests: number }[] };
    expect(day.buckets[0]).toMatchObject({ requests: 5, knownRequests: 2 });
    const profileTrend = queries.dispatch('workspace.usageTrend', { groupBy: 'profile', profileId: profile.id }) as { buckets: { key: string; requests: number }[] };
    expect(profileTrend.buckets).toEqual([expect.objectContaining({ key: profile.id, requests: 5 })]);
  });

  it('shows migrated legacy usage once alongside new canonical requests', async () => {
    const path = join(directory, 'migrated-usage.db'), db = new Database(path);
    db.exec(V1_SCHEMA); db.exec(V2_MIGRATION); db.exec(V3_MIGRATION); db.exec(PHASE4_SCHEMA); db.pragma('user_version = 3'); db.close();
    const store = open('migrated-usage.db'); const root = task(1); store.saveTask(root);
    const legacyId = randomUUID(); store.saveUsageRecord({ id: randomUUID(), taskId: root.id, requestId: legacyId, reservedTokens: 40,
      promptTokens: null, completionTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
      usageKnown: false, reason: 'Legacy unknown', createdAt: new Date().toISOString() });
    await store.upgradeToCurrent();
    const nextId = randomUUID(), profile = store.profile(FAKE_PROFILE_ID)!;
    store.usage.beginUsage(nextId, root, profile, 50, 'conversation'); store.usage.attemptUsage(nextId);
    store.usage.finishUsage(nextId, { type: 'usage', inputTokens: 10, outputTokens: 5 }, 'completed');
    const queries = new WorkspaceQueries(store, new Redactor());
    const records = queries.dispatch('task.usageRecords', { taskId: root.id }) as { records: { requestId: string }[] };
    expect(records.records).toHaveLength(2);
    expect(records.records.map(record => record.requestId).sort()).toEqual([legacyId, nextId].sort());
    const trend = queries.dispatch('workspace.usageTrend', { groupBy: 'task' }) as { buckets: { key: string; requests: number; knownRequests: number; unknownRequests: number }[] };
    expect(trend.buckets).toEqual([expect.objectContaining({ key: root.id, requests: 2, knownRequests: 1, unknownRequests: 1 })]);
  });

  it('pages usage and compaction markers while preserving full summaries by chunk', () => {
    const store = open('usage.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(1); store.saveTask(root);
    const profile = store.profile(FAKE_PROFILE_ID)!;
    for (let i = 0; i < 25; i++) {
      const requestId = randomUUID(); store.usage.beginUsage(requestId, root, profile, 50, 'conversation');
      store.usage.attemptUsage(requestId);
      store.usage.finishUsage(requestId, i % 2 ? { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 0 } : undefined,
        i % 2 ? 'completed' : 'failed', i % 2 ? undefined : 'Unknown');
      store.saveCompaction({ id: randomUUID(), taskId: root.id, fromOrdinal: i, toOrdinal: i + 1,
        messageIds: [randomUUID()], summary: '🧪'.repeat(70_000), estimatedTokensBefore: 100, estimatedTokensAfter: 20,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }, undefined, undefined);
    }
    const usage = queries.dispatch('task.usageRecords', { taskId: root.id, limit: 20 }) as { records: unknown[]; nextBefore: number | null };
    const markers = queries.dispatch('task.compactions', { taskId: root.id, limit: 20 }) as { compactions: { id: string; summaryTruncated: boolean }[]; nextBefore: number | null };
    expect(usage.records).toHaveLength(20); expect(markers.compactions).toHaveLength(20);
    expect(usage.nextBefore).not.toBeNull(); expect(markers.nextBefore).not.toBeNull();
    expect((queries.dispatch('task.usageRecords', { taskId: root.id, before: usage.nextBefore }) as { records: unknown[] }).records).toHaveLength(5);
    expect((queries.dispatch('task.compactions', { taskId: root.id, before: markers.nextBefore }) as { compactions: unknown[] }).compactions).toHaveLength(5);
    expect(Buffer.byteLength(JSON.stringify(markers))).toBeLessThan(256 * 1024);
    const first = markers.compactions[0]!; expect(first.summaryTruncated).toBe(true);
    let offset = 0, restored = '';
    do { const chunk = queries.dispatch('task.compactionContent', { taskId: root.id, compactionId: first.id, offset }) as { content: string; nextOffset: number | null };
      restored += chunk.content; offset = chunk.nextOffset ?? -1;
    } while (offset >= 0);
    expect(restored).toBe('🧪'.repeat(70_000));
    const day = queries.dispatch('workspace.usageTrend', { groupBy: 'day' }) as { buckets: { requests: number; knownRequests: number; unknownRequests: number; pendingRequests: number; notSentRequests: number; reservedUnknown: number; cacheRead: number }[] };
    expect(day.buckets[0]).toMatchObject({ requests: 25, knownRequests: 12, unknownRequests: 13, pendingRequests: 0, notSentRequests: 0, reservedUnknown: 650, cacheRead: 24 });
  });

  it('pages 1000 task headers and a 100000-message history by stable keys', () => {
    const store = open('scale.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(0); store.saveTask(root);
    store.transaction(() => { for (let i = 1; i < 1000; i++) store.saveTask(task(i)); });
    let cursor: TaskCursor | null = null, seen = 0;
    do {
      const page = queries.dispatch('workspace.tasks', { limit: 50, ...(cursor ? { cursor } : {}) }) as { tasks: Task[]; nextCursor: TaskCursor | null };
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
      seen += page.tasks.length; cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toBe(1000);
    const insert = store.db.prepare('INSERT INTO messages(id, task_id, data, ordinal) VALUES (?, ?, ?, ?)');
    store.transaction(() => {
      for (let ordinal = 1; ordinal <= 100_000; ordinal++) {
        const id = `m-${ordinal}`, message = { id, taskId: root.id, role: 'user', content: `message ${ordinal}`, createdAt: root.createdAt, status: 'complete' };
        insert.run(id, root.id, JSON.stringify(message), ordinal);
      }
    });
    const first = queries.dispatch('task.messages', { taskId: root.id, limit: 50 }) as { items: { ordinal: number }[]; nextBefore: number | null; through: number };
    expect(first.items.map(item => item.ordinal)).toEqual(Array.from({ length: 50 }, (_, i) => 99_951 + i));
    const second = queries.dispatch('task.messages', { taskId: root.id, limit: 50, before: first.nextBefore, through: first.through }) as { items: { ordinal: number }[] };
    expect(second.items.at(-1)?.ordinal).toBe(99_950);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
  }, 60_000);

  it('serves bounded history against an unopened legacy v1 database', () => {
    const path = join(directory, 'legacy.db'), db = new Database(path); db.exec(V1_SCHEMA); db.pragma('user_version = 1');
    const legacy = task(1); db.prepare('INSERT INTO tasks(id,data) VALUES(?,?)').run(legacy.id, JSON.stringify(legacy)); db.close();
    const store = open('legacy.db'), queries = new WorkspaceQueries(store, new Redactor());
    expect(store.schemaVersion).toBe(1);
    expect((queries.dispatch('workspace.tasks', {}) as { tasks: Task[] }).tasks[0]?.id).toBe(legacy.id);
    expect((queries.dispatch('task.messages', { taskId: legacy.id }) as { items: unknown[] }).items).toEqual([]);
    store.event('legacy.test', {}, legacy.id);
    expect((queries.dispatch('workspace.events', {}) as { events: { source: string; legacy: boolean }[] }).events[0]).toMatchObject({ source: 'legacy', legacy: true });
  });

  it('binds cursors to filters while a new task cannot disrupt an anchored history page', () => {
    const store = open('cursor.db'), queries = new WorkspaceQueries(store, new Redactor());
    for (let i = 0; i < 4; i++) store.saveTask(task(i, { title: 'Shared title' }));
    const first = queries.dispatch('workspace.tasks', { limit: 2 }) as { nextCursor: TaskCursor };
    expect(first.nextCursor).toBeTruthy();
    expect(() => queries.dispatch('workspace.tasks', { limit: 2, mode: 'coding', cursor: first.nextCursor })).toThrow('different filters');
    store.saveTask(task(9));
    const history = queries.dispatch('workspace.tasks', { limit: 2, cursor: first.nextCursor }) as { tasks: Task[] };
    expect(history.tasks).toHaveLength(2);
    expect(history.tasks.every(item => item.createdAt <= first.nextCursor.highWaterAt)).toBe(true);
    const titlePage = queries.dispatch('workspace.search', { query: 'Shared', limit: 2 }) as { hits: unknown[]; nextCursor: unknown };
    expect(titlePage.hits).toHaveLength(2); expect(titlePage.nextCursor).toBeTruthy();
    const laterMatch = task(10, { title: 'Shared title' }); store.saveTask(laterMatch);
    const unrelated = task(11); store.saveTask(unrelated);
    store.saveMessage({ id: randomUUID(), taskId: unrelated.id, role: 'assistant', content: 'unrelated streaming progress', createdAt: unrelated.createdAt, status: 'streaming' });
    const second = queries.dispatch('workspace.search', { query: 'Shared', limit: 2, cursor: titlePage.nextCursor }) as { hits: unknown[] };
    expect(second.hits).toHaveLength(2);
    expect((second.hits as { taskId: string }[]).some(hit => hit.taskId === unrelated.id)).toBe(false);
    expect((second.hits as { taskId: string }[]).some(hit => hit.taskId === laterMatch.id)).toBe(false);
    expect(() => queries.dispatch('workspace.search', { query: 'changed', limit: 2, cursor: titlePage.nextCursor })).toThrow('different filters');
  });

  it('filters history and search by stable saved-project ID', () => {
    const store = open('project-filter.db'), queries = new WorkspaceQueries(store, new Redactor());
    const projectId = randomUUID(), otherId = randomUUID();
    const first = task(1, { projectId, title: 'Shared project note' });
    const second = task(2, { projectId: otherId, title: 'Shared other note' });
    store.saveTask(first); store.saveTask(second);
    store.saveMessage({ id: randomUUID(), taskId: first.id, role: 'assistant', content: 'needle', status: 'complete', createdAt: first.createdAt });
    store.saveMessage({ id: randomUUID(), taskId: second.id, role: 'assistant', content: 'needle', status: 'complete', createdAt: second.createdAt });
    const page = queries.dispatch('workspace.tasks', { projectId }) as { tasks: Task[] };
    expect(page.tasks.map(item => item.id)).toEqual([first.id]);
    const hits = queries.dispatch('workspace.search', { query: 'needle', projectId }) as { hits: { rootTaskId: string }[] };
    expect(hits.hits.map(hit => hit.rootTaskId)).toEqual([first.id]);
  });

  it('keeps anchored FTS pages stable across unrelated streaming and new matching messages', () => {
    const store = open('search-cursor.db'), queries = new WorkspaceQueries(store, new Redactor());
    const root = task(1); store.saveTask(root);
    for (let i = 0; i < 4; i++) store.saveMessage({ id: randomUUID(), taskId: root.id, role: 'assistant',
      content: `needle result ${i}`, createdAt: root.createdAt, status: 'complete' });
    const first = queries.dispatch('workspace.search', { query: 'needle', limit: 2 }) as { hits: { messageId: string }[]; nextCursor: unknown };
    expect(first.hits).toHaveLength(2); expect(first.nextCursor).toBeTruthy();
    const unrelated = { id: randomUUID(), taskId: root.id, role: 'assistant' as const, content: 'progress', createdAt: root.createdAt, status: 'streaming' as const };
    store.saveMessage(unrelated); store.saveMessage({ ...unrelated, content: 'different progress', status: 'complete' });
    const late = randomUUID(); store.saveMessage({ id: late, taskId: root.id, role: 'assistant', content: 'needle late', createdAt: root.createdAt, status: 'complete' });
    const second = queries.dispatch('workspace.search', { query: 'needle', limit: 2, cursor: first.nextCursor }) as { hits: { messageId: string }[] };
    expect(second.hits).toHaveLength(2);
    const all = [...first.hits, ...second.hits].map(hit => hit.messageId);
    expect(new Set(all).size).toBe(4); expect(all).not.toContain(late);
  });
});
