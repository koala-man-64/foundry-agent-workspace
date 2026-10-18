import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { createProvider, ProviderHttpError } from '../../packages/providers/src/index';
import { TOOL_DEFINITIONS } from '../../packages/runtime/src/tool-definitions';
import type { ApiKind, ModelProfile, ProviderContinuation, ProviderEvent, ProviderMessage, ProviderToolResult, ToolDefinition } from '../../packages/protocol/src/index';

// P2.4a: the Azure adapter's requests, transport and SSE framing, and the Chat Completions parser. Each input drives the
// shipping createProvider(kind, { fetch }).streamTurn with a recording fetch whose response stream returns exactly the
// listed chunks, one per read. The C# suite (ProviderTransportTests) replays every input through a recording
// HttpMessageHandler with the same chunks and must reproduce each request, event and error. Responses and Anthropic
// inputs end at an HTTP error, abort or transport failure: their parsers are slice b.
//
// The credential is generated per run and recorded as {credential}, so no committed file holds a token-shaped value.
const credential = ['fixture', randomBytes(12).toString('hex')].join('-');
type Chunk = string | { bytes: number[] } | { text: string; times: number };
type Body = Array<Chunk | { chunk: Chunk; count: number }>;
interface Input {
  kind: Exclude<ApiKind, 'fake'>;
  provider?: Exclude<ApiKind, 'fake'>;
  // effort is any string: the adapter checks it again whatever the stored profile holds.
  profile?: Omit<Partial<ModelProfile>, 'effort'> & { effort?: string };
  credential?: string | null;
  messages?: ProviderMessage[];
  tools?: ToolDefinition[];
  continuation?: ProviderContinuation;
  toolResults?: ProviderToolResult[];
  abortBefore?: boolean;
  abortAfterEvents?: number;
  now?: number;
  fetchRejects?: boolean;
  response?: { status?: number; headers?: [string, string][]; body?: Body | null; end?: 'close' | 'hang' | 'terminated' };
}
const user = (content: string): ProviderMessage => ({ role: 'user', content });
const system = (content: string): ProviderMessage => ({ role: 'system', content });
const assistant = (content: string): ProviderMessage => ({ role: 'assistant', content });
const fixtureTools: ToolDefinition[] = [
  { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'fixture_tool', description: 'Fixture “quoted”   text', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
const reject = { status: 400, body: [] as Body };
const kinds = ['responses', 'chat-completions', 'anthropic'] as const;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

// ---- Chat Completions frames ---------------------------------------------------------------------------------------
const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const content = (text: string, extra: Record<string, unknown> = {}): string => frame({ choices: [{ delta: { content: text } }], ...extra });
const finish = (reason: string | null, delta: Record<string, unknown> = {}): string => frame({ choices: [{ delta, finish_reason: reason }] });
const DONE = 'data: [DONE]\n\n';
const usageFrame = (usage: unknown): string => frame({ choices: [], usage });
const call = (index: number, part: Record<string, unknown>): string => frame({ choices: [{ delta: { tool_calls: [{ index, ...part }] } }] });
const chat = (body: Body, extra: Partial<Input> = {}): Input => ({ kind: 'chat-completions', response: { body }, ...extra });
const ok = [content('Hi'), finish('stop'), DONE];

function inputs(): Input[] {
  const list: Input[] = [];
  // Requests: each kind's body, tools, messages and effort.
  for (const kind of kinds) {
    const response = kind === 'chat-completions' ? { body: ok } : reject;
    list.push({ kind, response });
    list.push({ kind, messages: [system('First rule.'), system('Second rule.'), user('hello'), assistant('earlier'), user('again')], response });
    list.push({ kind, messages: [system('')], response });
    list.push({ kind, messages: [], response });
    list.push({ kind, messages: [user('lone \ud800 surrogate and 😀 and   and "quotes" \\ back')], response });
    list.push({ kind, tools: fixtureTools, response });
    list.push({ kind, tools: TOOL_DEFINITIONS, response });
    list.push({ kind, tools: [], response });
    list.push({ kind, profile: { outputLimit: 16, deployment: 'deployment with spaces / slash' }, response });
    list.push({ kind, profile: { outputLimit: 128000 }, response });
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'turbo']) list.push({ kind, profile: { effort }, response });
    // Validation before any request, in the adapter's order.
    list.push({ kind, credential: null, response });
    list.push({ kind, credential: '', response });
    list.push({ kind, credential: ' \t\n ', response });
    list.push({ kind, credential: '　﻿', response });
    list.push({ kind, credential: '\u0085key', response });
    list.push({ kind, abortBefore: true, response });
    list.push({ kind, abortBefore: true, credential: null, response });
    list.push({ kind, provider: kind === 'responses' ? 'anthropic' : 'responses', response });
    list.push({ kind, profile: { effort: 'max' }, credential: null, response });
    // Statuses without a body, other failures and a transport failure.
    list.push({ kind, response: { status: 204, body: null } });
    list.push({ kind, response: { status: 205, body: null } });
    list.push({ kind, fetchRejects: true });
    list.push({ kind, response: { status: 429, headers: [['retry-after', '7']], body: [] } });
  }
  // Continuations and tool results for each kind.
  const pending = [{ id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } }, { id: 'call-2', name: 'fixture_tool', arguments: {} }];
  const results: ProviderToolResult[] = [{ id: 'call-2', name: 'fixture_tool', content: '{"ok":true}', isError: false }, { id: 'call-1', name: 'read_file', content: 'denied', isError: true }];
  const states: Record<(typeof kinds)[number], Record<string, unknown>> = {
    responses: { input: [{ role: 'user', content: 'first' }, { type: 'reasoning', id: 'r1', encrypted_content: 'cipher', summary: [] }, { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' }], calls: pending },
    'chat-completions': { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }], calls: pending },
    anthropic: { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden', signature: 'sig' }, { type: 'tool_use', id: 'call-1', name: 'read_file', input: {} }] }], system: 'Kept system.', calls: pending },
  };
  for (const kind of kinds) {
    const response = kind === 'chat-completions' ? { body: ok } : reject;
    const data = states[kind];
    const resume = (overrides: Partial<Input>): Input => ({ kind, tools: fixtureTools, messages: [], continuation: { apiKind: kind, data }, toolResults: results, response, ...overrides });
    list.push(resume({}));
    list.push(resume({ messages: [user('please continue')] }));
    list.push(resume({ messages: [user('one'), user('two')] }));
    list.push(resume({ messages: [system('dropped for Anthropic'), user('please continue')] }));
    list.push(resume({ toolResults: [results[0]!] }));
    list.push(resume({ toolResults: undefined }));
    list.push(resume({ toolResults: [] }));
    list.push(resume({ toolResults: [...results, results[0]!] }));
    list.push(resume({ toolResults: [{ ...results[0]!, name: 'read_file' }, results[1]!] }));
    list.push(resume({ toolResults: [{ ...results[0]!, id: 'other' }, results[1]!] }));
    list.push(resume({ continuation: { apiKind: kind, data: { ...data, calls: [] } }, toolResults: undefined, messages: [user('no pending calls')] }));
    list.push(resume({ continuation: { apiKind: kind, data: { ...data, calls: [] } } }));
    list.push(resume({ continuation: { apiKind: kind, data: { ...data, calls: 'not an array' } }, toolResults: undefined }));
    list.push(resume({ continuation: { apiKind: kind, data: { ...data, calls: [{ id: 3, name: 'x' }] } } }));
    list.push(resume({ continuation: { apiKind: kind, data: { ...data, calls: [null] } } }));
    list.push(resume({ continuation: { apiKind: kind, data: { ...data, calls: [{ id: 'call-9', name: 'fixture_tool' }] } }, toolResults: [{ id: 'call-9', name: 'fixture_tool', content: 'x', isError: false }] }));
    for (const field of kind === 'responses' ? ['input'] : ['messages']) {
      list.push(resume({ continuation: { apiKind: kind, data: { ...data, [field]: 'not an array' } } }));
      list.push(resume({ continuation: { apiKind: kind, data: { calls: [] } }, toolResults: undefined }));
    }
    for (const value of [null, [], 'text', 3]) list.push(resume({ continuation: { apiKind: kind, data: value } }));
    list.push(resume({ continuation: { apiKind: kind === 'responses' ? 'chat-completions' : 'responses', data } }));
    list.push(resume({ continuation: { apiKind: 'fake', data } }));
    if (kind === 'anthropic') {
      list.push(resume({ continuation: { apiKind: kind, data: { ...data, system: 7 } } }));
      list.push(resume({ continuation: { apiKind: kind, data: { ...data, system: '' } } }));
      list.push(resume({ continuation: { apiKind: kind, data: { messages: [], calls: [] } }, toolResults: undefined, messages: [system('ignored'), user('fresh')] }));
    }
    list.push(resume({ continuation: { apiKind: kind, data: { ...data, future: { kept: [1, null] } } } }));
  }
  // Endpoints, through Responses.
  const endpoints = ['https://sample.openai.azure.com', 'https://sample.openai.azure.com/', 'HTTPS://SAMPLE.OpenAI.Azure.COM', 'https://sample.openai.azure.com:443', 'https://sample.openai.azure.com:0443/',
    'https://sample.openai.azure.com/?', 'https://sample.openai.azure.com/#', 'https://sample.openai.azure.com?#', 'https://sample.openai.azure.com/.', 'https://sample.openai.azure.com/%2e/', 'https://sample.openai.azure.com/a/..',
    'https://:@sample.openai.azure.com', 'https:\\\\sample.openai.azure.com', ' \t https://sample.openai.azure.com \n', 'https://sam\tple.openai.azure.com', 'https://sample%2Eopenai.azure.com', 'https://bücher.openai.azure.com',
    'https://x.services.ai.azure.com', 'https://x.cognitiveservices.azure.com', 'https://x.inference.ai.azure.com',
    'http://sample.openai.azure.com', 'https://user:pass@sample.openai.azure.com', 'https://user@sample.openai.azure.com', 'https://:pass@sample.openai.azure.com', 'https://sample.openai.azure.com?key=x', 'https://sample.openai.azure.com#fragment',
    'https://sample.openai.azure.com:444', 'https://sample.openai.azure.com/openai', 'https://sample.openai.azure.com//', 'https://sample.openai.azure.com.evil.example', 'https://sample.openai.azure.com.', 'https://evilopenai.azure.com',
    'https://.openai.azure.com', 'https://openai.azure.com', 'https://127.0.0.1', 'https://[::1]', 'https://0x7f.0.0.1', '', 'sample.openai.azure.com', 'https://', 'https://exa mple.openai.azure.com', 'ftp://sample.openai.azure.com', 'https://sample.openai.azure.com:99999'];
  for (const endpoint of endpoints) list.push({ kind: 'responses', profile: { endpoint }, response: reject });
  // HTTP failures and Retry-After on a fixed clock.
  for (const status of [400, 401, 403, 404, 408, 413, 422, 300, 304, 418, 500, 502, 503, 504]) list.push({ kind: 'responses', response: { status, headers: [['retry-after', '5']], body: status === 304 ? null : [] } });
  const retry = ['', '0', '5', '5.2', '3600', '3601', '999999', '-1', '0x10', '1e2', '.5', '5.', 'abc', 'Infinity', '1_000', '+3', ' ',
    // asctime ("Sun Oct 18 12:02:00 2026") is left out: V8 reads it in local time, so its value depends on the machine.
    'Sun, 06 Nov 1994 08:49:37 GMT', 'Sun, 18 Oct 2026 12:02:00 GMT', 'Sunday, 18-Oct-26 12:02:00 GMT', 'Sun, 18 Oct 2026 13:00:00 GMT', 'Mon, 18 Oct 2027 12:00:00 GMT', 'Sun, 18 Oct 2026 12:00:00 GMT', 'Sun, 18 Oct 2026 11:59:59 GMT'];
  for (const value of retry) list.push({ kind: 'responses', now: NOW, response: { status: 429, headers: [['retry-after', value]], body: [] } });
  list.push({ kind: 'responses', now: NOW, response: { status: 429, body: [] } });
  list.push({ kind: 'responses', now: NOW, response: { status: 429, headers: [['retry-after', '5'], ['retry-after', '6']], body: [] } });
  list.push({ kind: 'chat-completions', response: { status: 201, body: ok } });
  list.push({ kind: 'chat-completions', response: { status: 299, body: ok } });
  list.push(...framing(), ...chatParser());
  return list;
}

// ---- SSE framing, observed through the Chat Completions parser ------------------------------------------------------
function framing(): Input[] {
  const crlf = (text: string): string => text.replace(/\n/g, '\r\n');
  const cr = (text: string): string => text.replace(/\n/g, '\r');
  const encoder = new TextEncoder();
  const bytes = (text: string): number[] => [...encoder.encode(text)];
  const all = ok.join('');
  const comment = (size: number): string => `: ${'x'.repeat(size - 4)}\n\n`;
  const chunk64 = { text: comment(4096), times: 16 };
  const x64 = { text: 'x', times: 65536 };
  const tail = all;
  return [
    chat([all]),
    chat([crlf(all)]), chat([cr(all)]), chat([crlf(content('a')) + cr(content('b')) + finish('stop') + DONE]),
    chat([content('a').slice(0, -1) + '\r', '\n' + finish('stop') + DONE]),
    chat(['event: chunk\r', '\ndata: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) + '\n\n', finish('stop'), DONE]),
    // The split CRLF ends the event line's block, so the payload's own type meets no event name.
    chat(['event: chunk\r', '\ndata: ' + JSON.stringify({ type: 'other', choices: [{ delta: { content: 'x' } }] }) + '\n\n', finish('stop'), DONE]),
    chat(['event: chunk\r\ndata: ' + JSON.stringify({ type: 'other', choices: [{ delta: { content: 'x' } }] }) + '\n\n', finish('stop'), DONE]),
    chat([{ bytes: [0xef, 0xbb, 0xbf, ...bytes(all)] }]),
    chat([{ bytes: [0xef] }, { bytes: [0xbb, 0xbf, ...bytes(all)] }]),
    chat([content('a'), { bytes: [0xef, 0xbb, 0xbf, ...bytes(content('b'))] }, finish('stop'), DONE]),
    chat([{ bytes: [...bytes('data: {"choices":[{"delta":{"content":"a'), 0xff, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98, ...bytes('b"}}]}\n\n')] }, finish('stop'), DONE]),
    chat([{ bytes: [...bytes('data: {"choices":[{"delta":{"content":"caf'), 0xc3] }, { bytes: [0xa9, ...bytes('"}}]}\n\n')] }, finish('stop'), DONE]),
    chat([{ bytes: [...bytes('data: {"choices":[{"delta":{"content":"'), 0xf0] }, { bytes: [0x9f] }, { bytes: [0x98, 0x80, ...bytes('"}}]}\n\n')] }, finish('stop'), DONE]),
    chat([...ok, { bytes: [0xe2, 0x82] }]),
    chat(['data:' + JSON.stringify({ choices: [{ delta: { content: 'tight' } }] }) + '\n\n', finish('stop'), DONE]),
    chat(['data:    ' + JSON.stringify({ choices: [{ delta: { content: 'spaces' } }] }) + '\n\n', finish('stop'), DONE]),
    chat(['data:　﻿' + JSON.stringify({ choices: [{ delta: { content: 'unicode' } }] }) + '\n\n', finish('stop'), DONE]),
    chat(['data: {"choices":\ndata: [{"delta":{"content":"multi"}}]}\n\n', finish('stop'), DONE]),
    chat([': keepalive\n\n', 'id: 4\nretry: 10\n' + content('fields'), 'DATA: ignored\n\n', 'data\n\n', finish('stop'), DONE]),
    chat(['event:  chunk  \n' + content('named'), finish('stop'), DONE]),
    chat(['event: chunk\ndata: ' + JSON.stringify({ type: 'other', choices: [] }) + '\n\n', DONE]),
    chat(['event: same\ndata: ' + JSON.stringify({ type: 'same', choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }) + '\n\n', DONE]),
    chat(['data: ' + JSON.stringify({ type: 7, choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n', DONE]),
    chat([content('a'), finish('stop'), 'data: [DONE]']),
    chat([content('a'), finish('stop'), 'data: [DONE]\n']),
    chat([content('a'), finish('stop'), 'data: [DONE] \n\n']),
    chat([content('a'), finish('stop'), 'data:[DONE]\n\n']),
    chat([content('one') + content('two') + content('three'), finish('stop'), DONE], { abortAfterEvents: 1 }),
    chat([content('one'), content('two')], { abortAfterEvents: 1, response: { body: [content('one'), content('two')], end: 'hang' } }),
    chat([content('one')], { abortAfterEvents: 1, response: { body: [content('one')], end: 'hang' } }),
    chat([content('one')], { response: { body: [content('one')], end: 'terminated' } }),
    chat([], { response: { body: [], end: 'terminated' } }),
    chat([]), chat(['\n\n\n\n']), chat([' ']),
    // The event cap measures the whole buffer after each read, before events are split off. Every chunk fits one
    // 64 KiB native read, so both runtimes see the same reads.
    chat([': ' + 'x'.repeat(65532), { chunk: x64, count: 15 }, '\n\n', ...ok]),
    chat([': ' + 'x'.repeat(65533), { chunk: x64, count: 15 }, '\n\n', ...ok]),
    chat([{ chunk: x64, count: 16 }, 'x']),
    chat([{ chunk: chunk64, count: 16 }, ...ok]),
    // The stream cap counts every byte read, even after [DONE].
    chat([{ chunk: chunk64, count: 127 }, comment(65536 - tail.length) + tail]),
    chat([{ chunk: chunk64, count: 127 }, comment(65536 - tail.length) + tail, '\n']),
    chat([{ chunk: chunk64, count: 128 }, ...ok]),
    // The event count cap counts blocks with and without data.
    chat([{ text: '\n\n', times: 9997 }, content('a'), finish('stop'), DONE]),
    chat([{ text: '\n\n', times: 9998 }, content('a'), finish('stop'), DONE]),
    chat([{ text: '\n\n', times: 10001 }]),
  ];
}

// ---- The Chat Completions parser -----------------------------------------------------------------------------------
function chatParser(): Input[] {
  const tools = fixtureTools;
  const withTools = (body: Body, extra: Partial<Input> = {}): Input => chat(body, { tools, ...extra });
  const usage = { prompt_tokens: 7, completion_tokens: 3 };
  return [
    chat([content(''), finish('stop'), DONE]),
    chat([finish('stop'), DONE]),
    chat([frame({ choices: [{ delta: { content: 'a' } }, { delta: { content: 'b' }, finish_reason: 'stop' }] }), DONE]),
    chat([frame({ choices: [{ delta: { content: 3 } }, null, 'x', { delta: 'not a record', finish_reason: 'stop' }] }), DONE]),
    chat([frame({ choices: 'not an array' }), content('x'), finish('stop'), DONE]),
    chat([frame({ choices: [{ delta: { content: 'x' }, finish_reason: '' }] }), finish('stop'), DONE]),
    chat([content('x'), finish('length'), usageFrame(usage), DONE]),
    chat([content('x'), finish('content_filter'), DONE]),
    chat([content('x'), finish('length'), finish('stop'), DONE]),
    chat([finish('length'), content('after failure'), DONE]),
    chat([content('x'), DONE]),
    chat([content('x'), finish('stop')]),
    chat([content('x'), finish('stop'), DONE, DONE]),
    chat([content('x'), finish('stop'), DONE, content('late')]),
    chat([content('x'), finish('stop'), content('late'), DONE]),
    chat([content('x'), finish('stop'), finish('stop'), DONE]),
    chat([content('x'), finish('stop'), frame({ choices: [{ delta: {} }] }), usageFrame(usage), DONE]),
    chat([content('x'), finish('stop'), call(0, { id: 'c', function: { name: 'read_file', arguments: '{}' } }), DONE]),
    chat([frame({ choices: [{ delta: { refusal: 'No' } }], usage }), DONE]),
    chat([frame({ choices: [{ delta: { function_call: { name: 'old' } } }], usage }), DONE]),
    chat([frame({ choices: [{ delta: { refusal: '' } }] }), finish('stop'), DONE]),
    chat([frame({ error: { message: 'boom' }, usage }), DONE]),
    chat([frame({ error: 0 }), finish('stop'), DONE]),
    chat(['data: not json\n\n']), chat(['data: [1,2]\n\n']), chat(['data: null\n\n']), chat(['data: "text"\n\n']), chat(['data: {"choices":[]}garbage\n\n']),
    chat(['data: {"choices":[],"choices":[{"delta":{"content":"last"},"finish_reason":"stop"}]}\n\n', DONE]),
    // Metadata: every frame that names a model or id, before that frame's other checks.
    chat([content('x', { id: 'chat-1', model: 'returned-model' }), content('y', { id: 'chat-1', model: 'returned-model' }), finish('stop'), DONE]),
    chat([content('x', { id: '', model: 'm'.repeat(200) }), content('y', { id: 'i'.repeat(201), model: 7 }), finish('stop'), DONE]),
    chat([frame({ id: 'chat-err', error: true }), DONE]),
    // Usage: the last valid report wins and is emitted once, before any terminal failure.
    chat([content('x'), finish('stop'), usageFrame({ ...usage, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } }), DONE]),
    chat([usageFrame(usage), content('x'), finish('stop'), usageFrame({ prompt_tokens: 9, completion_tokens: 4 }), DONE]),
    chat([usageFrame(usage), content('x'), finish('stop'), usageFrame({ prompt_tokens: -1, completion_tokens: 4 }), DONE]),
    ...[{ prompt_tokens: 1.5, completion_tokens: 1 }, { prompt_tokens: '7', completion_tokens: 3 }, { prompt_tokens: 2 ** 53, completion_tokens: 1 }, { prompt_tokens: 2 ** 53 - 1, completion_tokens: 0 },
      { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 6 } }, { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -1 } },
      { prompt_tokens: 5, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 3 } }, { prompt_tokens: 5, completion_tokens: 2, cache_creation_input_tokens: 3, prompt_tokens_details: { cached_tokens: 3 } },
      { prompt_tokens: 5, completion_tokens: 2, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 }, { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 1 } },
      { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: 'x', completion_tokens_details: null }, { prompt_tokens: 0, completion_tokens: 0 },
      { prompt_tokens: 5, completion_tokens: 2, cache_creation_input_tokens: null }, { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: null }, cache_read_input_tokens: 2 },
      { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: null } }, { prompt_tokens: 5, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: null } },
      { input_tokens: null, prompt_tokens: 5, output_tokens: 2, completion_tokens: 9 }]
      .map(value => chat([content('x'), finish('stop'), usageFrame(value), DONE])),
    chat([content('x'), finish('stop'), 'data: {"choices":[],"usage":{"prompt_tokens":1e400,"completion_tokens":1}}\n\n', DONE]),
    chat([content('x'), finish('stop'), 'data: {"choices":[],"prompt_tokens":4,"completion_tokens":1}\n\n', DONE]),
    // Tool calls.
    withTools([call(0, { id: 'c1', function: { name: 'read_file', arguments: '{"path":"' } }), call(0, { function: { arguments: 'README.md"}' } }), finish('tool_calls'), DONE]),
    withTools([call(1, { id: 'c2', function: { name: 'fixture_tool', arguments: '{}' } }), call(0, { id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } }), finish('tool_calls'), DONE]),
    withTools([call(0, { id: 'c1', function: { name: 'read_file', arguments: '{}' } }), call(5, { id: 'c5', function: { name: 'fixture_tool', arguments: '[]' } }), finish('tool_calls'), DONE]),
    withTools([content('thinking aloud'), call(0, { id: 'c1', function: { name: 'read_file', arguments: '{"b":1,"a":2.50,"c":1e2,"d":"\\u00e9","__proto__":{"x":1},"0":true}' } }), finish('tool_calls'), DONE]),
    ...['', '{"path":', 'nope', '"text"', '3', 'null', '[1,2]', '{"a":1e400}', '{"a":1,"a":2}'].map(args => withTools([call(0, { id: 'c1', function: { name: 'read_file', arguments: args } }), finish('tool_calls'), DONE])),
    withTools([call(0, { id: 'c1', function: { name: 'read_file' } }), finish('tool_calls'), DONE]),
    withTools([call(0, { id: 'c1', function: { name: 'not_advertised', arguments: '{}' } }), finish('tool_calls'), DONE]),
    chat([call(0, { id: 'c1', function: { name: 'read_file', arguments: '{}' } }), finish('tool_calls'), DONE]),
    withTools([call(0, { id: 'c1', function: { name: 'read_file', arguments: '{}' } }), call(1, { id: 'c1', function: { name: 'fixture_tool', arguments: '{}' } }), finish('tool_calls'), DONE]),
    withTools([call(0, { function: { name: 'read_file', arguments: '{}' } }), finish('tool_calls'), DONE]),
    withTools([call(0, { id: 'c1', function: { arguments: '{}' } }), finish('tool_calls'), DONE]),
    withTools([call(0, { id: '', function: { name: 'read_file', arguments: '{}' } }), finish('tool_calls'), DONE]),
    withTools([call(0, { id: 'c1', function: { name: 'read_file', arguments: '{}' } }), call(0, { id: 'c9', function: { name: 'fixture_tool' } }), finish('tool_calls'), DONE]),
    withTools([call(0, { id: 7, function: { name: 'read_file', arguments: '{}' } }), finish('tool_calls'), DONE]),
    withTools([call(0, { id: 'c1', function: 'not a record' }), finish('tool_calls'), DONE]),
    withTools([call(0.5, { id: 'c1', function: { name: 'read_file', arguments: '{}' } }), finish('tool_calls'), DONE]),
    withTools([frame({ choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] } }] }), finish('tool_calls'), DONE]),
    withTools([frame({ choices: [{ delta: { tool_calls: [null] } }] }), finish('tool_calls'), DONE]),
    withTools([frame({ choices: [{ delta: { tool_calls: 'not an array' } }] }), finish('stop'), DONE]),
    withTools([call(0, { id: 'c1', function: { name: 'read_file', arguments: '{}' } }), finish('stop'), DONE]),
    withTools([content('x'), finish('tool_calls'), DONE]),
    withTools([call(0, { id: 'c1', function: { name: 'read_file', arguments: '{}' } }), finish('tool_calls'), usageFrame(usage), DONE]),
    withTools([call(0, { id: 'c1', function: { name: 'read_file', arguments: '{}' } }), finish('tool_calls'), DONE], { abortAfterEvents: 1 }),
    withTools([frame({ choices: [{ delta: { content: 'a', tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }), DONE]),
    // A tool continuation through the parser: the stored state, then the next request with its results.
    chat([content('done'), finish('stop'), DONE], { tools, messages: [], continuation: { apiKind: 'chat-completions', data: { messages: [{ role: 'user', content: 'first' }], calls: [{ id: 'c1', name: 'read_file', arguments: {} }] } }, toolResults: [{ id: 'c1', name: 'read_file', content: '{"path":"README.md","content":"x","hash":"h"}', isError: false }] }),
  ];
}

// ---- Recording fetch -----------------------------------------------------------------------------------------------
function encode(body: Body): Uint8Array[] {
  const encoder = new TextEncoder();
  const one = (chunk: Chunk): Uint8Array => typeof chunk === 'string' ? encoder.encode(chunk) : 'bytes' in chunk ? Uint8Array.from(chunk.bytes) : encoder.encode(chunk.text.repeat(chunk.times));
  return body.flatMap(item => typeof item === 'object' && 'chunk' in item ? Array.from({ length: item.count }, () => one(item.chunk)) : [one(item)]);
}
const scrub = (value: string): string => value.split(credential).join('{credential}');
const base = (kind: ApiKind): ModelProfile => ({ id: '0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53', name: 'Transport', apiKind: kind, endpoint: 'https://sample.openai.azure.com', deployment: 'test-model', contextLimit: 4096, outputLimit: 256 });
const sources = ['packages/providers/src/index.ts', 'packages/protocol/src/limits.ts', 'packages/runtime/src/tool-definitions.ts'];

afterEach(() => { vi.restoreAllMocks(); });

it('pins the Azure adapter requests, transport, SSE framing and the Chat Completions parser', async () => {
  const cases = [];
  for (const [index, input] of inputs().entries()) {
    vi.restoreAllMocks();
    if (input.now !== undefined) vi.spyOn(Date, 'now').mockReturnValue(input.now);
    const requests: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      requests.push({ url: String(url), method: init?.method, headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, scrub(value)])), body: scrub(String(init?.body)), redirect: init?.redirect });
      if (input.fetchRejects) throw new TypeError('fetch failed');
      const response = input.response ?? {};
      const chunks = response.body === null ? null : encode(response.body ?? []);
      // One chunk per read. After the chunks the stream closes, fails as undici's does on a lost connection, or waits.
      let next = 0;
      const stream = chunks === null ? null : new ReadableStream<Uint8Array>({
        pull(controller) {
          if (next < chunks.length) { controller.enqueue(chunks[next++]!); return; }
          const end = response.end ?? 'close';
          if (end === 'close') controller.close();
          else if (end === 'terminated') controller.error(new TypeError('terminated'));
          else return new Promise<void>(() => undefined);
        },
      }, { highWaterMark: 0 });
      return new Response(stream, { status: response.status ?? 200, headers: response.headers ?? [] });
    });
    const controller = new AbortController(); if (input.abortBefore) controller.abort();
    const profile = { ...base(input.kind), ...input.profile } as ModelProfile;
    const events: ProviderEvent[] = []; let error: Record<string, unknown> | null = null;
    try {
      const request = { profile, messages: input.messages ?? [user('hello')], signal: controller.signal, ...(input.credential === null ? {} : { credential: input.credential ?? credential }),
        ...(input.tools ? { tools: input.tools } : {}), ...(input.continuation ? { continuation: input.continuation } : {}), ...(input.toolResults ? { toolResults: input.toolResults } : {}) };
      for await (const event of createProvider(input.provider ?? input.kind, { fetch }).streamTurn(request)) {
        events.push(event);
        if (events.length === input.abortAfterEvents) controller.abort();
      }
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught;
      error = { name: caught.name, message: scrub(caught.message), ...(caught instanceof ProviderHttpError ? { status: caught.status, retryAfterSeconds: caught.retryAfterSeconds ?? null } : {}) };
    }
    cases.push({ name: `provider-transport:${index}`, input: { ...input, credential: input.credential === undefined ? '{credential}' : input.credential }, expected: { requests, events, error } });
  }
  const corpus = { oracle: { sources: sources.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) }, cases };
  const text = JSON.stringify(corpus, null, 2) + '\n';
  if (process.env.P2_WRITE_PROVIDER_TRANSPORT === '1') writeFileSync('tests/p2/provider-transport-vectors.json', text);
  expect(readFileSync('tests/p2/provider-transport-vectors.json', 'utf8')).toBe(text);
}, 120_000);
