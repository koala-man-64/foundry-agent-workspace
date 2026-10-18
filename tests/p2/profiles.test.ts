import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ApiKind, ModelProfile, RpcMethod, WorkspaceEvent } from '../../packages/protocol/src/index';
import { createProvider } from '../../packages/providers/src/index';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { credential, encode, scrub, type Body } from './provider-fetch';

// P2.4c: profile.save, the runtime.credential frame and profile.probe through the shipping RuntimeService, with
// createProvider over a recording fetch for external profiles. Each step records its value or refusal, the rows it changed
// in profiles, provider_requests and events, its notifications and every request a provider received. Identities and the
// clock are deterministic. A probe step lists one response per request the probe makes; "hold" keeps a request open until
// a later release step, so a step can change the profile or credential while a probe runs. "{token}" in a response stands
// for the token the probe sent in its fourth request. The C# suite (ProfileTests) replays every step through
// DevelopmentChat with a recording HttpMessageHandler.
const ids = vi.hoisted(() => ({ next: 1 }));
vi.mock('node:crypto', async original => {
  const crypto = await original<typeof import('node:crypto')>();
  return { ...crypto, randomUUID: () => `56565656-0000-4000-8000-${String(ids.next++).padStart(12, '0')}` as ReturnType<typeof crypto.randomUUID> };
});
const timestamp = '2026-03-04T05:06:07.890Z';
const second = `${credential}-second`;
const secrets = (value: string): string => scrub(value.split(second).join('{credential:2}'));

interface Answer { status?: number; body?: Body | null; end?: 'close' | 'hang'; hold?: true }
type Step =
  | { method: 'profile.save'; params: Record<string, unknown> }
  | { method: 'profile.read' | 'profile.probe'; params: { profileId: string }; answers?: Answer[] }
  | { method: 'probe-start'; params: { profileId: string }; answers: Answer[] }
  | { method: 'release' }
  // The v3 fixture saves MCP servers; native refuses a credential while any is saved (decision 2 of P2.4), so a case that
  // needs one clears them first, in both runtimes.
  | { method: 'clear-mcp' }
  | { method: 'credential'; params: { id: string; value: string; binding?: string } };
interface Case { name: string; era: 'fresh' | 'v3' | 'v4'; steps: Step[] }

const AZURE = '0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53', CHAT = '1d57898c-aedf-4b9e-b9bb-7af0f9b55e64', CLAUDE = '2e68909d-bfe0-4cad-8acc-8ba1a0c66f75', OTHER = '3f79a1ae-c0f1-4dbe-9bdd-9cb2b1d77086';
const profile = (id: string, apiKind: ApiKind, extra: Partial<ModelProfile> = {}): Record<string, unknown> => ({ id, name: `Profile ${apiKind}`, apiKind, endpoint: 'https://sample.openai.azure.com', deployment: 'test-model', contextLimit: 8192, outputLimit: 1024, ...extra });
const save = (params: Record<string, unknown>): Step => ({ method: 'profile.save', params });
const read = (profileId: string): Step => ({ method: 'profile.read', params: { profileId } });
const key = (id: string, value = '{credential}', binding?: string): Step => ({ method: 'credential', params: { id, value, ...(binding === undefined ? {} : { binding }) } });
const probe = (profileId: string, answers: Answer[] = []): Step => ({ method: 'profile.probe', params: { profileId }, answers });

// ---- A probe's four requests, per kind --------------------------------------------------------------------------
const sse = (event: string | null, payload: unknown): string => `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(payload)}\n\n`;
const r = (type: string, payload: Record<string, unknown>): string => sse(type, { type, ...payload });
const responsesText = (text: string, usage = true): Answer => ({ body: [r('response.output_text.delta', { delta: text }), r('response.completed', { response: { id: 'resp-1', model: 'probe-model', status: 'completed', output: [{ type: 'message', id: 'm1', content: [{ type: 'output_text', text }] }], ...(usage ? { usage: { input_tokens: 11, output_tokens: 2 } } : {}) } })] });
const responsesTool: Answer = { body: [r('response.output_item.done', { item: { type: 'function_call', id: 'fc-1', call_id: 'probe-call', name: 'fixture_tool', arguments: '{}' } }), r('response.completed', { response: { status: 'completed', output: [{ type: 'function_call', id: 'fc-1', call_id: 'probe-call', name: 'fixture_tool', arguments: '{}' }], usage: { input_tokens: 20, output_tokens: 5 } } })] };
const chatText = (text: string): Answer => ({ body: [sse(null, { id: 'chat-1', model: 'probe-chat', choices: [{ delta: { content: text } }] }), sse(null, { choices: [{ delta: {}, finish_reason: 'stop' }] }), sse(null, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } }), 'data: [DONE]\n\n'] });
const chatTool: Answer = { body: [sse(null, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'probe-call', function: { name: 'fixture_tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }), 'data: [DONE]\n\n'] };
const a = (type: string, payload: Record<string, unknown> = {}): string => sse(type, { type, ...payload });
const claudeText = (text: string): Answer => ({ body: [a('message_start', { message: { id: 'msg-1', model: 'probe-claude', usage: { input_tokens: 7, cache_read_input_tokens: 2 } } }), a('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), a('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }), a('content_block_stop', { index: 0 }), a('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }), a('message_stop')] });
const claudeTool: Answer = { body: [a('message_start', { message: { usage: { input_tokens: 7 } } }), a('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'probe-call', name: 'fixture_tool', input: {} } }), a('content_block_stop', { index: 0 }), a('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }), a('message_stop')] };
const success: Record<'responses' | 'chat-completions' | 'anthropic', Answer[]> = {
  responses: [responsesText('OK'), responsesText('OK'), responsesTool, responsesText('{token}')],
  'chat-completions': [chatText('OK'), chatText('OK'), chatTool, chatText('{token}')],
  anthropic: [claudeText('OK'), claudeText('OK'), claudeTool, claudeText('{token}')],
};
const withAt = (answers: Answer[], index: number, answer: Answer): Answer[] => answers.map((item, position) => position === index ? answer : item);

const cases: Case[] = [
  {
    name: 'saves and their verification', era: 'fresh', steps: [
      read(FAKE_PROFILE_ID),
      save({ ...profile(FAKE_PROFILE_ID, 'fake'), name: 'Offline renamed', endpoint: '', deployment: 'deterministic-fixture', contextLimit: 32000, outputLimit: 2048 }),
      save(profile(FAKE_PROFILE_ID, 'responses')),
      save(profile(AZURE, 'responses')), read(AZURE),
      save(profile(AZURE, 'responses', { verifiedAt: '2020-01-01T00:00:00.000Z', verificationFingerprint: 'forged', capabilities: { streaming: true, tools: true, continuation: true, cancellation: true, usage: true }, credentialRef: 'other' })),
      save(profile(OTHER, 'responses', { endpoint: 'not a url' })), save(profile(OTHER, 'responses', { endpoint: 'http://sample.openai.azure.com' })),
      save(profile(OTHER, 'responses', { endpoint: 'https://sample.openai.azure.com/openai' })), save(profile(OTHER, 'responses', { endpoint: 'https://sample.openai.azure.com:444' })),
      save(profile(OTHER, 'responses', { endpoint: 'https://user@sample.openai.azure.com' })), save(profile(OTHER, 'responses', { endpoint: 'https://example.com' })),
      save(profile(OTHER, 'responses', { endpoint: 'ftp://sample.openai.azure.com' })), save(profile(OTHER, 'responses', { endpoint: 'https://sample.openai.azure.com?x=1' })),
      save(profile(OTHER, 'responses', { endpoint: 'https://.openai.azure.com' })), key(OTHER), probe(OTHER),
      save(profile(OTHER, 'responses', { endpoint: 'https://a\u007fb.openai.azure.com' })), save(profile(OTHER, 'responses', { endpoint: 'https://a%7fb.openai.azure.com' })),
      save(profile(OTHER, 'chat-completions', { outputLimit: 8192 })), save(profile(OTHER, 'fake', { endpoint: 'anything at all' })),
      save(profile(CHAT, 'chat-completions', { effort: 'high' })), save(profile(CLAUDE, 'anthropic', { effort: 'max', credentialRef: 'ignored' })),
    ],
  },
  {
    name: 'credentials and their binding', era: 'fresh', steps: [
      save(profile(AZURE, 'responses')),
      key(OTHER, '{credential}', JSON.stringify(['responses', 'https://sample.openai.azure.com', 'test-model'])),
      key(AZURE, '{credential}', JSON.stringify(['responses', 'https://sample.openai.azure.com', 'other-model'])),
      key(AZURE, '{credential}', JSON.stringify(['responses', 'https://sample.openai.azure.com/', 'test-model'])),
      key(AZURE), read(AZURE), key(AZURE), key(AZURE, '{credential:2}'), read(AZURE),
      probe(FAKE_PROFILE_ID), key(FAKE_PROFILE_ID), read(FAKE_PROFILE_ID),
    ],
  },
  {
    name: 'probes that verify each kind', era: 'fresh', steps: [
      save(profile(AZURE, 'responses')), key(AZURE), probe(AZURE, success.responses), read(AZURE),
      save(profile(AZURE, 'responses')), read(AZURE), save(profile(AZURE, 'responses', { outputLimit: 2048 })), read(AZURE),
      save(profile(CHAT, 'chat-completions', { effort: 'low' })), key(CHAT), probe(CHAT, success['chat-completions']), read(CHAT),
      save(profile(CLAUDE, 'anthropic')), key(CLAUDE), probe(CLAUDE, success.anthropic), read(CLAUDE),
      key(CLAUDE, '{credential:2}'), read(CLAUDE),
      probe(FAKE_PROFILE_ID), read(FAKE_PROFILE_ID), probe(OTHER),
    ],
  },
  {
    name: 'probes that fail at each stage', era: 'fresh', steps: [
      save(profile(AZURE, 'responses')), probe(AZURE),
      key(AZURE), probe(AZURE, success.responses), probe(AZURE, [responsesText('OK', false)]), read(AZURE),
      probe(AZURE, [{ status: 401, body: [] }]),
      probe(AZURE, [success.responses[0]!, { body: [r('response.completed', { response: { status: 'completed', output: [] } })] }]),
      probe(AZURE, withAt(success.responses, 2, responsesText('No tool here'))),
      probe(AZURE, withAt(success.responses, 3, responsesText('no token'))),
      probe(AZURE, withAt(success.responses, 3, responsesTool)),
      probe(AZURE, [{ body: [], end: 'hang' }]), read(AZURE),
    ],
  },
  {
    // TypeScript never closes this request's stream, so its usage record stays pending; native closes it as cancelled (a
    // named difference). It is the case's last step, so no later event depends on it.
    name: 'a cancellation stream that continues after the abort', era: 'fresh', steps: [
      save(profile(AZURE, 'responses')), key(AZURE),
      probe(AZURE, [success.responses[0]!, { body: [r('response.output_text.delta', { delta: 'O' }) + r('response.output_text.delta', { delta: 'K' })], end: 'hang' }]),
    ],
  },
  {
    name: 'changes while a probe runs', era: 'fresh', steps: [
      save(profile(AZURE, 'responses')), key(AZURE),
      { method: 'probe-start', params: { profileId: AZURE }, answers: [{ ...success.responses[0]!, hold: true }, ...success.responses.slice(1)] },
      probe(AZURE), save(profile(AZURE, 'responses', { deployment: 'renamed' })), { method: 'release' }, read(AZURE),
      key(AZURE),
      { method: 'probe-start', params: { profileId: AZURE }, answers: [{ ...success.responses[0]!, hold: true }, ...success.responses.slice(1)] },
      key(AZURE, '{credential:2}'), { method: 'release' }, read(AZURE),
      { method: 'probe-start', params: { profileId: AZURE }, answers: [{ ...success.responses[0]!, hold: true }, ...success.responses.slice(1)] },
      save(profile(AZURE, 'responses', { deployment: 'renamed' })), { method: 'release' }, read(AZURE),
    ],
  },
  {
    name: 'a version 3 database', era: 'v3', steps: [
      { method: 'clear-mcp' },
      save(profile(AZURE, 'responses', { effort: 'high' })), save(profile(AZURE, 'responses')), key(AZURE), probe(AZURE, success.responses), read(AZURE),
    ],
  },
];

const TABLES: [string, string, string][] = [
  ['profiles', 'SELECT rowid AS _rowid,* FROM profiles ORDER BY rowid', 'id'],
  ['requests', "SELECT rowid AS _rowid,* FROM provider_requests ORDER BY rowid", 'request_id'],
  ['events', 'SELECT * FROM events ORDER BY sequence', 'sequence'],
];
type Rows = Record<string, Record<string, unknown>[]>;
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
  const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-profiles-'));
  if (item.era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${item.era}`).filter(name => name.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${item.era}/${file}`, join(scratch, file));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp));
  ids.next = 1;
  const store = new Store(join(scratch, 'workspace.db'));
  const tables = (): Rows => Object.fromEntries(TABLES.map(([table, sql]) => [table, store.schemaVersion >= 4 || table !== 'requests' ? store.db.prepare(sql).all() as Record<string, unknown>[] : []]));
  const notifications: WorkspaceEvent[] = []; const requests: unknown[] = [];
  let answers: Answer[] = []; let release: (() => void) | undefined; let held: Promise<void> | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const body = String(init?.body);
    requests.push({ url: String(url), headers: Object.fromEntries(Object.entries(init?.headers as Record<string, string>).map(([name, value]) => [name, secrets(value)])), body: secrets(body) });
    const answer = answers.shift();
    if (!answer) throw new Error('Unscripted provider request.');
    if (answer.hold) { held = new Promise<void>(resolve => { release = resolve; }); await held; }
    const token = /\\"token\\":\\"([0-9a-f-]{36})\\"/.exec(body)?.[1];
    const chunks = answer.body === null ? null : encode((answer.body ?? []).map(chunk => typeof chunk === 'string' && token ? chunk.split('{token}').join(token) : chunk));
    let next = 0;
    const stream = chunks === null ? null : new ReadableStream<Uint8Array>({ pull(controller) { if (next < chunks.length) { controller.enqueue(chunks[next++]!); return; } if ((answer.end ?? 'close') === 'close') controller.close(); else return new Promise<void>(() => undefined); } }, { highWaterMark: 0 });
    return new Response(stream, { status: answer.status ?? 200 });
  });
  const service = new RuntimeService(store, new RepositoryService(join(scratch, 'wt')), event => notifications.push(event), kind => kind === 'fake' ? createProvider('fake') : createProvider(kind, { fetch }));
  const recorded: unknown[] = [];
  let pending: Promise<unknown> | undefined;
  try {
    let before = tables(); let seen = 0; let sent = 0;
    for (const step of item.steps) {
      let value: unknown = null; let error: string | null = null;
      try {
        if (step.method === 'credential') {
          const stored = store.profile(step.params.id);
          const binding = step.params.binding ?? (stored ? JSON.stringify([stored.apiKind, stored.endpoint, stored.deployment]) : '[]');
          const secret = step.params.value === '{credential}' ? credential : step.params.value === '{credential:2}' ? second : step.params.value;
          service.setCredential(step.params.id, secret, binding);
          await service.flushCredentialRepairs();
        } else if (step.method === 'clear-mcp') {
          store.db.prepare('DELETE FROM mcp_servers').run();
        } else if (step.method === 'probe-start') {
          answers = [...step.answers];
          pending = service.dispatch('profile.probe', step.params).then(result => ({ result }), (cause: Error) => ({ error: cause.message }));
          while (!release) await new Promise(resolve => setTimeout(resolve, 1));
          value = { started: true };
        } else if (step.method === 'release') {
          release!(); release = undefined; held = undefined;
          const outcome = await pending! as { result?: unknown; error?: string };
          pending = undefined;
          value = outcome.result ?? null; error = outcome.error ?? null;
        } else {
          if (step.method === 'profile.probe' && step.answers) answers = [...step.answers, ...answers];
          value = await service.dispatch(step.method as RpcMethod, step.params);
        }
      } catch (cause) { error = (cause as Error).message; }
      // A probe consumes its own answers; a held probe keeps the rest of its queue for after its release.
      if (step.method === 'profile.probe' && !pending) answers = [];
      const after = tables();
      recorded.push({ ...step, expected: JSON.parse(secrets(JSON.stringify({ value, error, delta: delta(before, after), notifications: notifications.slice(seen), provider: requests.slice(sent) }))) });
      before = after; seen = notifications.length; sent = requests.length;
    }
    return recorded;
  } finally {
    release?.();
    await pending?.catch(() => undefined);
    await service.shutdown(); vi.useRealTimers();
    rmSync(scratch, { recursive: true, force: true });
  }
}

it('pins profile saves, credential frames and probes through the shipping Node authority', async () => {
  const recorded = [];
  for (const item of cases) recorded.push({ name: item.name, era: item.era, steps: await run(item) });
  const sources = ['packages/runtime/src/service.ts', 'packages/runtime/src/profile-fingerprint.ts', 'packages/runtime/src/usage-ledger.ts', 'packages/runtime/src/store.ts', 'packages/providers/src/index.ts', 'packages/protocol/src/limits.ts'];
  const corpus = { timestamp, oracle: { sources: sources.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) }, cases: recorded };
  const text = JSON.stringify(corpus, null, 2) + '\n';
  if (process.env.P2_WRITE_PROFILES === '1') writeFileSync('tests/p2/profile-vectors.json', text);
  expect(readFileSync('tests/p2/profile-vectors.json', 'utf8')).toBe(text);
}, 300_000);
