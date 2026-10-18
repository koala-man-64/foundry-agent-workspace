import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { BrowserHostCallSchema, RpcResponseSchema } from '../../packages/protocol/src/index';
import { FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { build, committed, file, git, isolatedGitEnvironment } from './repository-fixture';

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
    const trends = [];
    for (const groupBy of ['day', 'profile', 'task']) trends.push((await request(`trend-${groupBy}`, 'workspace.usageTrend', { groupBy, taskId, limit: 50 })).result);
    const invalidTrend = await request('invalid-trend', 'workspace.usageTrend', { groupBy: 'day', from: '2027-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' });
    const recordStamp = (((usage.result as ObjectValue).records as ObjectValue[])[0]!.createdAt as string);
    const exactTrend = await request('exact-trend', 'workspace.usageTrend', { groupBy: 'task', taskId, from: recordStamp, to: recordStamp.slice(0, -1) + '000000000Z' });
    expect(((exactTrend.result as ObjectValue).buckets as ObjectValue[])[0]!.requests).toBe(1);
    const shortFractionTrend = await request('short-fraction-trend', 'workspace.usageTrend', { groupBy: 'day', from: '2026-01-02T03:04:05.1Z', to: '2026-01-02T03:04:05.12Z' });
    const schema = await request('schema', 'workspace.schema', {});
    // The complete Node runtime admits orchestration; the development C# slice
    // must advertise that deferred capability as unavailable, not grant it.
    expect((schema.result as ObjectValue).coordinatedAvailable).toBe(kind === 'node');
    const preferences = await request('preferences-save', 'workspace.preferences.save', { profileId: FAKE_PROFILE_ID, mode: 'chat', collapsedProjectIds: ['none', 'none'] });
    const deniedPreferences = await request('preferences-missing', 'workspace.preferences.save', { collapsedProjectIds: ['17171717-0000-4000-8000-000000000099'] });
    const deniedProject = await request('project-missing', 'project.update', { projectId: '17171717-0000-4000-8000-000000000099', hidden: true });
    const missingApproval = '17171717-0000-4000-8000-000000000098';
    const approvals = await request('approvals', 'task.approvals', { taskId, limit: 50 });
    const approvalsMissingTask = await request('approvals-missing-task', 'task.approvals', { taskId: '17171717-0000-4000-8000-000000000099' });
    const approvalMissing = await request('approval-missing', 'approval.get', { taskId, approvalId: missingApproval });
    const approvalContentMissing = await request('approval-content-missing', 'approval.content', { taskId, approvalId: missingApproval, field: 'full' });
    const reconcileMissing = await request('reconcile-missing', 'approval.reconcile', { taskId, approvalId: missingApproval });
    // The project channel refuses a projectless chat, its sender and an oversized message, and a missing task.
    const channelGet = await request('channel-get', 'channel.get', { taskId });
    const channelSend = await request('channel-send', 'channel.send', { taskId, requestId: '88888888-0000-4000-8000-000000000002', content: 'Hello channel' });
    const channelOversized = await request('channel-oversized', 'channel.send', { taskId, requestId: '88888888-0000-4000-8000-000000000003', content: 'x'.repeat(3000) });
    const channelMissing = await request('channel-missing', 'channel.get', { taskId: '17171717-0000-4000-8000-000000000099' });
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
        trends, invalidTrend: invalidTrend.error,
        exactTrend: exactTrend.result, shortFractionTrend: shortFractionTrend.result,
        schema: Object.fromEntries(Object.entries(schema.result as ObjectValue).filter(([key]) => key !== 'coordinatedAvailable')), preferences: preferences.result, deniedPreferences: deniedPreferences.error, deniedProject: deniedProject.error,
        approvals: approvals.result, approvalsMissingTask: approvalsMissingTask.error, approvalMissing: approvalMissing.error, approvalContentMissing: approvalContentMissing.error, reconcileMissing: reconcileMissing.error,
        channelGet: channelGet.error, channelSend: channelSend.error, channelOversized: channelOversized.error, channelMissing: channelMissing.error,
        tasks: db.prepare('SELECT * FROM tasks ORDER BY rowid').all(), messagesRows: messageRows, requests: usageRows,
        starts: db.prepare('SELECT * FROM task_starts ORDER BY rowid').all(), events: db.prepare('SELECT * FROM events ORDER BY sequence').all(),
        notifications: events.filter(item => item.sequence !== 0) });
    } finally { db.close(); }
  } finally {
    reader.close(); if (child.exitCode === null) { child.kill(); await exited; }
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A Git-project chat through both entry points: a worktree-backed start, the offline channel demo's tool loop, a second
// agent whose first request carries the broadcast, and the channel page. Both runtimes run Git with the same isolated
// configuration. Scratch paths, generated identities (in order of appearance), wall-clock timestamps and the project key
// are normalized; nothing else is.
async function exerciseGit(kind: 'node' | 'dotnet'): Promise<unknown> {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), `foundry-p2-entry-git-${kind}-`)));
  const home = join(scratch, 'home'); mkdirSync(home); const data = join(scratch, 'data'); mkdirSync(data);
  build(scratch, home, [...committed(), { dir: 'unborn' }, file('unborn/a.txt', 'a\n'), git('-C', 'unborn', 'init', '-q')]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
  // Commands inherit a fresh temporary folder and profile, so both runtimes start PowerShell alike.
  for (const folder of ['tmp', 'profile']) mkdirSync(join(scratch, folder));
  Object.assign(env, isolatedGitEnvironment(home), { FOUNDRY_WORKSPACE_DATA: data, TEMP: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), USERPROFILE: join(scratch, 'profile') },
    kind === 'dotnet' ? { FOUNDRY_RUNTIME_P2_CHAT: '1' } : {});
  const child = kind === 'node'
    ? spawn(process.execPath, [resolve('out/main/runtime.js')], { env, stdio: 'pipe' })
    : spawn(resolve('src/Foundry.Runtime/bin/Release/net10.0-windows/Foundry.Runtime.exe'), [], { env, stdio: 'pipe' });
  const exited = once(child, 'exit');
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += String(text); });
  const reader = createInterface({ input: child.stdout }); const lines = reader[Symbol.asyncIterator]();
  const events: ObjectValue[] = [];
  const request = async (id: string, method: string, params: unknown): Promise<ObjectValue> => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let n = 0; n < 1000; n++) {
      const next = await lines.next(); if (next.done) throw new Error(`Entry exited before reply: ${stderr}`);
      const value = JSON.parse(next.value) as ObjectValue;
      if (value.method === 'workspace.event') { events.push(value.params as ObjectValue); continue; }
      if (value.method === 'browser.host') {
        // Node's turns ask which browser tabs are attached; none are. Native has no browser host.
        const call = BrowserHostCallSchema.parse(value); expect(['revoke', 'tabs']).toContain(call.params.kind);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, method: 'browser.host.result', result: call.params.kind === 'tabs' ? [] : null }) + '\n'); continue;
      }
      RpcResponseSchema.parse(value); expect(value.id).toBe(id); return value;
    }
    throw new Error('Missing bounded reply.');
  };
  const idle = async (label: string, taskId: unknown): Promise<ObjectValue> => {
    for (let n = 0; n < 500; n++) {
      const read = await request(`${label}-${n}`, 'task.read', { taskId });
      if (((read.result as ObjectValue).task as ObjectValue).status !== 'running') return read;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('The turn did not finish.');
  };
  try {
    const project = await request('project', 'project.add', { path: join(scratch, 'repo') });
    const projectId = (project.result as ObjectValue).id;
    const start = (requestId: string, content: string) => ({ requestId, projectId, content, profileId: FAKE_PROFILE_ID, mode: 'chat' });
    const started = await request('start-a', 'task.start', start('89898989-0000-4000-8000-000000000001', 'Hello repo')); const a = (started.result as ObjectValue).id;
    const firstTurn = await idle('read-a', a);
    const demo = await request('demo', 'task.send', { taskId: a, content: '/channel-demo Hello team' });
    const demoTurn = await idle('read-demo', a);
    const second = await request('start-b', 'task.start', start('89898989-0000-4000-8000-000000000002', 'Hello from B')); const b = (second.result as ObjectValue).id;
    const secondTurn = await idle('read-b', b);
    const channel = await request('channel', 'channel.get', { taskId: b });
    const messages = await request('messages', 'task.messages', { taskId: a, limit: 50 });
    const cancelled = await request('cancel', 'task.cancel', { taskId: a });
    const tasks = await request('tasks', 'workspace.tasks', { limit: 50 });
    // A repository with no commit: its worktree is refused before any mutation, and the refusal's text reaches the client.
    const unborn = await request('unborn', 'project.add', { path: join(scratch, 'unborn') });
    const unbornStart = await request('unborn-start', 'task.start', { ...start('89898989-0000-4000-8000-000000000004', 'Unborn'), projectId: (unborn.result as ObjectValue).id });
    // The coding demo through approval.decide: a read, the approved edit and the approved command.
    const coding = await request('coding', 'task.start', { ...start('89898989-0000-4000-8000-000000000003', '/demo'), mode: 'coding' }); const c = (coding.result as ObjectValue).id;
    const proposal = async (label: string, tool: string): Promise<ObjectValue> => {
      for (let n = 0; n < 2000; n++) {
        const page = await request(`${label}-${n}`, 'task.approvals', { taskId: c, limit: 50 });
        const waiting = ((page.result as ObjectValue).approvals as ObjectValue[]).find(item => item.state === 'awaiting-approval' && item.tool === tool);
        // A page omits the nonce; the approval itself carries it.
        if (waiting) return ((await request(`${label}-get`, 'approval.get', { taskId: c, approvalId: waiting.id })).result as ObjectValue).approval as ObjectValue;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error(`No ${tool} proposal.`);
    };
    const edit = await proposal('edit', 'replace_text');
    const editDecided = await request('decide-edit', 'approval.decide', { taskId: c, approvalId: edit.id, nonce: edit.nonce, decision: 'approve' });
    const command = await proposal('command', 'run_command');
    const stale = await request('decide-stale', 'approval.decide', { taskId: c, approvalId: command.id, nonce: 'stale-nonce-0000000000', decision: 'approve' });
    const commandDecided = await request('decide-command', 'approval.decide', { taskId: c, approvalId: command.id, nonce: command.nonce, decision: 'approve' });
    const codingTurn = await idle('read-coding', c);
    const approvalsPage = await request('approvals-coding', 'task.approvals', { taskId: c, limit: 50 });
    const diff = await request('diff-coding', 'task.diff', { taskId: c });
    child.stdin.end();
    for await (const line of lines) {
      const frame = JSON.parse(line) as ObjectValue;
      expect(frame.method).toBe('workspace.event'); events.push(frame.params as ObjectValue);
    }
    const [code] = await exited; expect(code).toBe(0); expect(stderr).toBe('');
    const db = new Database(join(data, 'workspace.db'), { readonly: true });
    try {
      const key = createHash('sha256').update(join(scratch, 'repo', '.git').toLowerCase(), 'utf8').digest('hex');
      const identities = new Map<string, string>();
      const normalize = (value: unknown): unknown => {
        if (typeof value === 'string') {
          if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return 'CLOCK';
          if (value.startsWith('{') || value.startsWith('[')) return normalize(JSON.parse(value));
          return value.replaceAll(scratch, 'SCRATCH').replaceAll(scratch.toLowerCase(), 'SCRATCH-LOWER').replaceAll(key, 'PROJECT-KEY')
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, match => {
              if (!identities.has(match)) identities.set(match, `ID-${identities.size + 1}`);
              return identities.get(match)!;
            });
        }
        if (Array.isArray(value)) return value.map(normalize);
        // An approval fingerprint covers the edit's absolute root, and a command's is session-scoped; both differ by run.
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, field]) => [name, name === 'fingerprint' && typeof field === 'string' ? 'FINGERPRINT' : normalize(field)]));
        return value;
      };
      // Participants sort by task id and start hashes cover the project id, both random here; the in-process vectors pin
      // both with fixed identities. The participants are ordered by title instead, and each hash is checked for its shape.
      const view = channel.result as ObjectValue;
      const participants = [...(view.participants as ObjectValue[])].sort((left, right) => String(left.title).localeCompare(String(right.title)));
      const starts = (db.prepare('SELECT * FROM task_starts ORDER BY rowid').all() as ObjectValue[]).map(row => ({ ...row, input_hash: typeof row.input_hash === 'string' && row.input_hash.length === 64 }));
      return normalize({ project: project.result, started: started.result, firstTurn: firstTurn.result, demo: demo.result, demoTurn: demoTurn.result,
        second: second.result, secondTurn: secondTurn.result, channel: { ...view, participants }, messages: messages.result, cancelled: cancelled.result, tasks: tasks.result, starts,
        unborn: unborn.result, unbornStart: unbornStart.error,
        coding: coding.result, editDecided: editDecided.result, stale: stale.error, commandDecided: commandDecided.result, codingTurn: codingTurn.result,
        approvalsPage: approvalsPage.result, diff: diff.result,
        rows: Object.fromEntries(['tasks', 'messages', 'provider_requests', 'events', 'intents', 'projects'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
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

it('matches Node and C# actual entry points for a Git-project chat, its channel tool loop and the second agent it reaches', async () => {
  const expected = await exerciseGit('node'); const actual = await exerciseGit('dotnet'); expect(actual).toEqual(expected);
}, 120_000);
