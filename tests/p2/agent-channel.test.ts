import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ProviderRequest, Task, ToolCall } from '../../packages/protocol/src/index';
import { CHANNEL_SYSTEM, CHANNEL_TOOL_DEFINITIONS } from '../../packages/runtime/src/channel-tools';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import type { ToolRuntime } from '../../packages/runtime/src/tool-runtime';
import { build, file, sha256File, type Step } from './repository-fixture';

// The project channel of the shipping TypeScript runtime (agent-channel.ts, channel-tools.ts), pinned for the C# port
// (AgentChannelTests): the channel tool definitions and system text byte for byte, then channel.get and channel.send
// through RuntimeService, the three channel tools through its ToolRuntime, and enrich/acknowledge on the same channel,
// over a disposable tree of Git metadata folders (admission reads pointers and never runs Git). Each case records every
// step's value or refusal and the event rows it adds. Tasks are bound as trusted admission binds them, except a legacy
// task (no binding), and an incomplete binding (no path). Outputs are cleaned: scratch paths become {scratch}, each
// project key that TypeScript's formula gives for the fixture's common directories becomes {project:a} or {project:b}, and
// each timestamp becomes {time}. Node's raw filesystem errors are recorded as { systemError }.
const stamp = '2026-01-01T00:00:00.000Z';
const id = (n: number) => `15151515-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tree: Step[] = [
  { dir: 'a/.git' }, { dir: 'a/sub' }, { dir: 'b/.git' }, { dir: 'plain' },
  // A linked worktree of a: its .git file points into a's worktrees folder, whose commondir names a's .git.
  file('wt/.git', 'gitdir: ../a/.git/worktrees/wt\n'), file('a/.git/worktrees/wt/commondir', '../..\n'),
];
// raw is a channel.identity row's data as stored, with {task} for the task's id: rows SQLite reads but the strict reader
// refuses (JSON5), rows SQLite cannot read, and identities that are not objects.
type Seed = { n: number; title: string; at: string; binding?: 'full' | 'direct' | 'incomplete' | 'incomplete-then-full'; raw?: string; extra?: Record<string, unknown> };
const seeds: Seed[] = [
  { n: 1, title: 'Alpha', at: 'a', binding: 'full' }, { n: 2, title: 'Beta', at: 'a', binding: 'full' },
  { n: 3, title: 'Gamma idle', at: 'a', binding: 'full', extra: { status: 'idle' } }, { n: 4, title: 'Sub folder', at: 'a/sub', binding: 'full' },
  { n: 5, title: 'Other project', at: 'b', binding: 'full' }, { n: 6, title: 'Linked worktree', at: 'wt', binding: 'full' },
  { n: 7, title: 'Retired', at: 'a', binding: 'full', extra: { status: 'retired', retiredAt: stamp } }, { n: 8, title: 'Cancelled', at: 'a', binding: 'full', extra: { status: 'cancelled' } },
  { n: 9, title: 'Legacy plain', at: 'a' }, { n: 10, title: 'Legacy linked', at: 'wt' },
  { n: 11, title: 'Folder', at: 'plain', extra: { workspaceKind: 'folder' } }, { n: 12, title: 'Incomplete binding', at: 'a', binding: 'incomplete' },
  { n: 14, title: 'Coordinator', at: 'a', binding: 'full', extra: { mode: 'coordinated' } },
  { n: 13, title: 'Child', at: 'a', extra: { role: 'child', parentTaskId: id(14), rootTaskId: id(14) } },
  { n: 15, title: 'Chat', at: 'a', binding: 'full', extra: { mode: 'chat' } }, { n: 16, title: 'Token api_key=fixture-secret-value', at: 'a', binding: 'full' },
  // A child in the linked worktree falls back to its root's binding, whose approved folder is another.
  { n: 17, title: 'Child linked', at: 'wt', extra: { role: 'child', parentTaskId: id(14), rootTaskId: id(14) } },
  // A task created after every message: its inbox holds none of them.
  { n: 18, title: 'Late joiner', at: 'a', binding: 'full', extra: { createdAt: '2099-01-01T00:00:00.000Z' } },
  // The first binding wins: an incomplete one, then a complete one.
  { n: 19, title: 'Rebound', at: 'a', binding: 'incomplete-then-full' },
];
type Op =
  | { op: 'get'; task: number; before?: number; afterTask?: number }
  | { op: 'send'; task: number; request: number; recipient?: number | null; content: string }
  | { op: 'tool'; task: number; name: string; arguments: unknown }
  | { op: 'enrich'; task: number; contextLimit: number }
  // Acknowledges the cursor the previous enrich returned, as a successful provider response does.
  | { op: 'acknowledge'; task: number }
  | { op: 'fill'; task: number; count: number }
  // A message row written outside send, with a raw secret-like title and content: pages redact both.
  | { op: 'plant'; task: number };
const request = (n: number) => `16161616-0000-4000-8000-${String(n).padStart(12, '0')}`;
const send = (task: number, n: number, content: string, recipient?: number | null): Op => ({ op: 'send', task, request: n, content, ...(recipient !== undefined ? { recipient } : {}) });
const tool = (task: number, name: string, args: unknown): Op => ({ op: 'tool', task, name, arguments: args });
const cases: { name: string; seeds: Seed[]; ops: Op[] }[] = [
  { name: 'discovery, sends, reads and context', seeds, ops: [
    { op: 'get', task: 1 }, send(1, 1, 'Hello team'), send(1, 1, 'Hello team'), send(1, 1, 'Changed text'), send(1, 2, '  Direct note  ', 2),
    send(1, 3, 'Elsewhere', 5), send(1, 4, 'To myself', 1), send(1, 5, 'To the retired', 7), send(1, 6, 'To nobody', 99), send(3, 7, 'From the idle task'),
    send(7, 8, 'From the retired task'), send(1, 9, 'key api_key=fixture-secret-value'), send(15, 10, 'From the chat task'), send(9, 11, 'From the legacy task'),
    send(10, 12, 'From the legacy linked task'), send(11, 13, 'From the folder task'), send(12, 14, 'From the incomplete binding'), send(16, 15, 'From the secret title'),
    tool(2, 'list_project_agents', {}), tool(2, 'send_agent_message', { recipientTaskId: id(1), content: 'Reply from Beta' }), tool(2, 'send_agent_message', { recipientTaskId: id(1), content: 'Reply from Beta' }),
    tool(3, 'send_agent_message', { content: 'Idle agent' }), tool(2, 'send_agent_message', { content: '' }), tool(2, 'send_agent_message', { content: 'x', extra: 1 }),
    tool(2, 'send_agent_message', { recipientTaskId: 'nope', content: 'x' }), tool(2, 'send_agent_message', { content: 'api_key=fixture-secret-value' }),
    tool(2, 'send_agent_message', { content: 'é'.repeat(1100) }), tool(2, 'read_agent_messages', { after: -1 }), tool(2, 'list_project_agents', { afterTaskId: 'x' }),
    // zod's uuid: a version 1 to 8 with an RFC variant, in either case; the nil UUID; the max UUID in lower case only.
    tool(2, 'send_agent_message', { recipientTaskId: '15151515-0000-0000-8000-000000000001', content: 'x' }), tool(2, 'send_agent_message', { recipientTaskId: '15151515-0000-4000-c000-000000000001', content: 'x' }),
    tool(2, 'send_agent_message', { recipientTaskId: 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', content: 'x' }), tool(2, 'send_agent_message', { recipientTaskId: '00000000-0000-0000-0000-000000000000', content: 'x' }),
    tool(2, 'list_project_agents', { afterTaskId: '15151515-0000-4000-8000-00000000000A' }),
    // An agent's own broadcast never comes back to it as model context.
    tool(2, 'send_agent_message', { content: 'Beta broadcast as an agent' }), { op: 'plant', task: 1 },
    tool(1, 'read_agent_messages', {}), tool(1, 'read_agent_messages', { after: 2 }), tool(4, 'read_agent_messages', {}), tool(6, 'read_agent_messages', {}), tool(5, 'read_agent_messages', {}),
    tool(15, 'list_project_agents', { afterTaskId: id(4) }), tool(11, 'read_agent_messages', {}),
    { op: 'get', task: 2 }, { op: 'get', task: 4 }, { op: 'get', task: 6 }, { op: 'get', task: 5 }, { op: 'get', task: 9 }, { op: 'get', task: 10 }, { op: 'get', task: 11 },
    { op: 'get', task: 12 }, { op: 'get', task: 13 }, { op: 'get', task: 7 }, { op: 'get', task: 99 }, { op: 'get', task: 1, afterTask: 6 },
    { op: 'enrich', task: 2, contextLimit: 128000 }, { op: 'acknowledge', task: 2 }, { op: 'enrich', task: 2, contextLimit: 128000 },
    send(1, 16, '\u0001'.repeat(2000), 2), { op: 'enrich', task: 2, contextLimit: 4000 }, { op: 'acknowledge', task: 2 }, { op: 'enrich', task: 2, contextLimit: 128000 }, { op: 'enrich', task: 7, contextLimit: 128000 },
    { op: 'enrich', task: 4, contextLimit: 128000 }, { op: 'enrich', task: 1, contextLimit: 128000 },
    { op: 'get', task: 17 }, { op: 'get', task: 19 }, { op: 'enrich', task: 18, contextLimit: 128000 },
    // The cut lands among astral characters: it counts code points, never splitting a pair.
    { op: 'acknowledge', task: 2 }, send(1, 17, '\u0001'.repeat(400) + '\u{1F600}'.repeat(400), 2), { op: 'enrich', task: 2, contextLimit: 4000 },
  ] },
  { name: 'message pages', seeds: seeds.slice(0, 3), ops: [
    ...Array.from({ length: 25 }, (_, index) => send(1 + (index % 2), 100 + index, `Broadcast ${index}`)), send(1, 200, 'Direct to Beta', 2),
    { op: 'get', task: 3 }, { op: 'get', task: 3, before: 8 }, { op: 'get', task: 3, before: 1 }, { op: 'get', task: 2 }, tool(3, 'read_agent_messages', {}),
    tool(2, 'read_agent_messages', {}), tool(2, 'read_agent_messages', { after: 21 }), { op: 'enrich', task: 2, contextLimit: 128000 },
  ] },
  { name: 'participant pages', seeds: Array.from({ length: 55 }, (_, index) => ({ n: index + 1, title: `Agent ${index + 1}`, at: 'a', binding: 'full' as const })), ops: [
    { op: 'get', task: 1 }, { op: 'get', task: 1, afterTask: 50 }, { op: 'get', task: 1, afterTask: 55 }, tool(1, 'list_project_agents', {}), tool(1, 'list_project_agents', { afterTaskId: id(50) }),
  ] },
  // Pages and refusals both runtimes give alike; a row that does not parse refuses its own task with the reader's error
  // in TypeScript and a fixed message natively, so those tasks appear only as the pages they are left out of.
  { name: 'unusual binding rows', seeds: [
    { n: 1, title: 'Alpha', at: 'a', binding: 'full' }, { n: 2, title: 'Beta', at: 'a', binding: 'full' },
    { n: 3, title: 'JSON5 binding', at: 'a', raw: '{taskId:"{task}",identity:{}}' }, { n: 4, title: 'String identity', at: 'a', raw: '{"taskId":"{task}","identity":"bound"}' },
    { n: 5, title: 'Zero identity', at: 'a', raw: '{"taskId":"{task}","identity":0}' }, { n: 6, title: 'No identity', at: 'a', raw: '{"taskId":"{task}"}' },
    { n: 8, title: 'Array identity', at: 'a', raw: '{"taskId":"{task}","identity":[]}' }, { n: 12, title: 'Other project', at: 'b', binding: 'full' },
    { n: 11, title: 'Child of JSON5', at: 'a', extra: { role: 'child', parentTaskId: id(3), rootTaskId: id(3) } },
    // A row SQLite cannot read: a lookup that scans past it fails, so the task bound after it is left out too.
    { n: 9, title: 'Unreadable', at: 'a', raw: 'not json' }, { n: 10, title: 'After the unreadable row', at: 'a', binding: 'direct' },
  ], ops: [
    { op: 'get', task: 1 }, { op: 'get', task: 4 }, { op: 'get', task: 5 }, { op: 'get', task: 6 }, { op: 'get', task: 8 }, { op: 'get', task: 12 },
    send(6, 1, 'From the task without an identity'), send(2, 2, 'From Beta'), tool(2, 'list_project_agents', {}), tool(5, 'read_agent_messages', {}),
  ] },
  { name: 'message limit', seeds: seeds.slice(0, 2), ops: [{ op: 'fill', task: 1, count: 999 }, send(1, 1, 'The thousandth'), send(1, 2, 'One too many'), send(1, 1, 'The thousandth'), send(2, 3, 'Another sender')] },
];

it('pins the project channel: definitions, channel.get/send, channel tools and model context through the shipping Node authority', async () => {
  const vectors = [];
  for (const item of cases) {
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-channel-')));
    try {
      build(scratch, path.join(scratch, 'home'), tree);
      fs.mkdirSync(path.join(scratch, 'data'));
      const store = new Store(path.join(scratch, 'data', 'workspace.db'));
      const service = new RuntimeService(store, new RepositoryService(path.join(scratch, 'data', 'wt')), () => {});
      const tools = (service as unknown as { tools: ToolRuntime }).tools;
      const channel = tools.channel;
      for (const seed of item.seeds) {
        const projectPath = path.join(scratch, seed.at);
        const task = store.saveTask({ id: id(seed.n), title: seed.title, profileId: FAKE_PROFILE_ID, status: 'running', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0,
          mode: 'coding', workspaceKind: 'git', projectPath, worktreePath: projectPath, branch: 'fixture', baseCommit: 'a'.repeat(40), ...seed.extra } as Task);
        if (seed.raw !== undefined) store.db.prepare("INSERT INTO intents VALUES (?, 'channel.identity', ?, 'complete')").run(`raw-${seed.n}`, seed.raw.replaceAll('{task}', task.id));
        if (seed.binding === 'full') channel.admit(task, channel.prepareAdmission(projectPath));
        // admit reads the task's bindings, which a row SQLite cannot read now fails: the same row, written directly.
        if (seed.binding === 'direct') store.finishIntent(store.intent('channel.identity', { taskId: task.id, identity: channel.prepareAdmission(projectPath) }), 'complete');
        if (seed.binding === 'incomplete' || seed.binding === 'incomplete-then-full') {
          const full = channel.prepareAdmission(projectPath); const { path: _, ...identity } = full;
          store.finishIntent(store.intent('channel.identity', { taskId: task.id, identity }), 'complete');
          if (seed.binding === 'incomplete-then-full') store.finishIntent(store.intent('channel.identity', { taskId: task.id, identity: full }), 'complete');
        }
      }
      // A project key is TypeScript's formula over this run's common directory: only keys that match it become placeholders.
      const projects = new Map(['a', 'b'].map(name => [createHash('sha256').update(path.join(scratch, name, '.git').toLowerCase()).digest('hex'), `{project:${name}}`]));
      const clean = (value: unknown): unknown => {
        if (typeof value === 'string') {
          let text = value.replaceAll(scratch.replaceAll('\\', '\\\\'), '{scratch-json}').replaceAll(scratch, '{scratch}');
          for (const [key, name] of projects) text = text.replaceAll(key, name);
          return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '{time}');
        }
        if (Array.isArray(value)) return value.map(clean);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clean(entry)]));
        return value;
      };
      const outcome = (error: unknown) => {
        const message = (error as Error).message; const code = /^(E[A-Z]+): /.exec(message)?.[1];
        return code ? { systemError: code } : { error: message };
      };
      const steps = []; let lastCursor: number | undefined;
      for (const op of item.ops) {
        const sequence = (store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM events').get() as { value: number }).value;
        let result: Record<string, unknown>;
        try {
          if (op.op === 'get') result = { value: await service.dispatch('channel.get', { taskId: id(op.task), ...(op.before ? { before: op.before } : {}), ...(op.afterTask ? { afterTaskId: id(op.afterTask) } : {}) }) };
          else if (op.op === 'send') result = { value: await service.dispatch('channel.send', { taskId: id(op.task), requestId: request(op.request), ...(op.recipient !== undefined ? { recipientTaskId: op.recipient === null ? null : id(op.recipient) } : {}), content: op.content }) };
          else if (op.op === 'tool') {
            const done = await tools.execute(store.task(id(op.task)), { id: `call-${steps.length + 1}`, name: op.name, arguments: op.arguments } as ToolCall, new AbortController().signal);
            result = { value: done };
          } else if (op.op === 'enrich') {
            const enriched = channel.enrich(store.task(id(op.task)), { profile: { ...store.profile(FAKE_PROFILE_ID)!, contextLimit: op.contextLimit }, signal: new AbortController().signal,
              messages: [{ role: 'system', content: 'Trusted system instructions' }, { role: 'user', content: 'Continue' }] } as ProviderRequest);
            lastCursor = enriched.channelCursor;
            result = { value: { channelCursor: enriched.channelCursor, messages: enriched.messages } };
          } else if (op.op === 'acknowledge') { channel.acknowledge(id(op.task), lastCursor); result = { value: lastCursor ?? null }; }
          else if (op.op === 'plant') {
            const project = createHash('sha256').update(path.join(scratch, 'a', '.git').toLowerCase()).digest('hex');
            store.event('channel.message', { recipientTaskId: null, content: 'Planted password=fixture-secret-value', project, callId: 'planted', actor: 'user', senderTitle: 'Planted api_key=fixture-secret-value' }, id(op.task));
            result = { value: null };
          } else { for (let index = 0; index < op.count; index++) store.event('channel.message', { recipientTaskId: null, content: `Filler ${index}`, project: 'f'.repeat(64), callId: `fill-${index}`, actor: 'user', senderTitle: 'Filler' }, id(op.task)); result = { value: null }; }
        } catch (error) { result = outcome(error); }
        const events = op.op === 'fill' ? [] : store.db.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence').all(sequence);
        steps.push(clean({ ...op, ...result, events }));
      }
      await service.shutdown();
      vectors.push({ name: item.name, seeds: item.seeds, steps });
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  const corpus = {
    schemaVersion: 1,
    oracle: { sources: ['packages/runtime/src/agent-channel.ts', 'packages/runtime/src/channel-tools.ts', 'packages/protocol/src/agent-channel.ts', 'packages/protocol/src/limits.ts', 'packages/runtime/src/tool-runtime.ts',
      'packages/runtime/src/repository.ts', 'packages/runtime/src/redaction.ts', 'packages/runtime/src/store.ts', 'packages/runtime/src/service.ts'].map(source => ({ path: source, sha256: sha256File(source) })) },
    stamp, tree, definitions: JSON.stringify(CHANNEL_TOOL_DEFINITIONS), system: CHANNEL_SYSTEM, cases: vectors,
  };
  const target = 'tests/p2/agent-channel-vectors.json';
  if (process.env.P2_WRITE_AGENT_CHANNEL === '1') fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(JSON.parse(JSON.stringify(corpus)));
}, 600_000);
