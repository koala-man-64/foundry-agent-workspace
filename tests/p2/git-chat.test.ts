import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderEvent, ProviderRequest, RpcMethod, ToolCall, WorkspaceEvent } from '../../packages/protocol/src/index';
import { createProvider, profileFingerprint } from '../../packages/providers/src/index';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { build, committed, file, git, normalize, runGit, sha256File, withIsolatedGit } from './repository-fixture';
import { seedPowerShellModuleCache, warmPowerShellModuleCache } from './powershell-module-cache';

// Git-project chats through the shipping RuntimeService: task.start, task.send and task.cancel with the agent loop's
// tool iterations, the project channel's delivery and acknowledgment, and the failed-start retry. The offline provider
// runs the channel demo; a scripted provider drives the loop to each of its limits. Each step records its value or
// refusal, the rows it added, changed or removed in every table, its notifications and every request a provider received.
// Identities and the clock are deterministic, as in folder-chat.test.ts. The C# suite (GitChatTests) replays every step
// through DevelopmentChat and must reproduce each record, except where a step names an approved native difference: then
// native must refuse it and change nothing. Placeholders: {scratch}, and {project-key} for the project key TypeScript's
// formula gives the fixture's common directory; in parameters, {task:x} is the task the step marked x started and
// {project} the Git project added last.
const ids = vi.hoisted(() => ({ next: 1 }));
// The command helper's result nonce, which native's in-process runner has no use for (P2.3a), and which nothing records,
// draws a real UUID, so the identities after a command match.
vi.mock('node:crypto', async original => {
  const crypto = await original<typeof import('node:crypto')>();
  return { ...crypto, randomUUID: () => (new Error().stack ?? '').includes('command-runner') ? crypto.randomUUID() : `78787878-0000-4000-8000-${String(ids.next++).padStart(12, '0')}` as ReturnType<typeof crypto.randomUUID> };
});
const timestamp = '2026-01-02T03:04:05.678Z';

type ScriptEvent = { type: 'text'; text?: string; repeat?: [string, number] } | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; omit?: true; apiKind?: string; secret?: true; pad?: number } | { type: 'insert-unknown' };
// git runs a fixture Git command, where {next-task} is the id the next task will draw; overlap sends twice in one step, so
// the second always meets the first's turn. decide sends approval.decide for the task's waiting approval (or another task's,
// with of), optionally with another nonce or approval id. A settled step is recorded once its task stops running or proposes
// a new approval, which both runtimes reach alike however far a turn ran before the step returned.
type Step = { method: RpcMethod | 'wait' | 'seed-intent' | 'seed-seen' | 'git' | 'overlap' | 'decide'; params: Record<string, unknown>; as?: string; settle?: true; native?: { error: string; difference: string } };
// A case on the real clock records every timestamp as {time} and leaves out transient progress notifications, whose
// count depends on timing. Commands need it: TypeScript's command helper checks its parent's start time.
type Case = { name: string; scripted?: true; clock?: 'real'; steps: Step[] };

const text = (value: string): ScriptEvent => ({ type: 'text', text: value });
const done = (extra: Omit<Extract<ScriptEvent, { type: 'done' }>, 'type'> = {}): ScriptEvent => ({ type: 'done', ...extra });
const call = (id: string, name: string, args: unknown): ScriptEvent => ({ type: 'tool_call', call: { id, name, arguments: args } });
const read = (id: string, after = 0) => call(id, 'read_agent_messages', { after });
const SECRET = 'token sk-abcdefghijklmnopqrstuvwx';
// One provider response per entry; a continuation names its script and step, so later requests continue it.
const SCRIPTS: Record<string, ScriptEvent[][]> = {
  'two-calls': [[text('Checking the channel.'), call('c1', 'list_project_agents', {}), read('c2'), done()], [text('Done.'), done()]],
  'three-iterations': [[call('s1', 'send_agent_message', { recipientTaskId: null, content: 'First broadcast' }), done()], [read('s2'), done()], [text('Finished after two tools.'), done()]],
  'duplicate-id': [[read('d1'), read('d1'), done()]],
  'seventeen': [[...Array.from({ length: 17 }, (_, index) => read(`m${index}`)), done()]],
  'reused-id': [[read('x1'), done()], [read('x1'), done()]],
  'no-continuation': [[read('n1'), done({ omit: true })]],
  'wrong-kind': [[read('w1'), done({ apiKind: 'responses' })]],
  'secret-continuation': [[read('k1'), done({ secret: true })]],
  'secret-call': [[call('k2', 'send_agent_message', { recipientTaskId: null, content: SECRET }), done()]],
  'large-continuation': [[read('l1'), done({ pad: 530_000 })]],
  'after-done': [[text('early'), done(), text('late')]],
  'no-done': [[text('never finished')]],
  'empty-call-id': [[call('', 'list_project_agents', {}), done()]],
  'tool-errors': [[
    call('e1', 'read_file', { path: 'README.md' }), call('e2', 'browser_tabs', {}), call('e3', 'unknown_tool', {}), call('e4', 'read_agent_messages', { after: -1 }),
    call('e5', 'list_project_agents', { afterTaskId: 'not-a-uuid' }), call('e6', 'send_agent_message', { recipientTaskId: '78787878-0000-4000-8000-999999999999', content: 'Nobody' }), done(),
  ], [text('Recovered from tool errors.'), done()]],
  'text-limit': [[{ type: 'text', repeat: ['a', 256 * 1024 + 1] }, done()]],
  'transcript-limit': [0, 1, 2].map(index => [{ type: 'text', repeat: ['t', 200 * 1024] }, read(`tr${index}`), done()]),
  'context': [[read('ctx1'), done()], [text('Context noted.'), done()]],
  'tool-limit': Array.from({ length: 51 }, (_, index) => [read(`t${index}`), done()]),
  'recovered': [[text('Recovered after an interrupted call.'), done()]],
  'budget': [[read('b1'), done()], [text('Never requested.'), done()]],
  'budget-warning': [[read('w2'), done()], [text('Within budget.'), done()]],
  'one-call': [[read('o1'), done()], [text('One call.'), done()]],
  'unknown-mutation': [[{ type: 'insert-unknown' }, read('u1'), done()], [text('Never requested.'), done()]],
};

/** What a provider reads of a request; the reservation rows pin the rest of it. */
function view(request: ProviderRequest): unknown {
  return {
    messages: request.messages.map(message => ({ role: message.role, content: message.content })),
    ...(request.tools ? { tools: request.tools.map(tool => tool.name) } : {}),
    ...(request.continuation ? { continuation: request.continuation } : {}),
    ...(request.toolResults ? { toolResults: request.toolResults.map(result => ({ id: result.id, name: result.name, content: result.content, isError: result.isError })) } : {}),
  };
}

function scripted(store: Store): ProviderAdapter['streamTurn'] {
  return async function* (request: ProviderRequest): AsyncIterable<ProviderEvent> {
    // A macrotask first, as the offline provider pauses, so a step's record never depends on how far a turn ran.
    await new Promise(resolve => setTimeout(resolve, 0));
    request.signal.throwIfAborted();
    const last = [...request.messages].reverse().find(message => message.role === 'user')?.content ?? '';
    const data = request.continuation?.data as { script?: string; step?: number } | undefined;
    const [script, step] = last.startsWith('script:') ? [last.slice('script:'.length).split(' ')[0]!, 0] : [data?.script, (data?.step ?? -1) + 1];
    const events = script === undefined ? undefined : SCRIPTS[script]?.[step];
    if (!events) throw new Error(`Unscripted request: ${script ?? 'none'} ${step}.`);
    for (const event of events) {
      if (event.type === 'insert-unknown') {
        for (const row of store.db.prepare("SELECT id FROM tasks WHERE json_extract(data,'$.status')='running' ORDER BY rowid").all() as { id: string }[])
          store.db.prepare("INSERT INTO intents VALUES (?, 'tool.approval', ?, 'unknown')").run(`scripted-unknown-${row.id}`, JSON.stringify({ taskId: row.id }));
      } else if (event.type === 'text') yield { type: 'text', text: event.repeat ? event.repeat[0].repeat(event.repeat[1]) : event.text! };
      else if (event.type === 'tool_call') yield { type: 'tool_call', call: event.call };
      else if (event.omit) yield { type: 'done' } as ProviderEvent;
      else yield { type: 'done', continuation: { apiKind: (event.apiKind ?? 'fake') as 'fake', data: { stage: 'complete', calls: [], script, step, ...(event.secret ? { note: SECRET } : {}), ...(event.pad ? { pad: 'x'.repeat(event.pad) } : {}) } } };
    }
  };
}

const PROJECT = { method: 'project.add', params: { path: '{scratch}\\work\\repo' } } as const;
const start = (request: number, as: string, extra: Record<string, unknown> = {}): Step => ({
  method: 'task.start', as,
  params: { requestId: `78787878-0000-4000-8000-9999999999${String(request).padStart(2, '0')}`, projectId: '{project}', content: 'Hello repo', profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000, ...extra },
});
const send = (as: string, content: string): Step => ({ method: 'task.send', params: { taskId: `{task:${as}}`, content } });
const wait = (as: string): Step => ({ method: 'wait', params: { taskId: `{task:${as}}` } });
const turn = (as: string, content: string): Step[] => [send(as, content), wait(as)];
const coding = (request: number, as: string, content = '/demo'): Step => ({ ...start(request, as, { mode: 'coding', content }), settle: true });
const decide = (as: string, decision: 'approve' | 'reject', extra: Record<string, unknown> = {}): Step => ({ method: 'decide', params: { taskId: `{task:${as}}`, decision, ...extra }, settle: true });

const cases: Case[] = [
  {
    name: 'the project channel between two Git chats', steps: [
      PROJECT, start(1, 'a'), wait('a'), start(1, 'a'),
      ...turn('a', '/channel-demo Hello team'),
      start(2, 'b', { content: 'Hello from B' }), wait('b'),
      { method: 'channel.get', params: { taskId: '{task:b}' } },
      ...turn('b', '/channel-demo'), ...turn('a', 'After B'),
      ...turn('a', `/channel-demo ${'x'.repeat(2100)}`), ...turn('a', '/browser-demo'),
      { method: 'task.cancel', params: { taskId: '{task:a}' } },
      { method: 'task.read', params: { taskId: '{task:a}' } },
      { method: 'task.retire', params: { taskId: '{task:b}', confirm: 'retire' } },
      send('b', 'After retiring'),
      ...turn('a', '/channel-demo After retiring'),
      { method: 'channel.get', params: { taskId: '{task:a}' } },
      { method: 'overlap', params: { taskId: '{task:a}', first: 'Again', second: 'Overlapping' } }, wait('a'),
      { method: 'task.send', params: { taskId: '78787878-0000-4000-8000-999999999999', content: 'Missing' } },
    ],
  },
  {
    name: 'Git chat starts that fail, and their retries', steps: [
      PROJECT, start(3, 'c', { tokenBudget: 1024 }), start(3, 'c', { tokenBudget: 1024 }),
      { method: 'project.update', params: { projectId: '{project}', hidden: true } }, start(3, 'c', { tokenBudget: 1024 }),
      { method: 'project.update', params: { projectId: '{project}', hidden: false } },
      start(4, 'd', { coordination: { childProfileIds: [], requiredValidation: { command: 'pnpm check', cwd: '', timeoutMs: 600000 } } }),
      start(5, 'd', { profileId: '78787878-0000-4000-8000-999999999998' }),
      { method: 'seed-intent', params: { id: '78787878-0000-4000-8000-999999999997', kind: 'worktree.create', data: { taskId: '78787878-0000-4000-8000-999999999996', projectPath: 'C:\\earlier' }, state: 'unknown' } },
      start(6, 'd'), start(3, 'c', { tokenBudget: 1024 }),
    ],
  },
  {
    name: 'worktree creation failures', steps: [
      // No commit yet: the worktree is refused before any mutation, so the start is forgotten and the same request runs again.
      { method: 'project.add', params: { path: '{scratch}\\work\\unborn' } }, start(1, 'u'), start(1, 'u'),
      { method: 'git', params: { args: ['-C', 'work/unborn', 'add', '-A'] } }, { method: 'git', params: { args: ['-C', 'work/unborn', 'commit', '-qm', 'first'] } },
      start(1, 'u'), wait('u'),
      // The task's branch already exists: the failure follows the mutation boundary, so both outcomes are unknown.
      PROJECT, { method: 'git', params: { args: ['-C', 'work/repo', 'branch', 'codex/task/{next-task}'] } }, start(2, 'v'), start(3, 'w'), start(2, 'v'),
    ],
  },
  {
    name: 'a coding task in a Git project', steps: [PROJECT, start(7, 'e', { mode: 'coding' }), wait('e')],
  },
  {
    name: 'the coding demo, approved', clock: 'real', steps: [
      PROJECT, coding(1, 'a'), decide('a', 'approve'), decide('a', 'approve'),
      { method: 'task.approvals', params: { taskId: '{task:a}', limit: 50 } }, { method: 'files.read', params: { taskId: '{task:a}', path: 'README.md' } },
      { method: 'task.diff', params: { taskId: '{task:a}' } }, { ...send('a', '/demo'), settle: true },
    ],
  },
  {
    name: 'the coding demo, rejected, cancelled and decided stale', clock: 'real', steps: [
      PROJECT, coding(2, 'b'), decide('b', 'reject'),
      // The cancelled demo resumes from its stored replace stage, whose call carries the cancellation's result.
      coding(3, 'c'), { method: 'task.cancel', params: { taskId: '{task:c}' }, settle: true }, { ...send('c', 'After the cancellation'), settle: true },
      coding(4, 'd'), { ...decide('d', 'approve', { nonce: 'stale-nonce-0000000000' }), settle: undefined },
      { ...decide('b', 'approve', { of: '{task:d}' }), settle: undefined }, { ...decide('d', 'approve', { approvalId: '78787878-0000-4000-8000-999999999995' }), settle: undefined },
      decide('d', 'approve'), decide('d', 'reject'), { method: 'task.approvals', params: { taskId: '{task:d}', limit: 50 } },
    ],
  },
  {
    name: 'the agent loop at each of its limits', scripted: true, steps: [
      PROJECT, start(1, 'a', { content: 'script:two-calls', tokenBudget: 10_000_000 }), wait('a'),
      ...['three-iterations', 'duplicate-id', 'seventeen', 'reused-id', 'no-continuation', 'wrong-kind', 'secret-continuation', 'secret-call', 'large-continuation',
        'after-done', 'no-done', 'empty-call-id', 'tool-errors', 'text-limit', 'transcript-limit'].flatMap(script => turn('a', `script:${script}`)),
      ...turn('a', `script:context ${'x'.repeat(21_000)}`),
      start(2, 'b', { content: 'script:tool-limit', tokenBudget: 10_000_000 }), wait('b'), ...turn('b', 'script:recovered'),
      { method: 'seed-seen', params: { taskId: '{task:b}', count: 1000 } }, ...turn('b', 'script:one-call'),
      start(3, 'c', { content: 'script:budget', tokenBudget: 0 }), wait('c'), ...turn('c', 'script:one-call'),
      start(5, 'e', { content: 'script:budget-warning', tokenBudget: -1 }), wait('e'),
      start(4, 'd', { content: 'script:unknown-mutation' }), wait('d'), send('d', 'script:two-calls'),
    ],
  },
];

const TABLES: [string, string, string][] = [
  ['tasks', 'SELECT rowid AS _rowid,* FROM tasks ORDER BY rowid', 'id'],
  ['messages', 'SELECT rowid AS _rowid,* FROM messages ORDER BY ordinal', 'id'],
  ['requests', 'SELECT rowid AS _rowid,* FROM provider_requests ORDER BY rowid', 'request_id'],
  ['starts', 'SELECT * FROM task_starts ORDER BY rowid', 'request_id'],
  ['events', 'SELECT * FROM events ORDER BY sequence', 'sequence'],
  ['intents', 'SELECT rowid AS _rowid,* FROM intents ORDER BY rowid', 'id'],
  ['projects', 'SELECT rowid AS _rowid,* FROM projects ORDER BY rowid', 'id'],
];
type Rows = Record<string, Record<string, unknown>[]>;
/** The rows each table added or changed since the previous record, and the keys it removed; unchanged tables are left out. */
function delta(before: Rows, after: Rows): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [table, , key] of TABLES) {
    const prior = new Map(before[table]!.map(row => [row[key], JSON.stringify(row)]));
    const current = new Set(after[table]!.map(row => row[key]));
    const changed = after[table]!.filter(row => prior.get(row[key]) !== JSON.stringify(row));
    const removed = before[table]!.filter(row => !current.has(row[key])).map(row => row[key]);
    if (changed.length || removed.length) output[table] = { changed, removed };
  }
  return output;
}

async function run(item: Case, budgets: Record<string, number> | undefined): Promise<unknown[]> {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-git-chat-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  // Commands inherit these, as their minimal environment does; the shell and SystemRoot become placeholders.
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE };
  for (const folder of ['tmp', 'profile']) fs.mkdirSync(path.join(scratch, folder));
  seedPowerShellModuleCache(path.join(scratch, 'profile'));
  Object.assign(process.env, { TEMP: path.join(scratch, 'tmp'), TMP: path.join(scratch, 'tmp'), USERPROFILE: path.join(scratch, 'profile') });
  const systemRoot = process.env.SystemRoot!;
  const shell = fs.realpathSync.native(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const fingerprints = new Map<string, string>();
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value;
      for (const [raw, name] of [[shell, 'shell'], [systemRoot, 'SystemRoot']] as const) text = text.replaceAll(raw.replaceAll('\\', '\\\\'), `{${name}-json}`).replaceAll(raw, `{${name}}`);
      for (const [raw, name] of fingerprints) text = text.replaceAll(raw, name);
      return item.clock === 'real' ? text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '{time}') : text;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, clean(entry)]));
    return value;
  };
  build(scratch, home, [...committed([], 'work/repo'), { dir: 'work/unborn' }, file('work/unborn/a.txt', 'a\n'), git('-C', 'work/unborn', 'init', '-q')]);
  if (item.clock !== 'real') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp)); }
  ids.next = 1;
  const data = path.join(scratch, 'data'); fs.mkdirSync(data);
  const store = new Store(path.join(data, 'workspace.db'));
  const notifications: WorkspaceEvent[] = []; const provider: unknown[] = [];
  const fake = createProvider('fake'); const script = scripted(store);
  const adapter: ProviderAdapter = { streamTurn: request => { provider.push(view(request)); return item.scripted ? script(request) : fake.streamTurn(request); }, probe: (...args) => fake.probe(...args) };
  const service = new RuntimeService(store, new RepositoryService(path.join(data, 'wt')), event => notifications.push(event), () => adapter);
  const expanded: Record<string, string> = {};
  const expand = (value: unknown): unknown => {
    if (typeof value === 'string') return Object.entries(expanded).reduce((text, [name, replacement]) => text.replaceAll(name, replacement), value.replaceAll('{scratch}', scratch));
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, expand(field)]));
    return value;
  };
  const key = createHash('sha256').update(path.join(scratch, 'work', 'repo', '.git').toLowerCase(), 'utf8').digest('hex');
  const rows = (): Rows => Object.fromEntries(TABLES.map(([table, sql]) => [table, store.db.prepare(sql).all() as Record<string, unknown>[]]));
  const approvals = () => store.db.prepare("SELECT id,data,state FROM intents WHERE kind='tool.approval' ORDER BY rowid").all() as { id: string; data: string; state: string }[];
  // Each approval fingerprint (an edit's covers its absolute root) becomes {fingerprint:N}, in order of first appearance.
  const remember = () => {
    for (const row of approvals()) {
      const fingerprint = (JSON.parse(row.data) as { fingerprint?: string }).fingerprint;
      if (fingerprint && !fingerprints.has(fingerprint)) fingerprints.set(fingerprint, `{fingerprint:${fingerprints.size + 1}}`);
    }
  };
  const awaiting = (taskId: string) => approvals().filter(row => row.state === 'awaiting-approval' && (JSON.parse(row.data) as { taskId?: string }).taskId === taskId).at(-1);
  try {
    const recorded: unknown[] = [];
    let before = rows(); let seen = 0; let requested = 0;
    await withIsolatedGit(home, async () => {
      for (const step of item.steps) {
        let value: unknown = null; let error: string | null = null;
        const known = new Set(approvals().map(row => row.id));
        // A budget of 0 is the first request's reservation, so the second is refused; -1 is exactly the first two requests'.
        expanded['{next-task}'] = `78787878-0000-4000-8000-${String(ids.next).padStart(12, '0')}`;
        const params = expand(step.params) as Record<string, unknown>;
        if (params.tokenBudget === 0 || params.tokenBudget === -1) params.tokenBudget = budgets?.[String(params.tokenBudget)] ?? 10_000_000;
        try {
          if (step.method === 'wait') {
            for (let n = 0; store.task(params.taskId as string).status === 'running'; n++) { if (n > 5000) throw new Error('Oracle did not complete.'); await new Promise(resolve => setTimeout(resolve, 1)); }
          } else if (step.method === 'seed-intent') store.db.prepare('INSERT INTO intents VALUES (?, ?, ?, ?)').run(params.id, params.kind, JSON.stringify(params.data), params.state);
          else if (step.method === 'seed-seen') {
            const profile = store.profile(FAKE_PROFILE_ID)!;
            const seenToolCallIds = Array.from({ length: params.count as number }, (_, index) => `seen-${index}`);
            store.saveProviderState(params.taskId as string, { fingerprint: profileFingerprint(profile), continuation: { apiKind: 'fake', data: { stage: 'complete', calls: [] } }, pending: [], results: [], seenToolCallIds });
          } else if (step.method === 'git') runGit(scratch, home, params.args as string[]);
          else if (step.method === 'overlap') {
            const first = await service.dispatch('task.send', { taskId: params.taskId, content: params.first });
            let second: string | null = null;
            try { await service.dispatch('task.send', { taskId: params.taskId, content: params.second }); } catch (cause) { second = (cause as Error).message; }
            value = { first, second };
          } else if (step.method === 'decide') {
            const row = awaiting((params.of ?? params.taskId) as string);
            value = await service.dispatch('approval.decide', { taskId: params.taskId, approvalId: params.approvalId ?? row?.id, nonce: params.nonce ?? (row ? (JSON.parse(row.data) as { nonce: string }).nonce : undefined), decision: params.decision });
          } else value = await service.dispatch(step.method, params);
          if (step.settle) {
            const taskId = (params.taskId ?? (value as { id: string }).id) as string;
            const proposed = () => { const row = awaiting(taskId); return row !== undefined && !known.has(row.id); };
            for (let n = 0; store.task(taskId).status === 'running' && !proposed(); n++) {
              if (n > 6000) throw new Error('Oracle did not settle.');
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          }
          if (step.method === 'project.add' && (value as { kind?: string }).kind === 'git') expanded['{project}'] = (value as { id: string }).id;
          if (step.method === 'task.start' && step.as) expanded[`{task:${step.as}}`] = (value as { id: string }).id;
        } catch (cause) { error = (cause as Error).message; }
        const after = rows(); remember();
        const record = normalize(clean({ value, error, delta: delta(before, after), notifications: notifications.slice(seen).filter(event => item.clock !== 'real' || event.sequence !== 0), provider: provider.slice(requested) }), scratch);
        recorded.push({ ...step, expected: JSON.parse(JSON.stringify(record).replaceAll(key, '{project-key}')) });
        before = after; seen = notifications.length; requested = provider.length;
      }
    });
    return recorded;
  } finally {
    await service.shutdown(); vi.useRealTimers();
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

beforeAll(() => { warmPowerShellModuleCache(); }, 600_000);

it('pins Git-project chats, the agent loop and the project channel through the shipping Node authority', async () => {
  const recorded = [];
  for (const item of cases) {
    // The budget cases need request reservations, which a dry run of the same steps with ample budgets measures: the
    // first request of the 0 case, and the first two requests of the -1 case, which its start and wait steps record.
    let budgets: Record<string, number> | undefined;
    if (item.scripted) {
      type Recorded = { value: { id?: string } | null; expected: { value: { id?: string } | null; delta: { requests?: { changed: { task_id: string; reserved: number }[] } } } };
      const dry = await run(item, undefined) as Recorded[];
      const first = item.steps.findIndex(step => step.params.tokenBudget === 0);
      const two = item.steps.findIndex(step => step.params.tokenBudget === -1);
      const task = dry[two]!.expected.value!.id!;
      budgets = {
        0: dry[first]!.expected.delta.requests!.changed.at(-1)!.reserved,
        [-1]: dry[two + 1]!.expected.delta.requests!.changed.filter(row => row.task_id === task).reduce((sum, row) => sum + row.reserved, 0),
      };
    }
    recorded.push({ name: item.name, scripted: item.scripted ?? false, clock: item.clock ?? null, steps: await run(item, budgets), budgets: budgets ?? null });
  }
  const sources = ['packages/runtime/src/service.ts', 'packages/runtime/src/agent-loop.ts', 'packages/runtime/src/agent-channel.ts', 'packages/runtime/src/channel-tools.ts',
    'packages/runtime/src/tool-runtime.ts', 'packages/runtime/src/usage-accounting.ts', 'packages/runtime/src/store.ts', 'packages/runtime/src/repository.ts',
    'packages/runtime/src/workspace-operations.ts', 'packages/runtime/src/redaction.ts', 'packages/providers/src/index.ts', 'packages/providers/src/browser-fixture.ts'];
  const corpus = { schemaVersion: 1, timestamp, scripts: SCRIPTS, secret: SECRET, oracle: { sources: sources.map(source => ({ path: source, sha256: sha256File(source) })) }, cases: recorded };
  const target = 'tests/p2/git-chat-vectors.json';
  if (process.env.P2_WRITE_GIT_CHAT === '1') fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(corpus);
}, 600_000);
