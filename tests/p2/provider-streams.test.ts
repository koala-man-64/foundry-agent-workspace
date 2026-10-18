import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderContinuation, ProviderEvent, ProviderMessage, ToolDefinition } from '../../packages/protocol/src/index';
import { recorded, run, type Body, type Input } from './provider-fetch';

// P2.4b: the Responses and Anthropic parsers. Each input streams through the shipping createProvider(kind, { fetch }) with
// the recording fetch of provider-fetch.ts. When a case names a follow-up and the stream completes, the stored continuation
// and a result for each of its calls become the next request, answered with HTTP 400, so the case also pins the exact body
// the next turn sends. The C# suite (ProviderStreamTests) replays each case, building the follow-up from its own
// continuation.
interface StreamCase extends Input { followUp?: { messages: ProviderMessage[]; errors?: boolean } }
const tools: ToolDefinition[] = [
  { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'fixture_tool', description: 'Fixture.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
const user = (content: string): ProviderMessage => ({ role: 'user', content });
const sse = (event: string | null, payload: unknown): string => `${event === null ? '' : `event: ${event}\n`}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

// ---- Responses ----------------------------------------------------------------------------------------------------
const r = (type: string, payload: Record<string, unknown> = {}): string => sse(type, { type, ...payload });
const delta = (text: unknown): string => r('response.output_text.delta', { delta: text });
const item = (value: unknown): string => r('response.output_item.done', { item: value });
const completed = (response: Record<string, unknown>): string => r('response.completed', { response: { status: 'completed', ...response } });
const message = (text: string, id = 'm1'): Record<string, unknown> => ({ type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const fn = (call: string, name: string, args: string, id?: string): Record<string, unknown> => ({ type: 'function_call', ...(id ? { id } : {}), call_id: call, name, arguments: args });
const usage = { input_tokens: 9, output_tokens: 4, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } };
const responses = (body: Body, extra: Partial<StreamCase> = {}): StreamCase => ({ kind: 'responses', tools, response: { body }, ...extra });

function responsesCases(): StreamCase[] {
  const reasoning = { type: 'reasoning', id: 'r1', encrypted_content: 'cipher+/=', summary: [] };
  const read = fn('call-1', 'read_file', '{"path":"README.md"}', 'fc-1');
  return [
    responses([delta('Hel'), delta('lo'), item(message('Hello')), completed({ id: 'resp-1', model: 'returned-model', output: [message('Hello')], usage })]),
    responses([r('response.created', { response: { id: 'resp-0' } }), r('response.in_progress'), r('response.content_part.added'), r('response.output_text.done', { text: 'x' }), delta('x'), item(message('x')), completed({ output: [message('x')] })]),
    responses([completed({ output: [] })]),
    responses([completed({})]),
    responses([delta('x'), completed({})]),
    responses([item(message('x')), completed({})]),
    responses([item(reasoning), item(read), completed({ output: [reasoning, read], usage })], { followUp: { messages: [] } }),
    responses([item(reasoning), item(read), completed({ output: [reasoning, read] })], { followUp: { messages: [user('and then')], errors: true } }),
    responses([item(read), item(fn('call-2', 'fixture_tool', '{}', 'fc-2')), completed({ output: [read, fn('call-2', 'fixture_tool', '{}', 'fc-2')] })], { followUp: { messages: [] } }),
    responses([item(fn('call-2', 'fixture_tool', '{}')), completed({ output: [fn('call-2', 'fixture_tool', '{}')] })]),
    responses([item(read), completed({ output: [{ ...read, arguments: '{"path":"OTHER.md"}' }] })]),
    responses([item(read), completed({ output: [{ ...read, call_id: 'call-9' }] })]),
    responses([item(read), completed({ output: [{ ...read, name: 'fixture_tool' }] })]),
    responses([item(read), completed({ output: [{ ...read, id: 'fc-9' }] })]),
    responses([item(fn('call-1', 'read_file', '{}')), completed({ output: [fn('call-1', 'read_file', '{}', 'fc-1')] })]),
    responses([item(message('a')), completed({ output: [{ ...message('a'), content: [{ annotations: [], text: 'a', type: 'output_text' }] }] })]),
    responses([item(message('a')), completed({ output: [message('b'), message('a')] })]),
    responses([item({ type: 'message', id: 'm1' }), completed({ output: [{ type: 'message', id: 'm1', status: 'completed' }] })]),
    responses([item({ type: 'message', id: 7 }), completed({ output: [{ type: 'message', id: 7 }] })]),
    responses([item(reasoning), completed({ output: [{ ...reasoning, type: 'other' }] })]),
    // JavaScript's === never matches two distinct objects, so an object type matches nothing.
    responses([item({ type: { kind: 'x' }, id: 'o1' }), completed({ output: [{ type: { kind: 'x' }, id: 'o1' }] })]),
    responses([item(fn('call-1', 'read_file', '{}')), item(fn('call-1', 'fixture_tool', '{}')), completed({ output: [fn('call-1', 'read_file', '{}'), fn('call-1', 'fixture_tool', '{}')] })]),
    responses([item(fn('call-1', 'not_advertised', '{}')), completed({ output: [fn('call-1', 'not_advertised', '{}')] })]),
    responses([item(fn('call-1', 'read_file', '{}')), completed({ output: [fn('call-1', 'read_file', '{}')] })], { tools: undefined }),
    responses([completed({ output: [{ type: 'function_call', call_id: 3, name: 'read_file', arguments: '{}' }] })]),
    responses([completed({ output: [{ type: 'function_call', call_id: 'c', name: 'read_file', arguments: {} }] })]),
    ...['', '{"path":', '[1]', 'null', '{"a":1e400,"__proto__":1}'].map(args => responses([completed({ output: [fn('c', 'read_file', args)] })])),
    responses([item({ type: 'refusal', refusal: 'No' }), completed({ output: [] })]),
    responses([item({ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }), completed({ output: [] })]),
    responses([item({ type: 'computer_call', id: 'cc' }), completed({ output: [] })]),
    responses([item({ type: 'message', nested: { deep: [{ x: { type: 'computer_call' } }] } }), completed({ output: [] })]),
    responses([completed({ output: [message('a'), { type: 'refusal' }], usage })]),
    responses([completed({ output: [], metadata: { type: 'refusal' }, usage })]),
    responses([completed({ status: 'incomplete', output: [], usage })]),
    responses([completed({ incomplete_details: { reason: 'max_output_tokens' }, output: [], usage })]),
    responses([completed({ incomplete_details: null, output: [] })]),
    responses([completed({ incomplete_details: '', output: [] })]),
    responses([r('response.completed', { response: 'not a record' })]),
    responses([completed({ output: 'nope' })]),
    responses([completed({ output: null })]),
    responses([completed({ output: [message('a'), 3] })]),
    responses([r('response.failed', { response: { id: 'resp-failed', model: 'm', status: 'failed', usage } })]),
    responses([r('response.incomplete', { response: { status: 'incomplete', usage } })]),
    responses([r('response.failed', { response: 'x' })]),
    responses([r('error', { message: 'boom', usage: { input_tokens: 2, output_tokens: 1 } })]),
    responses([r('error', { response: { id: 'resp-err', usage } })]),
    responses([r('response.refusal.delta', { delta: 'No' })]),
    responses([r('response.output_text.annotation.added', { annotation: { type: 'refusal' } }), completed({ output: [] })]),
    responses([sse(null, { type: 'response.output_text.delta', delta: 'typed' }), sse(null, { type: 'response.completed', response: { status: 'completed', output: [] } })]),
    responses([sse('response.output_text.delta', { delta: 'named only' }), sse('response.completed', { response: { status: 'completed', output: [] } })]),
    responses([sse('response.output_text.delta', { type: 'response.completed', delta: 'x' })]),
    responses([delta(3)]),
    responses([delta('')]),
    responses([item('not a record')]),
    responses([delta('x')]),
    responses([]),
    responses([completed({ output: [] }), delta('late')]),
    responses([completed({ output: [] }), completed({ output: [] })]),
    responses([completed({ output: [] }), r('response.created')]),
    responses([delta('a'), delta('b'), completed({ output: [] })], { abortAfterEvents: 1 }),
    responses([delta('a')], { abortAfterEvents: 1, response: { body: [delta('a')], end: 'hang' } }),
    responses([delta('a')], { response: { body: [delta('a')], end: 'terminated' } }),
    responses([completed({ id: '', model: 'm'.repeat(201), output: [], usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: { cached_tokens: 6 } } })]),
    responses([completed({ output: [], usage: { prompt_tokens: 5, completion_tokens: 1 } })]),
    responses([completed({ output: [], input_tokens: 5, output_tokens: 1 })]),
    // A resumed turn: the stored continuation with results, then the next completion and its own continuation.
    responses([delta('done'), item(message('done', 'm2')), completed({ output: [message('done', 'm2')] })], {
      messages: [], continuation: { apiKind: 'responses', data: { input: [{ role: 'user', content: 'first' }, reasoning, read], calls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } }] } },
      toolResults: [{ id: 'call-1', name: 'read_file', content: '{"ok":true}', isError: false }],
    }),
  ];
}

// ---- Anthropic ----------------------------------------------------------------------------------------------------
const a = (type: string, payload: Record<string, unknown> = {}): string => sse(type, { type, ...payload });
const start = (usage: Record<string, unknown> = { input_tokens: 6 }, extra: Record<string, unknown> = {}): string => a('message_start', { message: { id: 'msg-1', model: 'returned-claude', usage, ...extra } });
const block = (index: number, value: unknown): string => a('content_block_start', { index, content_block: value });
const blockDelta = (index: unknown, value: unknown): string => a('content_block_delta', { index, delta: value });
const text = (index: number, value: string): string => blockDelta(index, { type: 'text_delta', text: value });
const stop = (index: unknown): string => a('content_block_stop', { index });
const stopReason = (reason: unknown, usage: Record<string, unknown> = { output_tokens: 3 }): string => a('message_delta', { delta: { stop_reason: reason }, usage });
const end = a('message_stop');
const anthropic = (body: Body, extra: Partial<StreamCase> = {}): StreamCase => ({ kind: 'anthropic', tools, response: { body }, ...extra });

function anthropicCases(): StreamCase[] {
  const tool = (index: number, id: unknown, name: unknown, args = '{"path":"README.md"}'): string[] => [block(index, { type: 'tool_use', id, name, input: {} }), blockDelta(index, { type: 'input_json_delta', partial_json: args.slice(0, 5) }), blockDelta(index, { type: 'input_json_delta', partial_json: args.slice(5) }), stop(index)];
  const thinking = [block(0, { type: 'thinking', thinking: '' }), blockDelta(0, { type: 'thinking_delta', thinking: 'hid' }), blockDelta(0, { type: 'thinking_delta', thinking: 'den' }), blockDelta(0, { type: 'signature_delta', signature: 'sig-1' }), blockDelta(0, { type: 'signature_delta', signature: 'sig-2' }), stop(0)];
  return [
    anthropic([start(), block(0, { type: 'text', text: '' }), text(0, 'Hel'), text(0, 'lo'), stop(0), stopReason('end_turn'), end]),
    anthropic([start({ input_tokens: 6, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }), block(0, { type: 'text', text: 'pre ' }), text(0, 'x'), stop(0), stopReason('end_turn', { output_tokens: 4 }), end]),
    anthropic([start({ input_tokens: 6, cache_read_input_tokens: 3 }), block(0, { type: 'text', text: '' }), stop(0), stopReason('end_turn', { output_tokens: 4, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 }), end]),
    anthropic([start({ input_tokens: 6, cache_read_input_tokens: 3 }), stopReason('end_turn', { output_tokens: 4, cache_read_input_tokens: null }), end]),
    anthropic([start({ input_tokens: 6, cache_creation_input_tokens: -1 }), stopReason('end_turn', { output_tokens: 4 }), end]),
    anthropic([start({ input_tokens: 6 }), stopReason('end_turn', { output_tokens: 4, cache_creation_input_tokens: 1.5 }), end]),
    anthropic([start({ input_tokens: 2 ** 53 - 2 }), stopReason('end_turn', { output_tokens: 1, cache_read_input_tokens: 2 }), end]),
    anthropic([start({ input_tokens: '6' }), stopReason('end_turn', { output_tokens: 4 }), end]),
    anthropic([start({}), stopReason('end_turn', { output_tokens: 4 }), end]),
    anthropic([stopReason('end_turn', { output_tokens: 4 }), start(), end]),
    anthropic([start(), stopReason('end_turn', {}), end]),
    anthropic([start(), stopReason('end_turn', { output_tokens: -1 }), end]),
    anthropic([a('message_start', { message: 'x' }), stopReason('end_turn'), end]),
    anthropic([start({ input_tokens: 6 }, { id: '', model: 'm'.repeat(201) }), stopReason('end_turn'), end]),
    anthropic([...thinking, block(1, { type: 'text', text: '' }), text(1, 'answer'), stop(1), stopReason('end_turn'), end]),
    anthropic([...thinking, ...tool(1, 'toolu_1', 'read_file'), stopReason('tool_use'), end], { followUp: { messages: [] } }),
    anthropic([...thinking, ...tool(1, 'toolu_1', 'read_file'), ...tool(2, 'toolu_2', 'fixture_tool', '{}'), stopReason('tool_use'), end], { followUp: { messages: [user('please continue')] } }),
    anthropic([...tool(1, 'toolu_1', 'read_file'), ...tool(2, 'toolu_2', 'fixture_tool', '{}'), stopReason('tool_use'), end], { followUp: { messages: [], errors: true } }),
    anthropic([...tool(1, 'toolu_1', 'read_file'), stopReason('tool_use'), end], { followUp: { messages: [user('one'), user('two')] } }),
    anthropic([block(2, { type: 'text', text: '' }), text(2, 'two'), block(0, { type: 'text', text: '' }), text(0, 'zero'), stop(0), stop(2), stopReason('end_turn'), end]),
    anthropic([block(0, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } }), stop(0), stopReason('tool_use'), end]),
    anthropic([block(0, { type: 'tool_use', id: 'toolu_1', name: 'read_file' }), stop(0), stopReason('tool_use'), end]),
    anthropic([block(0, { type: 'tool_use', id: 1, name: 'read_file', input: {} }), stop(0), stopReason('tool_use'), end]),
    anthropic([block(0, { type: 'tool_use', id: 'toolu_1', name: '', input: {} }), stop(0), stopReason('tool_use'), end]),
    anthropic([block(0, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }), blockDelta(0, { type: 'input_json_delta', partial_json: '{"a":' }), stop(0), stopReason('tool_use'), end]),
    anthropic([block(0, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }), blockDelta(0, { type: 'input_json_delta', partial_json: '{"b":1,"a":1e400,"__proto__":2}' }), stop(0), stopReason('tool_use'), end]),
    anthropic([block(0, { type: 'text', text: '', __json: '{"x":1}' }), stop(0), stopReason('end_turn'), end]),
    anthropic([block(0, { type: 'text', text: '' }), blockDelta(0, { type: 'input_json_delta', partial_json: '[1]' }), stop(0), stopReason('end_turn'), end]),
    anthropic([...tool(0, 'toolu_1', 'read_file'), ...tool(1, 'toolu_1', 'fixture_tool', '{}'), stopReason('tool_use'), end]),
    anthropic([...tool(0, 'toolu_1', 'not_advertised'), stopReason('tool_use'), end]),
    anthropic([...tool(0, 'toolu_1', 'read_file'), stopReason('tool_use'), end], { tools: undefined }),
    anthropic([...tool(0, 'toolu_1', 'read_file'), stopReason('end_turn'), end]),
    anthropic([block(0, { type: 'text', text: '' }), stop(0), stopReason('tool_use'), end]),
    anthropic([block(0, { type: 'text' }), block(0, { type: 'text' })]),
    anthropic([block(0.5, { type: 'text' })]),
    anthropic([block('0', { type: 'text' })]),
    anthropic([block(0, 'not a record')]),
    anthropic([text(0, 'orphan')]),
    anthropic([block(0, { type: 'text', text: '' }), blockDelta('0', { type: 'text_delta', text: 'x' })]),
    anthropic([block(0, { type: 'text', text: '' }), blockDelta(0, 'not a record')]),
    anthropic([block(0, { type: 'text', text: '' }), blockDelta(0, { type: 'text_delta', text: 3 })]),
    anthropic([block(0, { type: 'text', text: '' }), blockDelta(0, { type: 'citations_delta', citation: {} })]),
    anthropic([block(0, { type: 'text', text: 'x' }), text(0, ''), text(0, 'y'), stop(0), stopReason('end_turn'), end]),
    anthropic([block(0, { type: 'text', text: 7 }), text(0, 'y'), stop(0), stopReason('end_turn'), end]),
    anthropic([block(0, { type: 'text', text: '' }), stop(0), text(0, 'after stop'), stopReason('end_turn'), end]),
    anthropic([block(0, { type: 'text', text: '' }), stop(0), stop(0)]),
    anthropic([stop(0)]),
    anthropic([block(0, { type: 'text', text: '' }), stop(0.5)]),
    anthropic([block(0, { type: 'text', text: '' }), stopReason('end_turn'), end]),
    anthropic([stopReason('max_tokens'), end]),
    anthropic([start(), stopReason('max_tokens', { output_tokens: 4 }), end]),
    anthropic([a('message_delta', { delta: {} }), end]),
    anthropic([a('message_delta', { delta: 'x' }), stopReason('end_turn'), end]),
    anthropic([stopReason(null), end]),
    anthropic([stopReason('stop_sequence'), stopReason('end_turn'), end]),
    anthropic([stopReason('end_turn'), stopReason('max_tokens'), end]),
    anthropic([stopReason('end_turn'), stopReason('tool_use'), end]),
    anthropic([stopReason('end_turn')]),
    anthropic([end]),
    anthropic([start(), a('ping'), stopReason('end_turn'), end, a('ping'), a('ping')]),
    anthropic([stopReason('end_turn'), end, a('message_delta', { delta: { stop_reason: 'end_turn' } })]),
    anthropic([stopReason('end_turn'), end, a('unknown_event')]),
    anthropic([start(), a('error', { error: { type: 'overloaded_error' } })]),
    anthropic([start(), stopReason('end_turn'), a('error', { error: {} })]),
    anthropic([a('unknown_event', { x: { type: 'refusal' } }), stopReason('end_turn'), end]),
    anthropic([sse('message_start', { type: 'message_delta', message: {} })]),
    anthropic([sse(null, { type: 'message_stop' }), sse(null, { type: 'ping' })]),
    anthropic([]),
    // A raw -0 index names block 0: a JavaScript Map treats -0 and 0 as one key.
    anthropic([block(0, { type: 'text', text: '' }), 'event: content_block_delta\ndata: {"type":"content_block_delta","index":-0,"delta":{"type":"text_delta","text":"zero"}}\n\n', 'event: content_block_stop\ndata: {"type":"content_block_stop","index":-0}\n\n', stopReason('end_turn'), end]),
    anthropic(['event: content_block_start\ndata: {"type":"content_block_start","index":-0,"content_block":{"type":"text","text":""}}\n\n', block(0, { type: 'text', text: '' })]),
    { kind: 'chat-completions', tools, response: { body: ['data: {"choices":[{"delta":{"tool_calls":[{"index":-0,"id":"c1","function":{"name":"read_file","arguments":"{"}}]}}]}\n\n', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}\n\n', 'data: [DONE]\n\n'] } },
    anthropic([start(), block(0, { type: 'text', text: '' }), text(0, 'a'), text(0, 'b')], { abortAfterEvents: 1 }),
    anthropic([start(), block(0, { type: 'text', text: '' }), text(0, 'a')], { abortAfterEvents: 1, response: { body: [start(), block(0, { type: 'text', text: '' }), text(0, 'a')], end: 'hang' } }),
    anthropic([start()], { response: { body: [start()], end: 'terminated' } }),
    // A resumed turn from a stored continuation, with its system text.
    anthropic([start(), block(0, { type: 'text', text: '' }), text(0, 'done'), stop(0), stopReason('end_turn'), end], {
      messages: [], continuation: { apiKind: 'anthropic', data: { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }] }], system: 'Kept system.', calls: [{ id: 'toolu_1', name: 'read_file', arguments: {} }] } },
      toolResults: [{ id: 'toolu_1', name: 'read_file', content: 'denied', isError: true }],
    }),
  ];
}

const sources = ['packages/providers/src/index.ts', 'packages/protocol/src/limits.ts'];

afterEach(() => { vi.restoreAllMocks(); });

it('pins the Responses and Anthropic parsers and the next request each continuation makes', async () => {
  const cases = [];
  for (const [index, input] of [...responsesCases(), ...anthropicCases()].entries()) {
    const { followUp, ...first } = input;
    const expected: Record<string, unknown> = { ...await run(first) };
    const done = (expected.events as ProviderEvent[]).find((event): event is Extract<ProviderEvent, { type: 'done' }> => event.type === 'done');
    if (followUp && done?.continuation) {
      const calls = (done.continuation.data as { calls: { id: string; name: string }[] }).calls;
      const next = await run({ kind: input.kind, tools: input.tools, messages: followUp.messages, continuation: done.continuation as ProviderContinuation, response: { status: 400, body: [] },
        toolResults: calls.map((call, position) => ({ id: call.id, name: call.name, content: followUp.errors && position % 2 === 1 ? 'User rejected this action.' : JSON.stringify({ ok: true, position }), isError: Boolean(followUp.errors && position % 2 === 1) })) });
      expected.followUp = next.requests;
    }
    cases.push({ name: `provider-streams:${index}`, input: { ...recorded(first), ...(followUp ? { followUp } : {}) }, expected });
  }
  const corpus = { oracle: { sources: sources.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) }, cases };
  const text = JSON.stringify(corpus, null, 2) + '\n';
  if (process.env.P2_WRITE_PROVIDER_STREAMS === '1') writeFileSync('tests/p2/provider-stream-vectors.json', text);
  expect(readFileSync('tests/p2/provider-stream-vectors.json', 'utf8')).toBe(text);
}, 120_000);
