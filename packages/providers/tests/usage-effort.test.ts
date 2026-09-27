import { describe, expect, it, vi } from 'vitest';
import type { ModelProfile, ProviderEvent } from '../../protocol/src/index.js';
import { createProvider, profileFingerprint } from '../src/index.js';

const profile = (apiKind: ModelProfile['apiKind'], effort?: ModelProfile['effort']): ModelProfile => ({
  id: '0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53', name: 'Test', apiKind,
  endpoint: apiKind === 'fake' ? 'offline://fake' : 'https://sample.openai.azure.com',
  deployment: 'configured-deployment', contextLimit: 4096, outputLimit: 1024,
  ...(effort === undefined ? {} : { effort })
});
const sse = (...frames: string[]): ReadableStream<Uint8Array> => new ReadableStream({ start(controller) {
  const encoder = new TextEncoder(); for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close();
} });
async function collect(apiKind: ModelProfile['apiKind'], frames: string[], effort?: ModelProfile['effort']) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(...frames)));
  const events: ProviderEvent[] = [];
  for await (const event of createProvider(apiKind, { fetch }).streamTurn({ profile: profile(apiKind, effort), credential: 'secret', messages: [{ role: 'user', content: 'Hi' }], signal: new AbortController().signal })) events.push(event);
  return { events, body: JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as Record<string, unknown> };
}

describe('effort and measured provider usage', () => {
  it('rejects max effort on Chat Completions before making a provider call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const request = { profile: profile('chat-completions', 'max'), credential: 'secret', messages: [], signal: new AbortController().signal };
    const consume = async () => { for await (const event of createProvider('chat-completions', { fetch }).streamTurn(request)) void event; };
    await expect(consume()).rejects.toThrow(/effort/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['responses', 'reasoning', { effort: 'high' }],
    ['chat-completions', 'reasoning_effort', 'high'],
    ['anthropic', 'output_config', { effort: 'high' }]
  ] as const)('maps explicit effort for %s and omits provider default', async (kind, key, value) => {
    const frames = kind === 'responses'
      ? ['event: response.completed\ndata: {"response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n']
      : kind === 'chat-completions'
        ? ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n']
        : ['event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\n', 'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n', 'event: message_stop\ndata: {}\n\n'];
    const defaultRequest = await collect(kind, frames);
    const explicitRequest = await collect(kind, frames, 'high');
    expect(defaultRequest.body).not.toHaveProperty(key);
    expect(explicitRequest.body[key]).toEqual(value);
    expect(profileFingerprint(profile(kind))).toBe(profileFingerprint({ ...profile(kind), effort: undefined }));
    expect(profileFingerprint(profile(kind, 'high'))).not.toBe(profileFingerprint(profile(kind)));
  });

  it('attributes Responses reported model and subset usage without adding cached or reasoning tokens', async () => {
    const { events } = await collect('responses', ['event: response.completed\ndata: {"response":{"id":"resp-1","model":"returned-model","status":"completed","output":[],"usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":40},"output_tokens_details":{"reasoning_tokens":8}}}}\n\n']);
    expect(events).toContainEqual({ type: 'metadata', reportedModel: 'returned-model', responseId: 'resp-1' });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 8 });
  });

  it('attributes Chat model and retains terminal usage after length failure', async () => {
    const frames = ['data: {"id":"chat-1","model":"returned-chat","choices":[{"delta":{},"finish_reason":"length"}]}\n\n', 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":1}}}\n\n', 'data: [DONE]\n\n'];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(...frames)));
    const seen: ProviderEvent[] = [];
    await expect((async () => { for await (const event of createProvider('chat-completions', { fetch }).streamTurn({ profile: profile('chat-completions'), credential: 'secret', messages: [], signal: new AbortController().signal })) seen.push(event); })()).rejects.toThrow('length');
    expect(seen).toContainEqual({ type: 'metadata', reportedModel: 'returned-chat', responseId: 'chat-1' });
    expect(seen).toContainEqual({ type: 'usage', inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, reasoningTokens: 1 });
    expect(seen.some(event => event.type === 'done' || event.type === 'tool_call')).toBe(false);
  });

  it('attributes Anthropic model and adds cache buckets to base input once', async () => {
    const { events } = await collect('anthropic', [
      'event: message_start\ndata: {"message":{"id":"msg-1","model":"returned-claude","usage":{"input_tokens":6,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
      'event: message_stop\ndata: {}\n\n'
    ]);
    expect(events).toContainEqual({ type: 'metadata', reportedModel: 'returned-claude', responseId: 'msg-1' });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 11, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 2 });
  });

  it('keeps unavailable breakdowns absent and emits failed Responses usage before rejecting', async () => {
    const frames = ['event: response.failed\ndata: {"response":{"id":"resp-failed","status":"failed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n'];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(...frames)));
    const seen: ProviderEvent[] = [];
    await expect((async () => { for await (const event of createProvider('responses', { fetch }).streamTurn({ profile: profile('responses'), credential: 'secret', messages: [], signal: new AbortController().signal })) seen.push(event); })()).rejects.toThrow('failed');
    expect(seen).toContainEqual({ type: 'usage', inputTokens: 5, outputTokens: 2 });
    expect(seen.some(event => event.type === 'done' || event.type === 'tool_call')).toBe(false);
  });

  it('retains authoritative usage on incomplete Responses and failed Anthropic stops', async () => {
    const cases = [
      { kind: 'responses' as const, frames: ['event: response.completed\ndata: {"response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":9,"output_tokens":4}}}\n\n'] },
      { kind: 'anthropic' as const, frames: ['event: message_start\ndata: {"message":{"usage":{"input_tokens":9}}}\n\n', 'event: message_delta\ndata: {"delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4}}\n\n', 'event: message_stop\ndata: {}\n\n'] }
    ];
    for (const { kind, frames } of cases) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(...frames)));
      const seen: ProviderEvent[] = [];
      await expect((async () => { for await (const event of createProvider(kind, { fetch }).streamTurn({ profile: profile(kind), credential: 'secret', messages: [], signal: new AbortController().signal })) seen.push(event); })()).rejects.toThrow();
      expect(seen).toContainEqual({ type: 'usage', inputTokens: 9, outputTokens: 4 });
      expect(seen.some(event => event.type === 'done' || event.type === 'tool_call')).toBe(false);
    }
  });

  it('does not turn malformed subset values into zero or measured usage', async () => {
    const { events } = await collect('responses', ['event: response.completed\ndata: {"response":{"status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":2,"input_tokens_details":{"cached_tokens":6}}}}\n\n']);
    expect(events.some(event => event.type === 'usage')).toBe(false);
  });

  it.each([
    ['refusal', 'data: {"choices":[{"delta":{"refusal":"No"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'],
    ['legacy function call', 'data: {"choices":[{"delta":{"function_call":{"name":"old"}}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n']
  ])('retains same-frame Chat usage on rejected %s', async (_label, frame) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(frame)));
    const seen: ProviderEvent[] = [];
    await expect((async () => { for await (const event of createProvider('chat-completions', { fetch }).streamTurn({ profile: profile('chat-completions'), credential: 'secret', messages: [], signal: new AbortController().signal })) seen.push(event); })()).rejects.toThrow('unsupported');
    expect(seen).toContainEqual({ type: 'usage', inputTokens: 5, outputTokens: 2 });
    expect(seen.some(event => event.type === 'done' || event.type === 'tool_call')).toBe(false);
  });

  it.each(['response.refusal', 'error'])('retains Responses usage in a %s frame', async type => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(`event: ${type}\ndata: ${JSON.stringify({ type, response: { id: 'resp-rejected', model: 'returned-model', usage: { input_tokens: 5, output_tokens: 2 } } })}\n\n`)));
    const seen: ProviderEvent[] = [];
    await expect((async () => { for await (const event of createProvider('responses', { fetch }).streamTurn({ profile: profile('responses'), credential: 'secret', messages: [], signal: new AbortController().signal })) seen.push(event); })()).rejects.toThrow('unsupported');
    expect(seen).toContainEqual({ type: 'metadata', reportedModel: 'returned-model', responseId: 'resp-rejected' });
    expect(seen).toContainEqual({ type: 'usage', inputTokens: 5, outputTokens: 2 });
    expect(seen.some(event => event.type === 'done' || event.type === 'tool_call')).toBe(false);
  });
});
