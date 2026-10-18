import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createProvider } from '../../packages/providers/src/index';
import { FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import type { ModelProfile, ProviderContinuation, ProviderEvent, ProviderMessage } from '../../packages/protocol/src/index';
import { regenerating } from './oracle-node.mjs';

type Input = { messages: ProviderMessage[]; continuation?: ProviderContinuation; abortBefore?: boolean; cancelAfterTexts?: number };
const user = (content: string): ProviderMessage => ({ role: 'user', content });
const inputs: Input[] = [
  { messages: [] }, { messages: [user('')] }, { messages: [user('   ')] }, { messages: [user('hello')] },
  { messages: [user('earlier'), { role: 'assistant', content: 'ignore' }, user('latest'), { role: 'system', content: 'ignore' }] },
  { messages: [user('earlier'), user('')] },
  ...['12345678😀x', '😀'.repeat(14), '\ud800x\udfff', '\\"\n\r\t', 'é文件'.repeat(15)].map(content => ({ messages: [user(content)] })),
  ...[null, [], 'not an object', {}, { stage: 3 }, { stage: 'unknown', calls: [] }, { stage: 'chat', calls: [null] },
    { stage: 'chat', calls: [{ id: 3, name: 'x' }] }, { stage: 'chat', calls: [{ id: 'x', name: 3 }] },
    { stage: 'complete', calls: [] }, { stage: 'chat', calls: 'not an array' },
    { stage: 'chat', calls: [{ id: 'x', name: 'x', arguments: { opaque: true } }], future: { retained: [null, 1] } }
  ].map(data => ({ messages: [user('continuation')], continuation: { apiKind: 'fake' as const, data } })),
  { messages: [user('wrong provider')], continuation: { apiKind: 'chat-completions', data: { stage: 'chat', calls: [] } } },
  { messages: [user('aborted')], abortBefore: true },
  { messages: [user('aborted')], continuation: { apiKind: 'fake', data: null }, abortBefore: true },
  { messages: [user('x')], cancelAfterTexts: 1 },
  { messages: [user('x')], cancelAfterTexts: 2 }
];
const profile: ModelProfile = { id: FAKE_PROFILE_ID, name: 'Offline fixture', apiKind: 'fake', endpoint: '', deployment: 'fixture', contextLimit: 32000, outputLimit: 2048 };
it('pins the no-tools fake text/continuation slice, UTF16 chunks and cancellation outcomes', async () => {
  const cases = [];
  for (const [index, input] of inputs.entries()) {
    const controller = new AbortController(); if (input.abortBefore) controller.abort();
    const events: ProviderEvent[] = []; let error: string | null = null, texts = 0;
    try {
      for await (const event of createProvider('fake').streamTurn({ profile, messages: input.messages, ...(input.continuation ? { continuation: input.continuation } : {}), signal: controller.signal })) {
        events.push(event);
        if (event.type === 'text' && ++texts === input.cancelAfterTexts) controller.abort();
      }
    } catch (caught) { if (!(caught instanceof Error)) throw caught; error = caught.message; }
    cases.push({ name: `fake-chat:${index}`, input, expected: { events, error } });
  }
  if (regenerating('P2_WRITE_FAKE')) writeFileSync('tests/p2/fake-chat-vectors.json', JSON.stringify(cases, null, 2) + '\n');
  expect(JSON.parse(readFileSync('tests/p2/fake-chat-vectors.json', 'utf8'))).toEqual(cases);
});
