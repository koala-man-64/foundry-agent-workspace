import { describe, expect, it, vi } from 'vitest';
import type { ModelProfile, ProviderRequest } from '../../protocol/src/index.js';
import { createProvider, profileFingerprint } from '../src/index.js';

const profile = (apiKind: ModelProfile['apiKind'], endpoint = 'https://sample.openai.azure.com'): ModelProfile => ({
  id: '0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53', name: 'Test', apiKind, endpoint, deployment: 'test-model',
  contextLimit: 4096, outputLimit: 256
});

const request = (apiKind: ModelProfile['apiKind'], signal = new AbortController().signal): ProviderRequest => ({
  profile: profile(apiKind), credential: 'secret-value', signal, messages: [{ role: 'user', content: 'hello world' }]
});

function sse(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    }
  });
}

async function eventsOf(provider: ReturnType<typeof createProvider>, input: ProviderRequest) {
  const events = [];
  for await (const event of provider.streamTurn(input)) events.push(event);
  return events;
}

describe('fake provider', () => {
  it('streams deterministic text, usage, and complete-only done', async () => {
    const events = await eventsOf(createProvider('fake'), request('fake'));
    expect(events.filter((event) => event.type === 'text').map((event) => event.text).join('')).toBe('Fake response: hello world');
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('honors cancellation between chunks', async () => {
    const controller = new AbortController();
    const iterator = createProvider('fake').streamTurn(request('fake', controller.signal))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text' } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('allows a caller timer to cancel a long response before it drains', async () => {
    const controller = new AbortController();
    const input = request('fake', controller.signal);
    input.messages[0]!.content = 'x'.repeat(64_000);
    setTimeout(() => controller.abort(), 0);
    await expect(eventsOf(createProvider('fake'), input)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('Azure fetch providers', () => {
  it('uses Responses API path, api-key header, usage, and explicit completion event', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n'
    )));
    const events = await eventsOf(createProvider('responses', { fetch }), request('responses'));
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://sample.openai.azure.com/openai/v1/responses');
    expect(new Headers(init?.headers).get('api-key')).toBe('secret-value');
    expect(init?.redirect).toBe('error');
    expect(events).toEqual([{ type: 'text', text: 'Hi' }, { type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'done' }]);
  });

  it('uses Chat Completions API path and waits for [DONE]', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n'
    )));
    const events = await eventsOf(createProvider('chat-completions', { fetch }), request('chat-completions'));
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://sample.openai.azure.com/openai/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'test-model', stream: true, stream_options: { include_usage: true }, max_completion_tokens: 256 });
    expect(events).toEqual([{ type: 'text', text: 'Hi' }, { type: 'usage', inputTokens: 3, outputTokens: 1 }, { type: 'done' }]);
  });

  it('uses Anthropic Messages format and x-api-key header', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_stop\ndata: {}\n\n'
    )));
    const events = await eventsOf(createProvider('anthropic', { fetch }), request('anthropic'));
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://sample.openai.azure.com/anthropic/v1/messages');
    expect(new Headers(init?.headers).get('api-key')).toBe('secret-value');
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
    expect(events).toEqual([{ type: 'text', text: 'Hi' }, { type: 'done' }]);
  });

  it('does not retry an incomplete stream', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse('data: {"choices":[]}\n\n')));
    await expect(eventsOf(createProvider('chat-completions', { fetch }), request('chat-completions'))).rejects.toThrow('before a completion');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces provider SSE errors without retrying', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: error\ndata: {"type":"error","error":{"message":"denied"}}\n\n'
    )));
    await expect(eventsOf(createProvider('anthropic', { fetch }), request('anthropic'))).rejects.toThrow('reported a stream error');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['responses', 'event: response.output_item.added\ndata: {"item":{"type":"function_call"}}\n\n'],
    ['chat-completions', 'data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\n'],
    ['anthropic', 'event: content_block_start\ndata: {"content_block":{"type":"tool_use"}}\n\n']
  ] as const)('rejects unsupported %s tool content', async (apiKind, frame) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(frame)));
    await expect(eventsOf(createProvider(apiKind, { fetch }), request(apiKind))).rejects.toThrow('unsupported');
  });

  it('cancels a stalled reader immediately when the caller aborts', async () => {
    const encoder = new TextEncoder();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')); },
      cancel: cancelled
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
    const controller = new AbortController();
    const iterator = createProvider('chat-completions', { fetch }).streamTurn(request('chat-completions', controller.signal))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text', text: 'Hi' } });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://sample.openai.azure.com',
    'https://user:pass@sample.openai.azure.com',
    'https://sample.openai.azure.com?key=secret',
    'https://sample.openai.azure.com#fragment',
    'https://sample.openai.azure.com:444',
    'https://sample.openai.azure.com/openai',
    'https://sample.openai.azure.com.evil.example'
  ])('rejects malicious endpoint %s before fetch', async (endpoint) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const input = request('responses');
    input.profile.endpoint = endpoint;
    await expect(eventsOf(createProvider('responses', { fetch }), input)).rejects.toThrow('Endpoint must');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts before it sends a credential', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(eventsOf(createProvider('responses', { fetch }), request('responses', controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('configuration fingerprints and probes', () => {
  it('keeps fake probing offline even with a non-Azure endpoint value', async () => {
    const offline = profile('fake', 'offline://fake');
    await expect(createProvider('fake').probe(offline)).resolves.toMatchObject({ ok: true, capabilities: { tools: false, continuation: false, usage: false } });
  });

  it('fingerprints effective profile configuration and probes with complete plus cancelled bounded streams', async () => {
    const initial = profile('responses');
    const changedMetadata = { ...initial, credentialRef: 'another-store', verifiedAt: '2030-01-01T00:00:00Z' };
    expect(profileFingerprint(changedMetadata)).toBe(profileFingerprint(initial));
    expect(profileFingerprint({ ...initial, deployment: 'other' })).not.toBe(profileFingerprint(initial));
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(sse(
        'event: response.output_text.delta\ndata: {"delta":"OK"}\n\n',
        'event: response.completed\ndata: {"response":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\n'
      )))
      .mockResolvedValueOnce(new Response(sse('event: response.output_text.delta\ndata: {"delta":"OK"}\n\n')));
    await expect(createProvider('responses', { fetch }).probe(initial, 'secret-value')).resolves.toMatchObject({
      ok: true,
      capabilities: { streaming: true, tools: false, continuation: false, cancellation: true, usage: true }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ max_output_tokens: 16 });
  });
});
