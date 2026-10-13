import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { BrowserHostCallSchema, RpcResponseSchema } from '../../packages/protocol/src/index';
import { FAKE_PROFILE_ID } from '../../packages/runtime/src/store';

type ObjectValue = Record<string, unknown>;

// Runs both actual stdin/stdout entry points; normalization is restricted to
// generated identities and wall-clock timestamps. No expected files are written.
async function exercise(kind: 'node' | 'dotnet'): Promise<unknown> {
  const scratch = mkdtempSync(join(tmpdir(), `foundry-p2-entry-${kind}-`));
  const child = kind === 'node'
    ? spawn(process.execPath, [resolve('out/main/runtime.js')], { env: { ...process.env, FOUNDRY_WORKSPACE_DATA: scratch }, stdio: 'pipe' })
    : spawn(resolve('src/Foundry.Runtime/bin/Release/net10.0-windows/Foundry.Runtime.exe'), [], { env: { ...process.env, FOUNDRY_WORKSPACE_DATA: scratch, FOUNDRY_RUNTIME_P2_CHAT: '1' }, stdio: 'pipe' });
  const exited = once(child, 'exit');
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += String(text); });
  const reader = createInterface({ input: child.stdout }); const lines = reader[Symbol.asyncIterator]();
  const events: ObjectValue[] = [];
  const request = async (id: string, method: string, params: unknown, fragmented = false): Promise<ObjectValue> => {
    const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    if (fragmented) for (const byte of frame) child.stdin.write(Buffer.from([byte]));
    else child.stdin.write(frame);
    for (let n = 0; n < 1000; n++) {
      const next = await lines.next(); if (next.done) throw new Error(`Entry exited before reply: ${stderr}`);
      const value = JSON.parse(next.value) as ObjectValue;
      if (value.method === 'workspace.event') { events.push(value.params as ObjectValue); continue; }
      if (value.method === 'browser.host') {
        const call = BrowserHostCallSchema.parse(value); expect(call.params.kind).toBe('revoke');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, method: 'browser.host.result', result: null }) + '\n'); continue;
      }
      RpcResponseSchema.parse(value); expect(value.id).toBe(id); return value;
    }
    throw new Error('Missing bounded reply.');
  };
  try {
    const params = { requestId: '88888888-0000-4000-8000-000000000001', projectId: null, content: 'Hello 😀', profileId: FAKE_PROFILE_ID, mode: 'chat' };
    const started = await request('start', 'task.start', params, true); const taskId = (started.result as ObjectValue).id;
    const retry = await request('retry', 'task.start', params); expect((retry.result as ObjectValue).id).toBe(taskId);
    const conflict = await request('conflict', 'task.start', { ...params, content: 'different' });
    let read: ObjectValue = {};
    for (let n = 0; n < 100; n++) {
      read = await request(`read-${n}`, 'task.read', { taskId });
      if (((read.result as ObjectValue).task as ObjectValue).status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    expect(((read.result as ObjectValue).task as ObjectValue).status).toBe('idle');
    const messages = await request('messages', 'task.messages', { taskId, limit: 50 });
    const assistant = ((messages.result as ObjectValue).items as ObjectValue[]).map(item => item.message as ObjectValue).find(item => item.role === 'assistant')!;
    const content = await request('content', 'task.messageContent', { taskId, messageId: assistant.id, offset: 0, maxBytes: 65536 });
    const cancelled = await request('cancel', 'task.cancel', { taskId });
    const profilePage = await request('profiles', 'workspace.profiles', { limit: 50 });
    const profile = await request('profile', 'profile.read', { profileId: FAKE_PROFILE_ID });
    const projectPage = await request('projects', 'workspace.projects', { limit: 50 });
    const taskPage = await request('tasks', 'workspace.tasks', { limit: 50 });
    const eventPage = await request('events', 'workspace.events', { after: 0, limit: 50 });
    const timeline = await request('timeline', 'task.timeline', { taskId, limit: 50 });
    const usage = await request('usage', 'task.usageRecords', { taskId, limit: 50 });
    const compactions = await request('compactions', 'task.compactions', { taskId, limit: 50 });
    const missingCompaction = await request('missing-compaction', 'task.compactionContent', { taskId, compactionId: '12121212-0000-4000-8000-000000000299', offset: 0, maxBytes: 1 });
    const archived = await request('archive', 'task.setArchived', { taskId, archived: true });
    const paused = await request('pause-archive', 'features.set', { feature: 'archive', enabled: false });
    const deniedArchive = await request('denied-archive', 'task.setArchived', { taskId, archived: true });
    const restored = await request('restore', 'task.setArchived', { taskId, archived: false });
    const features = await request('features', 'features.get', {});
    const actions = await request('actions', 'workspace.actions', { limit: 50 });
    const search = await request('search', 'workspace.search', { query: 'Hello', limit: 1 });
    const searchNext = await request('search-next', 'workspace.search', { query: 'Hello', limit: 50, cursor: (search.result as ObjectValue).nextCursor });
    const invalidSearch = await request('invalid-search', 'workspace.search', { query: '\u0000', limit: 50 });
    const stillAlive = await request('search-alive', 'workspace.actions', { limit: 50 });
    child.stdin.end();
    for await (const line of lines) {
      const frame = JSON.parse(line) as ObjectValue;
      expect(frame.method).toBe('workspace.event'); events.push(frame.params as ObjectValue);
    }
    const [code] = await exited; expect(code).toBe(0); expect(stderr).toBe('');
    expect(events.some(item => item.type === 'task.progress' && item.sequence === 0)).toBe(true);
    const db = new Database(join(scratch, 'workspace.db'), { readonly: true });
    try {
      const messageRows = db.prepare('SELECT * FROM messages ORDER BY ordinal').all() as ObjectValue[];
      const usageRows = db.prepare('SELECT * FROM provider_requests ORDER BY rowid').all() as ObjectValue[];
      const identities = new Map<string, string>([[String(taskId), 'TASK']]);
      for (const row of messageRows) identities.set(String(row.id), `MESSAGE-${row.ordinal}`);
      for (const [index, row] of usageRows.entries()) identities.set(String(row.request_id), `REQUEST-${index}`);
      const normalize = (value: unknown): unknown => {
        if (typeof value === 'string') {
          if (identities.has(value)) return identities.get(value);
          if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return 'CLOCK';
          if (value.startsWith('{') || value.startsWith('[')) return normalize(JSON.parse(value));
          return value;
        }
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, normalize(field)]));
        return value;
      };
      return normalize({ read: read.result, messages: messages.result, content: content.result, cancel: cancelled.result, conflict: conflict.error,
        profiles: profilePage.result, profile: profile.result, projects: projectPage.result, tasksPage: taskPage.result, eventsPage: eventPage.result, timeline: timeline.result,
        usage: usage.result, compactions: compactions.result, missingCompaction: missingCompaction.error,
        archived: archived.result, paused: paused.result, deniedArchive: deniedArchive.error, restored: restored.result, features: features.result,
        actions: actions.result,
        search: search.result, searchNext: searchNext.result, invalidSearch: invalidSearch.error, stillAlive: stillAlive.result,
        tasks: db.prepare('SELECT * FROM tasks ORDER BY rowid').all(), messagesRows: messageRows, requests: usageRows,
        starts: db.prepare('SELECT * FROM task_starts ORDER BY rowid').all(), events: db.prepare('SELECT * FROM events ORDER BY sequence').all(),
        notifications: events.filter(item => item.sequence !== 0) });
    } finally { db.close(); }
  } finally {
    reader.close(); if (child.exitCode === null) { child.kill(); await exited; }
    rmSync(scratch, { recursive: true, force: true });
  }
}

it('matches Node and C# actual entry points for fake chat, retained rows and durable notifications', async () => {
  const expected = await exercise('node'); const actual = await exercise('dotnet'); expect(actual).toEqual(expected);
});
