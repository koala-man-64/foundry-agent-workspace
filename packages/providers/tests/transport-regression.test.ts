import { describe, expect, it, vi } from 'vitest';
import type { ModelProfile, ProviderEvent, ProviderRequest } from '../../protocol/src/index.js';
import { createProvider } from '../src/index.js';

const profile = (apiKind: ModelProfile['apiKind'], endpoint = 'https://sample.openai.azure.com'): ModelProfile => ({
  id: '0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53', name: 'Transport', apiKind, endpoint, deployment: 'test-model', contextLimit: 4096, outputLimit: 256
});
const request = (apiKind: ModelProfile['apiKind'], signal = new AbortController().signal): ProviderRequest => ({ profile: profile(apiKind), credential: 'secret-value', signal, messages: [{ role: 'user', content: 'hello world' }] });
const sse = (...frames: string[]): ReadableStream<Uint8Array> => { const encoder = new TextEncoder(); return new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } }); };
async function collect(provider: ReturnType<typeof createProvider>, input: ProviderRequest): Promise<ProviderEvent[]> { const output: ProviderEvent[] = []; for await (const event of provider.streamTurn(input)) output.push(event); return output; }

describe('provider transport regressions', () => {
  it('keeps deterministic fake chat and timer cancellation', async () => {
    const complete = await collect(createProvider('fake'), request('fake'));
    expect(complete.filter(event => event.type === 'text').map(event => (event as Extract<ProviderEvent, { type: 'text' }>).text).join('')).toBe('Fake response: hello world');
    const controller = new AbortController(); const input = request('fake', controller.signal); input.messages[0]!.content = 'x'.repeat(64_000); setTimeout(() => controller.abort(), 0);
    await expect(collect(createProvider('fake'), input)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([
    ['responses', '/openai/v1/responses', 'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\nevent: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"message","id":"m1","content":[{"type":"output_text","text":"Hi"}]}],"usage":{"input_tokens":2,"output_tokens":1}}}\n\n'],
    ['chat-completions', '/openai/v1/chat/completions', 'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'],
    ['anthropic', '/anthropic/v1/messages', 'event: message_start\ndata: {"message":{"usage":{"input_tokens":2}}}\n\nevent: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\nevent: content_block_stop\ndata: {"index":0}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {}\n\n']
  ] as const)('uses the bounded %s endpoint and credential header', async (kind, path, frames) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(frames)));
    const output = await collect(createProvider(kind, { fetch }), request(kind));
    expect(String(fetch.mock.calls[0]![0])).toBe(`https://sample.openai.azure.com${path}`);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('api-key')).toBe('secret-value');
    expect(fetch.mock.calls[0]![1]?.redirect).toBe('error');
    expect(output.some(event => event.type === 'done')).toBe(true);
  });

  it('never retries an incomplete stream and fails closed', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse('data: {"choices":[]}\n\n')));
    await expect(collect(createProvider('chat-completions', { fetch }), request('chat-completions'))).rejects.toThrow('before [DONE]');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['http://sample.openai.azure.com', 'https://user:pass@sample.openai.azure.com', 'https://sample.openai.azure.com?key=x', 'https://sample.openai.azure.com#fragment', 'https://sample.openai.azure.com:444', 'https://sample.openai.azure.com/openai', 'https://sample.openai.azure.com.evil.example'])('rejects malicious endpoint %s before fetch', async endpoint => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const input = request('responses'); input.profile.endpoint = endpoint;
    await expect(collect(createProvider('responses', { fetch }), input)).rejects.toThrow('Endpoint must'); expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels a stalled custom stream when its caller aborts', async () => {
    const encoder = new TextEncoder(); const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')); }, cancel: cancelled });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)); const controller = new AbortController(); const iterator = createProvider('chat-completions', { fetch }).streamTurn(request('chat-completions', controller.signal))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text', text: 'Hi' } }); const pending = iterator.next(); controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(cancelled).toHaveBeenCalled();
  });

  it('rejects mismatched SSE event and payload discriminators', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: response.completed\ndata: {"type":"response.failed","response":{"status":"completed"}}\n\n'
    )));
    await expect(collect(createProvider('responses', { fetch }), request('responses'))).rejects.toThrow('did not match');
  });

  it.each([
    ['Chat Completions', 'chat-completions', 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n', 'terminal finish reason'],
    ['Anthropic', 'anthropic', 'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_stop\ndata: {"index":0}\n\nevent: message_stop\ndata: {}\n\n', 'stop reason']
  ] as const)('requires a valid %s terminal state', async (_name, kind, frames, error) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(frames)));
    await expect(collect(createProvider(kind, { fetch }), request(kind))).rejects.toThrow(error);
  });

  it('requires Anthropic blocks to stop and accounts only safe usage integers', async () => {
    const missingStop = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":2}}}\n\n',
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {}\n\n'
    )));
    await expect(collect(createProvider('anthropic', { fetch: missingStop }), request('anthropic'))).rejects.toThrow('all content blocks stopped');

    const usage = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":2}}}\n\n',
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_stop\ndata: {"index":0}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3,"cache_creation_input_tokens":4,"cache_read_input_tokens":5}}\n\n',
      'event: message_stop\ndata: {}\n\n'
    )));
    const output = await collect(createProvider('anthropic', { fetch: usage }), request('anthropic'));
    expect(output).toContainEqual({ type: 'usage', inputTokens: 11, outputTokens: 3, cacheReadTokens: 5, cacheCreationTokens: 4 });
  });

  it.each([
    ['Responses content after completion', 'responses', 'event: response.completed\ndata: {"response":{"status":"completed","output":[]}}\n\nevent: response.output_text.delta\ndata: {"delta":"late"}\n\n', 'after completion'],
    ['Responses duplicate completion', 'responses', 'event: response.completed\ndata: {"response":{"status":"completed","output":[]}}\n\nevent: response.completed\ndata: {"response":{"status":"completed","output":[]}}\n\n', 'after completion'],
    ['Chat content after terminal', 'chat-completions', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[{"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n', 'after its terminal'],
    ['Anthropic content after stop', 'anthropic', 'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n', 'after message_stop']
  ] as const)('rejects %s', async (_name, kind, frames, error) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(frames)));
    await expect(collect(createProvider(kind, { fetch }), request(kind))).rejects.toThrow(error);
  });

  it('rejects Responses completion output that disagrees with streamed call IDs or arguments', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: response.output_item.done\ndata: {"item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}\n\n',
      'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"function_call","id":"item-1","call_id":"call-1","name":"read_file","arguments":"{\\"path\\":\\"OTHER.md\\"}"}]}}\n\n'
    )));
    await expect(collect(createProvider('responses', { fetch }), request('responses'))).rejects.toThrow('did not match');
  });
});
