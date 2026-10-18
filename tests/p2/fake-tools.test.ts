import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createProvider } from '../../packages/providers/src/index';
import { FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import type { ModelProfile, ProviderContinuation, ProviderEvent, ProviderMessage, ProviderToolResult, ToolDefinition } from '../../packages/protocol/src/index';

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
  { messages: [user('/browser-demo')] },
  { messages: [user(' 　/browser-demo\r\n')], tools: channel },
  { messages: [user('/browser-demo')], tools: channel, continuation: { apiKind: 'responses', data: null } },
  { messages: [user('/browser-demo')], continuation: sent({ stage: 'read', calls: [] }) },
  { messages: [user('/browser-demo')], abortBefore: true },
  { messages: [user('/browser-demo x')] },
  { messages: [user('/browser-demo\u0085')] },
  { messages: [user('/browser-demo'), { role: 'assistant', content: 'x' }] },
];
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
  if (process.env.P2_WRITE_FAKE_TOOLS === '1') writeFileSync('tests/p2/fake-tool-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(readFileSync('tests/p2/fake-tool-vectors.json', 'utf8'))).toEqual(corpus);
});
