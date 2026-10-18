import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ApiKind, ModelProfile, RpcMethod, WorkspaceEvent } from '../../packages/protocol/src/index';
import { createProvider } from '../../packages/providers/src/index';
import { profileFingerprint } from '../../packages/runtime/src/profile-fingerprint';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { Store } from '../../packages/runtime/src/store';
import { credential, encode, scrub, type Body } from './provider-fetch';
import { build, committed, normalize, sha256File, withIsolatedGit } from './repository-fixture';

// P2.4d: chats with external profiles through the shipping RuntimeService, with createProvider over a recording fetch.
// Projectless, folder and Git chats and coding turns for each kind; the probe and tool gates; channel tools only for a
// profile verified for tools and continuation; usage and metadata settled with their request; failures before and after
// usage, cancellation with and without it; the canary split across chunks or carried in a provider's message; and a
// stored continuation after a profile edit. Each step records its value or refusal, the rows it changed in every table,
// its notifications and every request the provider received. A start, send or cancel settles first: its task stops
// running, or (start and send) the provider parks a response, so a record never depends on how far a turn ran.
// Identities and the clock are deterministic. "{credential}", "{credential:head}" and "{credential:tail}" in a response
// stand for the credential and its two halves. The C# suite (ExternalChatTests) replays every step through
// DevelopmentChat with a recording HttpMessageHandler.
const ids = vi.hoisted(() => ({ next: 1 }));
vi.mock('node:crypto', async original => {
  const crypto = await original<typeof import('node:crypto')>();
  return { ...crypto, randomUUID: () => `89898989-0000-4000-8000-${String(ids.next++).padStart(12, '0')}` as ReturnType<typeof crypto.randomUUID> };
});
const timestamp = '2026-05-06T07:08:09.012Z';
const HEAD = 11;

interface Answer { status?: number; body?: Body | null; end?: 'close' | 'hang' }
type Step =
  | { method: 'profile.save'; params: Record<string, unknown> }
  | { method: 'profile.probe'; params: { profileId: string }; answers: Answer[] }
  | { method: 'credential'; params: { id: string } }
  // A verification with these capabilities, as a probe by an earlier runtime left it: of the profile's current fingerprint,
  // or (stale) of another configuration.
  | { method: 'seed-verified'; params: { profileId: string; tools: boolean; continuation: boolean; stale?: true } }
  | { method: 'clear-mcp' }
  | { method: 'project.add'; params: { path: string } }
  | { method: 'task.start'; params: Record<string, unknown>; as: string; answers?: Answer[] }
  | { method: 'task.send'; params: { taskId: string; content: string }; answers?: Answer[] }
  | { method: 'task.cancel'; params: { taskId: string } };
interface Case { name: string; era: 'fresh' | 'v3'; steps: Step[] }

const AZURE = '0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53', CHAT = '1d57898c-aedf-4b9e-b9bb-7af0f9b55e64', CLAUDE = '2e68909d-bfe0-4cad-8acc-8ba1a0c66f75';
const KINDS: Record<string, ApiKind> = { [AZURE]: 'responses', [CHAT]: 'chat-completions', [CLAUDE]: 'anthropic' };
const profile = (id: string, extra: Partial<ModelProfile> = {}): Record<string, unknown> => ({ id, name: `External ${KINDS[id]}`, apiKind: KINDS[id], endpoint: 'https://sample.openai.azure.com', deployment: 'test-model', contextLimit: 16384, outputLimit: 1024, ...extra });
const save = (id: string, extra: Partial<ModelProfile> = {}): Step => ({ method: 'profile.save', params: profile(id, extra) });
const key = (id: string): Step => ({ method: 'credential', params: { id } });
const seed = (profileId: string, tools: boolean, continuation = tools, stale?: true): Step => ({ method: 'seed-verified', params: { profileId, tools, continuation, ...(stale ? { stale } : {}) } });
const PROJECT = { method: 'project.add', params: { path: '{scratch}\\work\\repo' } } as const satisfies Step;
const FOLDER = { method: 'project.add', params: { path: '{scratch}\\work\\folder' } } as const satisfies Step;
const start = (request: number, as: string, profileId: string, answers: Answer[], extra: Record<string, unknown> = {}): Step => ({
  method: 'task.start', as, answers,
  params: { requestId: `89898989-0000-4000-8000-9999999999${String(request).padStart(2, '0')}`, projectId: null, content: `Hello ${as}`, profileId, mode: 'chat', tokenBudget: 1_000_000, ...extra },
});
const send = (as: string, content: string, answers: Answer[] = []): Step => ({ method: 'task.send', params: { taskId: `{task:${as}}`, content }, answers });
const cancel = (as: string): Step => ({ method: 'task.cancel', params: { taskId: `{task:${as}}` } });

// ---- Provider responses -------------------------------------------------------------------------------------------
const sse = (event: string | null, payload: unknown): string => `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(payload)}\n\n`;
const r = (type: string, payload: Record<string, unknown>): string => sse(type, { type, ...payload });
const a = (type: string, payload: Record<string, unknown> = {}): string => sse(type, { type, ...payload });
const message = (text: string) => ({ type: 'message', id: 'msg-out', content: [{ type: 'output_text', text }] });
const completed = (output: unknown[], usage: Record<string, unknown> | null = { input_tokens: 40, output_tokens: 5 }, extra: Record<string, unknown> = {}) =>
  r('response.completed', { response: { id: 'resp-1', model: 'reported-model', status: 'completed', output, ...(usage ? { usage } : {}), ...extra } });
const responsesText = (text: string, usage?: Record<string, unknown> | null, extra?: Record<string, unknown>): Answer => ({ body: [r('response.output_text.delta', { delta: text }), completed([message(text)], usage, extra)] });
const responsesCall = (callId: string, name: string, args: string, extra: unknown[] = []): Answer => {
  const item = { type: 'function_call', id: `fc-${callId}`, call_id: callId, name, arguments: args };
  return { body: [r('response.output_item.done', { item }), completed([...extra, item], { input_tokens: 60, output_tokens: 8 })] };
};
const chatText = (text: string): Answer => ({ body: [sse(null, { id: 'chat-1', model: 'reported-chat', choices: [{ delta: { content: text } }] }), sse(null, { choices: [{ delta: {}, finish_reason: 'stop' }] }), sse(null, { choices: [], usage: { prompt_tokens: 30, completion_tokens: 3 } }), 'data: [DONE]\n\n'] });
const chatCall = (id: string, name: string, args: string): Answer => ({ body: [sse(null, { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }] }), sse(null, { choices: [], usage: { prompt_tokens: 50, completion_tokens: 6 } }), 'data: [DONE]\n\n'] });
const claudeText = (text: string, stop = 'end_turn'): Answer => ({ body: [a('message_start', { message: { id: 'msg-1', model: 'reported-claude', usage: { input_tokens: 20, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } } }), a('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), a('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }), a('content_block_stop', { index: 0 }), a('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 3 } }), a('message_stop')] });
const claudeCall = (id: string, name: string, input: unknown): Answer => ({ body: [a('message_start', { message: { usage: { input_tokens: 25 } } }), a('content_block_start', { index: 0, content_block: { type: 'tool_use', id, name, input: {} } }), a('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }), a('content_block_stop', { index: 0 }), a('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }), a('message_stop')] });
const probeText = (kind: ApiKind, text: string): Answer => kind === 'responses' ? responsesText(text) : kind === 'chat-completions' ? chatText(text) : claudeText(text);
const probeCall = (kind: ApiKind): Answer => kind === 'responses' ? responsesCall('probe-call', 'fixture_tool', '{}') : kind === 'chat-completions' ? chatCall('probe-call', 'fixture_tool', '{}') : claudeCall('probe-call', 'fixture_tool', {});
const probe = (id: string): Step => ({ method: 'profile.probe', params: { profileId: id }, answers: [probeText(KINDS[id]!, 'OK'), probeText(KINDS[id]!, 'OK'), probeCall(KINDS[id]!), probeText(KINDS[id]!, '{token}')] });
const ready = (id: string, extra: Partial<ModelProfile> = {}): Step[] => [save(id, extra), key(id), probe(id)];

const cases: Case[] = [
  {
    name: 'projectless chats for each kind', era: 'fresh', steps: [
      ...ready(AZURE), ...ready(CHAT), ...ready(CLAUDE),
      start(1, 'r', AZURE, [responsesText('Hi from Responses')]),
      send('r', 'And again', [responsesText('Second answer', { input_tokens: 70, output_tokens: 9, input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 2 } })]),
      start(2, 'c', CHAT, [chatText('Hi from Chat Completions')]),
      send('c', 'Once more', [chatText('Again from Chat Completions')]),
      start(3, 'a', CLAUDE, [claudeText('Hi from Anthropic')]),
      send('a', 'And more', [claudeText('Again from Anthropic')]),
    ],
  },
  {
    name: 'the probe and tool gates, and channel tools only when verified', era: 'fresh', steps: [
      save(AZURE), key(AZURE),
      start(1, 'unverified', AZURE, []),
      seed(AZURE, false),
      FOLDER, start(2, 'folder', AZURE, [responsesText('Folder answer')], { projectId: '{project}' }),
      PROJECT, start(3, 'plain', AZURE, [responsesText('No channel tools')], { projectId: '{project}' }),
      start(4, 'coding', AZURE, [], { projectId: '{project}', mode: 'coding' }),
      seed(AZURE, true, false),
      start(6, 'no-continuation', AZURE, [], { projectId: '{project}', mode: 'coding' }),
      seed(AZURE, true, true, true),
      start(7, 'stale', AZURE, []),
      probe(AZURE),
      start(5, 'tools', AZURE, [responsesText('With channel tools')], { projectId: '{project}' }),
      send('plain', 'Now with tools', [responsesText('Channel tools now')]),
      seed(AZURE, false),
      send('tools', 'Its state needs tools'),
      save(AZURE, { endpoint: 'https://other.openai.azure.com' }),
      send('plain', 'Unverified again'),
    ],
  },
  {
    name: 'a missing credential, HTTP errors and failures before and after usage', era: 'fresh', steps: [
      save(AZURE), seed(AZURE, true),
      start(1, 'f', AZURE, []),
      // A credential clears verification, as TypeScript's setCredential does.
      key(AZURE), probe(AZURE),
      send('f', 'Unauthorized', [{ status: 401, body: ['{"error":{"message":"denied"}}'] }]),
      send('f', 'Rate limited', [{ status: 429, body: [] }]),
      send('f', 'Fail early', [{ body: [r('response.failed', { response: { status: 'failed' } })] }]),
      send('f', 'Fail late', [{ body: [r('response.failed', { response: { id: 'resp-f', model: 'reported-model', status: 'failed', usage: { input_tokens: 30, output_tokens: 4 } } })] }]),
      send('f', 'Cut off', [{ body: [r('response.output_text.delta', { delta: 'partial' })] }]),
      send('f', 'Recovered', [responsesText('Recovered')]),
    ],
  },
  {
    name: 'canaries split across chunks, in provider messages and in metadata', era: 'fresh', steps: [
      ...ready(AZURE), ...ready(CLAUDE),
      start(1, 's', AZURE, [{ body: [r('response.output_text.delta', { delta: 'leading {credential:head}' }), r('response.output_text.delta', { delta: '{credential:tail} trailing' }), completed([message('leading {credential} trailing')])] }]),
      send('s', 'Metadata', [responsesText('Attributed', { input_tokens: 41, output_tokens: 6 }, { model: 'model {credential}', id: 'x'.repeat(201) })]),
      start(2, 'm', CLAUDE, [claudeText('Stopped', '{credential}')]),
      start(3, 'n', CLAUDE, [claudeText('Too long', 'max_tokens')]),
    ],
  },
  {
    name: 'cancellation with and without usage', era: 'fresh', steps: [
      ...ready(AZURE),
      start(1, 'x', AZURE, [{ body: [r('response.output_text.delta', { delta: 'Partial' })], end: 'hang' }]),
      cancel('x'),
      send('x', 'Again', [{ body: [r('response.output_text.delta', { delta: 'Measured' }), completed([message('Measured')], { input_tokens: 33, output_tokens: 2 })], end: 'hang' }]),
      cancel('x'),
      send('x', 'Finally', [responsesText('Finished')]),
    ],
  },
  {
    name: 'Git chats and coding turns with tool calls for each kind', era: 'fresh', steps: [
      ...ready(AZURE), ...ready(CHAT), ...ready(CLAUDE), PROJECT,
      start(1, 'g', AZURE, [responsesCall('call-1', 'list_project_agents', '{}'), responsesText('Listed the agents.')], { projectId: '{project}' }),
      send('g', 'Resume from the stored continuation', [responsesText('Resumed.')]),
      start(2, 'k', AZURE, [responsesCall('call-2', 'read_file', '{"path":"README.md"}', [{ type: 'reasoning', id: 'rs-1', encrypted_content: 'opaque', summary: [] }]), responsesText('Read the readme.')], { projectId: '{project}', mode: 'coding' }),
      start(3, 'cc', CHAT, [chatCall('call-3', 'read_file', '{"path":"README.md"}'), chatText('Chat read it.')], { projectId: '{project}', mode: 'coding' }),
      send('cc', 'Chat continues', [chatText('Chat resumed.')]),
      start(4, 'ag', CLAUDE, [claudeCall('call-4', 'list_project_agents', {}), claudeText('Anthropic listed them.')], { projectId: '{project}' }),
      send('ag', 'Anthropic continues', [claudeText('Anthropic resumed.')]),
      start(5, 'secret', AZURE, [responsesCall('call-5', 'list_project_agents', '{}', [{ type: 'reasoning', id: 'rs-2', encrypted_content: '{credential}', summary: [] }])], { projectId: '{project}' }),
      start(6, 'secret-call', AZURE, [responsesCall('call-6', 'send_agent_message', JSON.stringify({ recipientTaskId: null, content: 'key {credential}' }))], { projectId: '{project}' }),
    ],
  },
  {
    name: 'budget and context warnings on measured usage', era: 'fresh', steps: [
      ...ready(AZURE, { contextLimit: 8192, outputLimit: 1024 }),
      // The first reservation is above 80% of both the context and the budget; measured usage then frees most of the
      // budget, until the history's reservation no longer fits it.
      start(1, 'w', AZURE, [responsesText('Warned', { input_tokens: 50, output_tokens: 5 })], { content: `Warn ${'w'.repeat(5200)}`, tokenBudget: 7000 }),
      send('w', 'Again', [responsesText('Warned again', { input_tokens: 60, output_tokens: 6 })]),
      send('w', 'Over budget'),
    ],
  },
  {
    name: 'a stored continuation after a profile edit', era: 'fresh', steps: [
      ...ready(AZURE), PROJECT,
      start(1, 'e', AZURE, [responsesCall('call-7', 'list_project_agents', '{}'), responsesText('Before the edit.')], { projectId: '{project}' }),
      save(AZURE, { name: 'Renamed' }),
      send('e', 'After a rename', [responsesText('Still the same configuration.')]),
      save(AZURE, { name: 'Renamed', endpoint: 'https://other.openai.azure.com' }),
      key(AZURE), probe(AZURE),
      send('e', 'After an endpoint change'),
    ],
  },
  {
    name: 'a version 3 database', era: 'v3', steps: [
      { method: 'clear-mcp' }, ...ready(AZURE),
      start(1, 'v', AZURE, [responsesText('Legacy usage', { input_tokens: 21, output_tokens: 3 })]),
      send('v', 'Fail late', [{ body: [r('response.failed', { response: { status: 'failed', usage: { input_tokens: 22, output_tokens: 1 } } })] }]),
    ],
  },
];

const TABLES: [string, string, string][] = [
  ['tasks', 'SELECT rowid AS _rowid,* FROM tasks ORDER BY rowid', 'id'],
  ['messages', 'SELECT rowid AS _rowid,* FROM messages ORDER BY ordinal', 'id'],
  ['requests', 'SELECT rowid AS _rowid,* FROM provider_requests ORDER BY rowid', 'request_id'],
  ['usage', 'SELECT rowid AS _rowid,* FROM usage_records ORDER BY rowid', 'id'],
  ['starts', 'SELECT * FROM task_starts ORDER BY rowid', 'request_id'],
  ['events', 'SELECT * FROM events ORDER BY sequence', 'sequence'],
  ['intents', 'SELECT rowid AS _rowid,* FROM intents ORDER BY rowid', 'id'],
  ['projects', 'SELECT rowid AS _rowid,* FROM projects ORDER BY rowid', 'id'],
  ['profiles', 'SELECT rowid AS _rowid,* FROM profiles ORDER BY rowid', 'id'],
];
const TABLE_NAMES: Record<string, string> = { requests: 'provider_requests', usage: 'usage_records', starts: 'task_starts' };
type Rows = Record<string, Record<string, unknown>[]>;
/** The rows each table added or changed since the previous record, and the keys it removed; unchanged tables are left out. */
function delta(before: Rows, after: Rows): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [table, , column] of TABLES) {
    const prior = new Map(before[table]!.map(row => [row[column], JSON.stringify(row)]));
    const current = new Set(after[table]!.map(row => row[column]));
    const changed = after[table]!.filter(row => prior.get(row[column]) !== JSON.stringify(row));
    const removed = before[table]!.filter(row => !current.has(row[column])).map(row => row[column]);
    if (changed.length || removed.length) output[table] = { changed, removed };
  }
  return output;
}

async function run(item: Case): Promise<unknown[]> {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-external-chat-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  build(scratch, home, [...committed([], 'work/repo'), { dir: 'work/folder' }]);
  const data = path.join(scratch, 'data'); fs.mkdirSync(data);
  if (item.era !== 'fresh') for (const name of fs.readdirSync(`tests/fixtures/databases/${item.era}`).filter(entry => entry.startsWith('workspace.db'))) fs.copyFileSync(`tests/fixtures/databases/${item.era}/${name}`, path.join(data, name));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp));
  ids.next = 1;
  const store = new Store(path.join(data, 'workspace.db'));
  const present = (table: string): boolean => store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE_NAMES[table] ?? table) !== undefined;
  const rows = (): Rows => Object.fromEntries(TABLES.map(([table, sql]) => [table, present(table) ? store.db.prepare(sql).all() as Record<string, unknown>[] : []]));
  const notifications: WorkspaceEvent[] = []; const requests: unknown[] = [];
  let answers: Answer[] = []; let parks = 0;
  const expandSecret = (text: string): string => text.split('{credential:head}').join(credential.slice(0, HEAD)).split('{credential:tail}').join(credential.slice(HEAD)).split('{credential}').join(credential);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const body = String(init?.body);
    requests.push({ url: String(url), headers: Object.fromEntries(Object.entries(init?.headers as Record<string, string>).map(([name, value]) => [name, scrub(value)])), body: scrub(body) });
    const answer = answers.shift();
    if (!answer) throw new Error('Unscripted provider request.');
    const token = /\\"token\\":\\"([0-9a-f-]{36})\\"/.exec(body)?.[1];
    const chunks = answer.body === null ? null : encode((answer.body ?? []).map(chunk => typeof chunk === 'string' ? expandSecret(token ? chunk.split('{token}').join(token) : chunk) : chunk));
    let next = 0;
    const stream = chunks === null ? null : new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < chunks.length) { controller.enqueue(chunks[next++]!); return; }
        if ((answer.end ?? 'close') === 'close') { controller.close(); return; }
        // Every chunk has been read and parsed: the turn now waits on the provider until it is cancelled.
        parks++;
        return new Promise<void>(() => undefined);
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: answer.status ?? 200 });
  });
  const service = new RuntimeService(store, new RepositoryService(path.join(data, 'wt')), event => notifications.push(event), kind => kind === 'fake' ? createProvider('fake') : createProvider(kind, { fetch }));
  const expanded: Record<string, string> = {};
  const expand = (value: unknown): unknown => {
    if (typeof value === 'string') return Object.entries(expanded).reduce((text, [name, replacement]) => text.replaceAll(name, replacement), value.replaceAll('{scratch}', scratch));
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, expand(entry)]));
    return value;
  };
  const projectKey = createHash('sha256').update(path.join(scratch, 'work', 'repo', '.git').toLowerCase(), 'utf8').digest('hex');
  try {
    const recorded: unknown[] = [];
    let before = rows(); let seen = 0; let sent = 0;
    await withIsolatedGit(home, async () => {
      for (const step of item.steps) {
        let value: unknown = null; let error: string | null = null;
        const params = expand('params' in step ? step.params : {}) as Record<string, unknown>;
        const parked = parks;
        try {
          if (step.method === 'credential') {
            const stored = store.profile(params.id as string)!;
            service.setCredential(stored.id, credential, JSON.stringify([stored.apiKind, stored.endpoint, stored.deployment]));
            await service.flushCredentialRepairs();
          } else if (step.method === 'seed-verified') {
            const stored = store.profile(params.profileId as string)!;
            store.saveProfile({ ...stored, verifiedAt: timestamp, verificationFingerprint: params.stale ? 'stale-fingerprint' : profileFingerprint(stored), capabilities: { streaming: true, tools: params.tools as boolean, continuation: params.continuation as boolean, cancellation: true, usage: true } });
          } else if (step.method === 'clear-mcp') store.db.prepare('DELETE FROM mcp_servers').run();
          else {
            if ('answers' in step && step.answers) answers = [...step.answers];
            value = await service.dispatch(step.method as RpcMethod, params);
            if (step.method === 'profile.probe') answers = [];
            if (step.method === 'project.add') expanded['{project}'] = (value as { id: string }).id;
            if (step.method === 'task.start') expanded[`{task:${step.as}}`] = (value as { id: string }).id;
          }
        } catch (cause) { error = (cause as Error).message; }
        if (error === null && (step.method === 'task.start' || step.method === 'task.send' || step.method === 'task.cancel')) {
          const taskId = (step.method === 'task.start' ? (value as { id: string }).id : params.taskId) as string;
          for (let n = 0; store.task(taskId).status === 'running' && (step.method === 'task.cancel' || parks === parked); n++) {
            if (n > 6000) throw new Error('Oracle did not settle.');
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        }
        if (step.method === 'task.start' || step.method === 'task.send') answers = [];
        const after = rows();
        const record = normalize({ value, error, delta: delta(before, after), notifications: notifications.slice(seen), provider: requests.slice(sent) }, scratch);
        recorded.push({ ...step, expected: JSON.parse(scrub(JSON.stringify(record)).replaceAll(projectKey, '{project-key}')) });
        before = after; seen = notifications.length; sent = requests.length;
      }
    });
    return recorded;
  } finally {
    await service.shutdown(); vi.useRealTimers();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

it('pins external-profile chats, their accounting and their gates through the shipping Node authority', async () => {
  const recorded = [];
  for (const item of cases) recorded.push({ name: item.name, era: item.era, steps: await run(item) });
  const sources = ['packages/runtime/src/service.ts', 'packages/runtime/src/agent-loop.ts', 'packages/runtime/src/usage-accounting.ts', 'packages/runtime/src/profile-fingerprint.ts',
    'packages/runtime/src/agent-channel.ts', 'packages/runtime/src/channel-tools.ts', 'packages/runtime/src/tool-runtime.ts', 'packages/runtime/src/store.ts',
    'packages/runtime/src/redaction.ts', 'packages/providers/src/index.ts', 'packages/protocol/src/limits.ts'];
  const corpus = { timestamp, head: HEAD, oracle: { sources: sources.map(source => ({ path: source, sha256: sha256File(source) })) }, cases: recorded };
  const target = 'tests/p2/external-chat-vectors.json';
  const text = JSON.stringify(corpus, null, 2) + '\n';
  if (process.env.P2_WRITE_EXTERNAL_CHAT === '1') fs.writeFileSync(target, text);
  expect(fs.readFileSync(target, 'utf8')).toBe(text);
}, 600_000);
