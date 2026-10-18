import { describe, expect, it, vi } from 'vitest';
import type { ModelProfile, ProviderEvent, ProviderRequest, ToolDefinition } from '../../protocol/src/index.js';
import { TOOL_DEFINITIONS } from '../../runtime/src/tool-definitions.js';
import { createProvider } from '../src/index.js';

const tools: ToolDefinition[] = [
  { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
  { name: 'replace_text', description: 'replace', inputSchema: { type: 'object' } },
  { name: 'run_command', description: 'run', inputSchema: { type: 'object' } },
  { name: 'fixture_tool', description: 'fixture', inputSchema: { type: 'object' } }
];
const profile = (apiKind: ModelProfile['apiKind']): ModelProfile => ({ id: '0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53', name: 'Test', apiKind, endpoint: apiKind === 'fake' ? 'offline://fake' : 'https://sample.openai.azure.com', deployment: 'test-model', contextLimit: 4096, outputLimit: 256 });
const request = (apiKind: ModelProfile['apiKind'], signal = new AbortController().signal): ProviderRequest => ({ profile: profile(apiKind), credential: 'secret-value', signal, messages: [{ role: 'user', content: 'hello' }] });
const sse = (...frames: string[]): ReadableStream<Uint8Array> => { const encoder = new TextEncoder(); return new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } }); };
async function events(provider: ReturnType<typeof createProvider>, input: ProviderRequest): Promise<ProviderEvent[]> { const output: ProviderEvent[] = []; for await (const event of provider.streamTurn(input)) output.push(event); return output; }

describe('offline fake tools', () => {
  it('remains cancellable while streaming ordinary offline chat', async () => {
    const controller = new AbortController(); const input = request('fake', controller.signal); input.messages[0]!.content = 'x'.repeat(64_000); setTimeout(() => controller.abort(), 0);
    await expect(events(createProvider('fake'), input)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('runs the deterministic read, replace, and command proposal sequence', async () => {
    const first = await events(createProvider('fake'), { ...request('fake'), messages: [{ role: 'user', content: '/demo' }], tools });
    const read = first.find((event): event is Extract<ProviderEvent, { type: 'tool_call' }> => event.type === 'tool_call')!.call;
    expect(read).toMatchObject({ name: 'read_file', arguments: { path: 'README.md' } });
    const continuation = (first.at(-1) as Extract<ProviderEvent, { type: 'done' }>).continuation!;
    const second = await events(createProvider('fake'), { ...request('fake'), messages: [], tools, continuation, toolResults: [{ id: read.id, name: read.name, content: JSON.stringify({ path: 'README.md', content: 'base', hash: 'h1' }), isError: false }] });
    const replace = second.find((event): event is Extract<ProviderEvent, { type: 'tool_call' }> => event.type === 'tool_call')!.call;
    expect(replace).toMatchObject({ name: 'replace_text', arguments: { expectedHash: 'h1', newText: 'base\nFoundry offline demo completed.\n' } });
    const third = await events(createProvider('fake'), { ...request('fake'), messages: [], tools, continuation: (second.at(-1) as Extract<ProviderEvent, { type: 'done' }>).continuation!, toolResults: [{ id: replace.id, name: replace.name, content: '{}', isError: false }] });
    const command = third.find((event): event is Extract<ProviderEvent, { type: 'tool_call' }> => event.type === 'tool_call')!.call;
    expect(command).toMatchObject({ name: 'run_command', arguments: { cwd: '', environment: {}, timeoutMs: 10000 } });
  });

  it('requires complete matching results and reports rejected tool work truthfully', async () => {
    const first = await events(createProvider('fake'), { ...request('fake'), messages: [{ role: 'user', content: '/demo' }], tools });
    const continuation = (first.at(-1) as Extract<ProviderEvent, { type: 'done' }>).continuation!;
    await expect(events(createProvider('fake'), { ...request('fake'), messages: [], tools, continuation, toolResults: [] })).rejects.toThrow('matching results');
    const stopped = await events(createProvider('fake'), { ...request('fake'), messages: [], tools, continuation, toolResults: [{ id: 'fake-read-1', name: 'read_file', content: '{}', isError: true }] });
    expect(stopped.filter(event => event.type === 'text').map(event => (event as Extract<ProviderEvent, { type: 'text' }>).text).join('')).toContain('stopped');
  });
});

describe('native tool streams', () => {
  it('preserves Responses output items and emits a completed advertised call only after completion', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: response.output_item.done\ndata: {"item":{"type":"reasoning","id":"r1","encrypted_content":"cipher"}}\n\n',
      'event: response.output_item.done\ndata: {"item":{"type":"function_call","call_id":"call1","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}\n\n',
      'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"reasoning","id":"r1","encrypted_content":"cipher"},{"type":"function_call","call_id":"call1","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}],"usage":{"input_tokens":2,"output_tokens":1}}}\n\n'
    )));
    const output = await events(createProvider('responses', { fetch }), { ...request('responses'), tools });
    expect(output).toEqual(expect.arrayContaining([{ type: 'tool_call', call: { id: 'call1', name: 'read_file', arguments: { path: 'README.md' } } }]));
    const done = output.at(-1) as Extract<ProviderEvent, { type: 'done' }>;
    expect(done.continuation?.data).toMatchObject({ input: expect.arrayContaining([expect.objectContaining({ encrypted_content: 'cipher' })]) });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });
  });

  it('assembles Chat tool JSON chunks and appends a matching tool result on continuation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(sse('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\""}}]}}]}\n\n', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n', 'data: [DONE]\n\n')))
      .mockResolvedValueOnce(new Response(sse('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n')));
    const provider = createProvider('chat-completions', { fetch }); const first = await events(provider, { ...request('chat-completions'), tools }); const call = first.find((event): event is Extract<ProviderEvent, { type: 'tool_call' }> => event.type === 'tool_call')!.call;
    expect(call.arguments).toEqual({ path: 'README.md' }); const continuation = (first.at(-1) as Extract<ProviderEvent, { type: 'done' }>).continuation!;
    await events(provider, { ...request('chat-completions'), messages: [], tools, continuation, toolResults: [{ id: call.id, name: call.name, content: '{"path":"README.md","content":"x","hash":"h"}', isError: false }] });
    const secondBody = JSON.parse(String(fetch.mock.calls[1]![1]?.body)); expect(secondBody.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'c1' })]));
  });

  it('retains Anthropic thinking/signature blocks while emitting only text and finalized tool calls', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":2}}}\n\n',
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"hidden"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
      'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"a1","name":"read_file"}}\n\n',
      'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"index":0}\n\n',
      'event: content_block_stop\ndata: {"index":1}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n', 'event: message_stop\ndata: {}\n\n'
    )));
    const output = await events(createProvider('anthropic', { fetch }), { ...request('anthropic'), tools });
    expect(output.filter(event => event.type === 'text')).toEqual([]); expect(output).toEqual(expect.arrayContaining([{ type: 'tool_call', call: { id: 'a1', name: 'read_file', arguments: { path: 'README.md' } } }]));
    expect((output.at(-1) as Extract<ProviderEvent, { type: 'done' }>).continuation?.data).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ thinking: 'hidden', signature: 'sig' })]) })]) });
  });

  it('combines Anthropic tool results and a new user message into one user block', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(sse(
        'event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"index":0,"content_block":{"type":"tool_use","id":"a1","name":"read_file"}}\n\n',
        'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"index":0}\n\n',
        'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {}\n\n'
      )))
      .mockResolvedValueOnce(new Response(sse(
        'event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":"done"}}\n\n',
        'event: content_block_stop\ndata: {"index":0}\n\n',
        'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {}\n\n'
      )));
    const provider = createProvider('anthropic', { fetch });
    const first = await events(provider, { ...request('anthropic'), tools });
    const call = first.find((event): event is Extract<ProviderEvent, { type: 'tool_call' }> => event.type === 'tool_call')!.call;
    const continuation = (first.at(-1) as Extract<ProviderEvent, { type: 'done' }>).continuation!;
    await events(provider, {
      ...request('anthropic'),
      messages: [{ role: 'user', content: 'please continue' }],
      tools,
      continuation,
      toolResults: [{ id: call.id, name: call.name, content: '{"path":"README.md"}', isError: false }]
    });
    const body = JSON.parse(String(fetch.mock.calls[1]![1]?.body));
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a1', content: '{"path":"README.md"}', is_error: false },
        { type: 'text', text: 'please continue' }
      ]
    });
  });

  // T-1: the merged user message carried only the first result, so Anthropic refused every later turn.
  it.each([2, 3])('answers each of %i pending Anthropic calls when a new user message joins their results', async count => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 400 }));
    const ids = Array.from({ length: count }, (_, index) => `toolu_${index + 1}`);
    const assistant = { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden', signature: 'sig' }, ...ids.map(id => ({ type: 'tool_use', id, name: 'read_file', input: {} }))] };
    const continuation = { apiKind: 'anthropic' as const, data: { messages: [{ role: 'user', content: 'first' }, assistant], system: 'Kept system.', calls: ids.map(id => ({ id, name: 'read_file', arguments: {} })) } };
    // The results arrive in the reverse of the calls' order, and the request keeps the results' order, as it does without a new message.
    const toolResults = ids.map((id, index) => ({ id, name: 'read_file', content: `result ${index + 1}`, isError: index === 1 })).reverse();
    await expect(events(createProvider('anthropic', { fetch }), { ...request('anthropic'), messages: [{ role: 'system', content: 'dropped' }, { role: 'user', content: 'please continue' }], tools, continuation, toolResults })).rejects.toThrow();
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body.system).toBe('Kept system.');
    expect(body.messages).toEqual([
      { role: 'user', content: 'first' },
      assistant,
      { role: 'user', content: [...toolResults.map(result => ({ type: 'tool_result', tool_use_id: result.id, content: result.content, is_error: result.isError })), { type: 'text', text: 'please continue' }] }
    ]);
  });

  it('rejects unadvertised, malformed, and incomplete tool calls before emitting them', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse('event: response.output_item.done\ndata: {"item":{"type":"function_call","call_id":"c","name":"not_advertised","arguments":"{}"}}\n\n', 'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"function_call","call_id":"c","name":"not_advertised","arguments":"{}"}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')));
    await expect(events(createProvider('responses', { fetch }), { ...request('responses'), tools })).rejects.toThrow('unadvertised');
  });

  it('matches streamed Responses items to the completion without comparing every pair', async () => {
    // 200 messages without ids, completed in reverse order. Comparing every streamed item with every completed one
    // serializes about 40,000 contents; the index serializes each item twice, once for its content and once for its key.
    const items = Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: `${String(i).padStart(6, '0')}${'x'.repeat(200)}` }] }));
    const body = (streamed: string[]) => new Response(sse(...streamed.map(item => `event: response.output_item.done\ndata: {"item":${item}}\n\n`), `event: response.completed\ndata: {"response":{"status":"completed","output":[${[...items].reverse().join(',')}]}}\n\n`));
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const output = await events(createProvider('responses', { fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(body(items)) }), request('responses'));
      expect(output.at(-1)).toMatchObject({ type: 'done' });
      expect(stringify.mock.calls.length).toBeLessThan(4 * items.length + 50);
    }
    finally {
      stringify.mockRestore();
    }
    const unmatched = [...items.slice(0, 100), JSON.stringify({ type: 'message', content: [] }), ...items.slice(100)];
    await expect(events(createProvider('responses', { fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(body(unmatched)) }), request('responses'))).rejects.toThrow('did not match an output item event');
  });

  it('rejects mixed refused Responses completion output before emitting a tool call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: response.output_item.done\ndata: {"item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"read_file","arguments":"{}"}}\n\n',
      'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"function_call","id":"item-1","call_id":"call-1","name":"read_file","arguments":"{}"},{"type":"refusal","id":"refusal-1"}]}}\n\n'
    )));
    const observed: ProviderEvent[] = [];
    await expect((async () => {
      for await (const event of createProvider('responses', { fetch }).streamTurn({ ...request('responses'), tools }))
        observed.push(event);
    })()).rejects.toThrow('unsupported');
    expect(observed.filter(event => event.type === 'tool_call')).toEqual([]);
  });

  it('rejects Anthropic tool calls with non-string IDs or names', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"tool_use","id":1,"name":"read_file"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: content_block_stop\ndata: {"index":0}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {}\n\n'
    )));
    await expect(events(createProvider('anthropic', { fetch }), { ...request('anthropic'), tools })).rejects.toThrow('Incomplete Anthropic tool call');
  });

  it('aborts before it sends a credential', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const controller = new AbortController(); controller.abort();
    await expect(events(createProvider('responses', { fetch }), request('responses', controller.signal))).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).not.toHaveBeenCalled();
  });

  it('serializes the runtime tool schemas as non-strict provider functions', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(
      'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
    )));
    await events(createProvider('responses', { fetch }), { ...request('responses'), tools: TOOL_DEFINITIONS });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body.tools).toEqual(TOOL_DEFINITIONS.map(tool => expect.objectContaining({ name: tool.name, parameters: tool.inputSchema, strict: false })));
  });

  it('probes text, cancellation, and fixture-tool continuation without live transport', async () => {
    let calls = 0;
    const observed: ProviderRequest[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      calls += 1;
      if (calls === 1)
        return new Response(sse('event: response.output_text.delta\ndata: {"delta":"OK"}\n\n', 'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"message","id":"m1","content":[{"type":"output_text","text":"OK"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'));
      if (calls === 2)
        return new Response(sse('event: response.output_text.delta\ndata: {"delta":"OK"}\n\n'));
      if (calls === 3)
        return new Response(sse('event: response.output_item.done\ndata: {"item":{"type":"function_call","call_id":"fixture-1","name":"fixture_tool","arguments":"{}"}}\n\n', 'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"function_call","call_id":"fixture-1","name":"fixture_tool","arguments":"{}"}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'));
      const body = JSON.parse(String(init?.body));
      const result = body.input.find((item: { type?: string }) => item.type === 'function_call_output');
      const token = JSON.parse(result.output).token;
      return new Response(sse(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: token })}\n\n`, `event: response.completed\ndata: ${JSON.stringify({ response: { status: 'completed', output: [{ type: 'message', id: 'm2', content: [{ type: 'output_text', text: token }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`));
    });
    const configured = { ...profile('responses'), effort: 'high' as const, outputLimit: 1024 };
    await expect(createProvider('responses', { fetch }).probe(configured, 'secret-value', (input, stream) => {
      observed.push(input);
      return stream();
    })).resolves.toMatchObject({ ok: true, capabilities: { tools: true, continuation: true, cancellation: true } });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(observed).toHaveLength(4);
    expect(observed.every(input => input.profile.outputLimit === 1024 && input.profile.effort === 'high')).toBe(true);
    expect(fetch.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).max_output_tokens === 1024)).toBe(true);
  });
});
