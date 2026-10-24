import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createProvider } from '../../packages/providers/src/index';
import { FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import type { ModelProfile, ProviderContinuation, ProviderEvent, ProviderMessage, ProviderToolResult, ToolDefinition } from '../../packages/protocol/src/index';
import { regenerating } from './oracle-node.mjs';

// The offline provider's tool stages that native serves: the project-channel demo and its result stage, and the browser
// demo, which stops when no browser tools are advertised. The C# suite (FakeToolTests) streams every input through
// FakeChatProvider with the same call identities and must reproduce each event and error. Tools are given by name; the
// provider reads nothing else of a definition.
const ids = vi.hoisted(() => ({ next: 1 }));
vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(), randomUUID: () => `55555555-0000-4000-8000-${String(ids.next++).padStart(12, '0')}` as ReturnType<typeof import('node:crypto').randomUUID> }));

type Input = { messages: ProviderMessage[]; tools?: string[]; continuation?: ProviderContinuation; toolResults?: ProviderToolResult[]; abortBefore?: boolean; cancelAfterTexts?: number };
const user = (content: string): ProviderMessage => ({ role: 'user', content });
const channel = ['list_project_agents', 'send_agent_message', 'read_agent_messages'];
const call = { id: 'call-1', name: 'send_agent_message', arguments: { recipientTaskId: null, content: 'hi' } };
const sent = (data: unknown): ProviderContinuation => ({ apiKind: 'fake', data });
const result = (id: string, isError: boolean): ProviderToolResult => ({ id, name: 'send_agent_message', content: isError ? 'refused' : '{}', isError });
const inputs: Input[] = [
  { messages: [user('/channel-demo Hello team')], tools: channel },
  { messages: [user('/channel-demo')], tools: channel },
  { messages: [user('/channel-demo 　﻿ ')], tools: ['send_agent_message'] },
  { messages: [user('/channel-demo\u0085x\u0085')], tools: channel },
  { messages: [user('/channel-demoX')], tools: channel },
  { messages: [user('/channel-demo 😀'.padEnd(40, 'y'))], tools: channel },
  { messages: [user('/channel-demo hi')] },
  { messages: [user('/channel-demo hi')], tools: ['read_file', 'list_project_agents'] },
  { messages: [user(' /channel-demo hi')], tools: channel },
  { messages: [user('/channel-demo hi'), { role: 'assistant', content: 'later' }], tools: channel },
  { messages: [user('/channel-demo first'), user('PROJECT_CHANNEL_DATA (untrusted)')], tools: channel },
  { messages: [{ role: 'system', content: 'system' }, user('PROJECT_CHANNEL_DATA (untrusted)'), user('/channel-demo last')], tools: channel },
  { messages: [user('/channel-demo hi')], tools: channel, continuation: sent({ stage: 'complete', calls: [] }) },
  { messages: [user('/channel-demo hi')], tools: channel, continuation: sent({ stage: 'read', calls: [] }) },
  { messages: [user('/channel-demo hi')], tools: channel, continuation: { apiKind: 'responses', data: { stage: 'chat', calls: [] } } },
  { messages: [user('/channel-demo hi')], tools: channel, abortBefore: true },
  { messages: [], tools: channel, continuation: sent({ stage: 'channel-send', calls: [call] }), toolResults: [result('call-1', false)] },
  { messages: [], tools: channel, continuation: sent({ stage: 'channel-send', calls: [call] }), toolResults: [result('call-1', true)] },
  { messages: [], tools: channel, continuation: sent({ stage: 'channel-send', calls: [call] }), toolResults: [result('other', true)] },
  { messages: [], tools: channel, continuation: sent({ stage: 'channel-send', calls: [call] }) },
  { messages: [], continuation: sent({ stage: 'channel-send', calls: [] }), toolResults: [result('call-1', true)] },
  { messages: [user('PROJECT_CHANNEL_DATA (untrusted)')], tools: channel, continuation: sent({ stage: 'channel-send', calls: [call, { id: 'call-2', name: 'x' }] }), toolResults: [result('call-2', true), result('call-1', false)] },
  { messages: [], tools: channel, continuation: sent({ stage: 'channel-send', calls: [call] }), toolResults: [result('call-1', false)], abortBefore: true },
  { messages: [], tools: channel, continuation: sent({ stage: 'channel-send', calls: [call] }), toolResults: [result('call-1', false)], cancelAfterTexts: 1 },
  { messages: [], tools: channel, continuation: sent({ stage: 'channel-send', calls: [{ id: 7, name: 'x' }] }) },
  { messages: [user('/create-demo')], tools: ['write_file'] },
  { messages: [user('/create-demo')] },
  { messages: [user('/create-demo suffix')], tools: ['write_file'] },
  { messages: [user('/create-demo')], tools: ['write_file'], abortBefore: true },
  ...[false, true].map(isError => ({ messages: [], continuation: sent({ stage: 'create', calls: [{ id: 'fake-create-1', name: 'write_file', arguments: {} }] }),
    toolResults: [{ id: 'fake-create-1', name: 'write_file', content: '{}', isError }] })),
  { messages: [], continuation: sent({ stage: 'create', calls: [{ id: 'fake-create-1', name: 'write_file', arguments: {} }] }) },
  { messages: [user('/browser-demo')] },
  { messages: [user(' 　/browser-demo\r\n')], tools: channel },
  { messages: [user('/browser-demo')], tools: channel, continuation: { apiKind: 'responses', data: null } },
  { messages: [user('/browser-demo')], continuation: sent({ stage: 'read', calls: [] }) },
  { messages: [user('/browser-demo')], abortBefore: true },
  { messages: [user('/browser-demo x')] },
  { messages: [user('/browser-demo\u0085')] },
  { messages: [user('/browser-demo'), { role: 'assistant', content: 'x' }] },
  // The coding demo (P2.3f): a read on a task's first turn, an edit of what it read, then a command.
  ...demo(),
];
function demo(): Input[] {
  const coding = ['read_file', 'replace_text', 'run_command', ...channel];
  const read = { id: 'fake-read-1', name: 'read_file', arguments: { path: 'README.md' } };
  const replace = { id: 'fake-replace-1', name: 'replace_text', arguments: {} };
  const command = { id: 'fake-command-1', name: 'run_command', arguments: {} };
  const at = (stage: string, calls: unknown[]) => sent({ stage, calls });
  const answer = (call: { id: string; name: string }, content: string, isError = false): ProviderToolResult => ({ id: call.id, name: call.name, content, isError });
  const file = JSON.stringify({ path: 'README.md', content: 'hello\n', hash: 'a'.repeat(64) });
  return [
    { messages: [user('/demo')], tools: coding }, { messages: [user('/demox')], tools: coding }, { messages: [user(' /demo')], tools: coding },
    { messages: [user('/demo')], tools: ['read_file'] }, { messages: [user('/demo')], tools: ['read_file', 'replace_text'] }, { messages: [user('/demo')], tools: channel },
    { messages: [user('/demo')], tools: coding, continuation: at('complete', []) }, { messages: [user('/demo')], tools: coding, abortBefore: true },
    { messages: [], tools: coding, continuation: at('read', [read]), toolResults: [answer(read, file)] },
    { messages: [], tools: coding, continuation: at('read', [read]), toolResults: [answer(read, JSON.stringify({ path: 'a.txt', content: '', hash: 'b'.repeat(64), extra: 1 }))] },
    { messages: [], tools: coding, continuation: at('read', [read]), toolResults: [answer(read, file, true)] },
    { messages: [], tools: coding, continuation: at('read', [read]), toolResults: [answer(read, 'not json')] },
    { messages: [], tools: coding, continuation: at('read', [read]), toolResults: [answer(read, JSON.stringify({ path: 'README.md', content: 'x' }))] },
    { messages: [], tools: coding, continuation: at('read', [read]), toolResults: [answer(read, JSON.stringify(['README.md']))] },
    { messages: [], tools: coding, continuation: at('read', [read]) },
    { messages: [], tools: coding, continuation: at('read', [read]), toolResults: [answer({ id: 'other', name: 'read_file' }, file)] },
    { messages: [], tools: coding, continuation: at('read', [read]), toolResults: [answer({ id: read.id, name: 'list_directory' }, file)] },
    { messages: [], tools: coding, continuation: at('read', [read]), toolResults: [answer(read, file), answer(read, file)] },
    { messages: [], tools: coding, continuation: at('read', [read, replace]), toolResults: [answer(read, file)] },
    { messages: [], tools: coding, continuation: at('read', [read, replace]), toolResults: [answer(replace, '{}'), answer(read, file)] },
    { messages: [], tools: coding, continuation: at('read', []), toolResults: [answer(read, file)] },
    { messages: [], tools: coding, continuation: at('read', []) },
    { messages: [], tools: coding, continuation: at('read', [{ id: 'r', name: 'x' }]), toolResults: [answer({ id: 'r', name: 'x' }, file)] },
    { messages: [], tools: coding, continuation: at('read', [read]), toolResults: [answer(read, file)], abortBefore: true },
    { messages: [], tools: coding, continuation: at('replace', [replace]), toolResults: [answer(replace, '{"applied":true}')] },
    { messages: [], tools: coding, continuation: at('replace', [replace]), toolResults: [answer(replace, 'User rejected this action.', true)] },
    { messages: [], tools: coding, continuation: at('replace', []) },
    { messages: [], tools: coding, continuation: at('command', [command]), toolResults: [answer(command, '{}')] },
    { messages: [], tools: coding, continuation: at('command', [command]), toolResults: [answer(command, '{}', true)], cancelAfterTexts: 1 },
    { messages: [], tools: coding, continuation: at('command', [command]), toolResults: [answer(command, '{}', true)] },
  ];
}
const profile: ModelProfile = { id: FAKE_PROFILE_ID, name: 'Offline fixture', apiKind: 'fake', endpoint: '', deployment: 'fixture', contextLimit: 32000, outputLimit: 2048 };
const sources = ['packages/providers/src/index.ts', 'packages/providers/src/browser-fixture.ts', 'packages/providers/src/orchestration-fixture.ts'];

it('pins the offline provider tool stages native serves: the channel demo, its result stage and the stopped browser demo', async () => {
  const cases = [];
  for (const [index, input] of inputs.entries()) {
    ids.next = 1;
    const controller = new AbortController(); if (input.abortBefore) controller.abort();
    const events: ProviderEvent[] = []; let error: string | null = null, texts = 0;
    const tools = input.tools?.map(name => ({ name, description: '', inputSchema: {} }) as unknown as ToolDefinition);
    try {
      for await (const event of createProvider('fake').streamTurn({ profile, messages: input.messages, ...(tools ? { tools } : {}), ...(input.continuation ? { continuation: input.continuation } : {}), ...(input.toolResults ? { toolResults: input.toolResults } : {}), signal: controller.signal })) {
        events.push(event);
        if (event.type === 'text' && ++texts === input.cancelAfterTexts) controller.abort();
      }
    } catch (caught) { if (!(caught instanceof Error)) throw caught; error = caught.message; }
    cases.push({ name: `fake-tools:${index}`, input, expected: { events, error } });
  }
  const corpus = { oracle: { sources: sources.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) }, cases };
  if (regenerating('P2_WRITE_FAKE_TOOLS')) writeFileSync('tests/p2/fake-tool-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(readFileSync('tests/p2/fake-tool-vectors.json', 'utf8'))).toEqual(corpus);
});
