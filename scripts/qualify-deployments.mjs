// Standalone Azure Foundry deployment qualification harness. No workspace imports: it must run with
// plain `node scripts/qualify-deployments.mjs` and never touch the network when --mock is passed.
import { createHash, randomUUID } from 'node:crypto';
import console from 'node:console';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { pathToFileURL, URL } from 'node:url';
import { TextDecoder } from 'node:util';

export const API_KINDS = ['responses', 'chat-completions', 'anthropic'];
export const DEFAULT_CREDENTIAL_ENV = 'AZURE_FOUNDRY_API_KEY';
export const DEFAULT_OUTPUT_PATH = 'qualification-report.json';

const NONCE_TOOL = { name: 'report_nonce', description: 'Report the given nonce value verbatim.', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } };
const UNKNOWN_USAGE = { promptTokens: 'unknown', completionTokens: 'unknown', cacheReadTokens: 'unknown', cacheCreationTokens: 'unknown' };

// ---------------------------------------------------------------------------
// Qualification engine
// ---------------------------------------------------------------------------

/**
 * Runs the 5-point qualification protocol against one deployment and returns the report object.
 * `mockOverrides[apiKind][turnKind]` lets tests substitute broken canned frames to exercise failure
 * classification without a live endpoint; it is not exposed on the CLI.
 */
export async function runQualification(options = {}) {
  const {
    endpoint,
    deployment,
    apiKind = 'responses',
    credential,
    mock = false,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    random = () => randomUUID(),
    mockOverrides
  } = options;

  if (!API_KINDS.includes(apiKind))
    throw new Error(`Unsupported --api-kind "${apiKind}". Expected one of: ${API_KINDS.join(', ')}.`);
  if (!mock && !credential)
    throw new Error('A credential is required unless --mock is set.');
  const resolvedEndpoint = endpoint ?? (mock ? 'https://mock.openai.azure.com' : undefined);
  const resolvedDeployment = deployment ?? (mock ? 'mock-deployment' : undefined);
  if (!resolvedEndpoint || !resolvedDeployment)
    throw new Error('--endpoint and --deployment are required unless --mock is set.');
  normalizeEndpoint(resolvedEndpoint, mock);

  const ctx = { apiKind, endpoint: resolvedEndpoint, deployment: resolvedDeployment, outputLimit: 512, mock, fetchImpl, now, credential, nonce: random(), overrides: mockOverrides };

  const streaming = await safeCheck(() => checkStreaming(ctx));
  const toolCalling = await safeCheck(() => checkToolCalling(ctx));
  const toolContinuation = await safeCheck(() => checkToolContinuation(ctx, toolCalling));
  const cancellation = await safeCheck(() => checkCancellation(ctx));
  const usageAccounting = await safeCheck(() => checkUsageAccounting(streaming));

  return {
    timestamp: new Date(now()).toISOString(),
    endpoint: resolvedEndpoint,
    deployment: resolvedDeployment,
    apiKind,
    fingerprint: computeFingerprint({ endpoint: resolvedEndpoint, deployment: resolvedDeployment, apiKind }),
    mock,
    capabilities: {
      streaming: streaming.ok,
      toolCalling: toolCalling.ok,
      toolContinuation: toolContinuation.ok,
      cancellation: cancellation.ok,
      usageAccounting: usageAccounting.ok
    },
    checks: {
      streaming: sanitize(streaming),
      toolCalling: sanitize(toolCalling),
      toolContinuation: sanitize(toolContinuation),
      cancellation: sanitize(cancellation),
      usageAccounting: sanitize(usageAccounting)
    },
    latency: {
      timeToFirstTokenMs: streaming.timeToFirstTokenMs ?? null,
      totalStreamMs: streaming.totalStreamMs ?? null,
      cancellationTeardownMs: cancellation.teardownMs ?? null
    },
    usage: usageAccounting.usage ?? UNKNOWN_USAGE
  };
}

async function safeCheck(fn) {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function sanitize(check) {
  return Object.fromEntries(Object.entries(check).filter(([key]) => !key.startsWith('_')));
}

// ---------------------------------------------------------------------------
// The 5-point protocol
// ---------------------------------------------------------------------------

async function checkStreaming(ctx) {
  const turn = await runTurn(ctx, { turnKind: 'streaming', userText: 'Reply with a short greeting.' });
  const text = joinText(turn.events);
  const ok = text.length > 0 && turn.events.some(event => event.type === 'done');
  return {
    ok,
    detail: ok ? `Streamed ${text.length} character(s) of text and received a completion signal.` : 'No streamed text and completion signal were both observed.',
    timeToFirstTokenMs: turn.ttftMs,
    totalStreamMs: turn.totalMs,
    _usageEvent: turn.events.find(event => event.type === 'usage')
  };
}

async function checkToolCalling(ctx) {
  const turn = await runTurn(ctx, { turnKind: 'tool-call', tools: [NONCE_TOOL], userText: `Call report_nonce exactly once with nonce="${ctx.nonce}" and no other text.` });
  const calls = turn.events.filter(event => event.type === 'tool_call');
  const call = calls[0]?.call;
  const ok = calls.length === 1 && call?.name === NONCE_TOOL.name && isRecord(call.arguments) && call.arguments.nonce === ctx.nonce;
  return {
    ok,
    detail: ok ? 'Received exactly one completed tool call with the nonce argument intact.' : calls.length === 0 ? 'No tool call was returned.' : calls.length > 1 ? 'More than one tool call was returned.' : 'The tool call arguments did not round-trip the nonce.',
    toolCall: call ? { id: call.id, name: call.name, arguments: call.arguments } : null,
    _call: call,
    _continuation: turn.continuation
  };
}

async function checkToolContinuation(ctx, toolCalling) {
  if (!toolCalling.ok || !toolCalling._call || !toolCalling._continuation)
    return { ok: false, detail: 'Skipped: native tool calling did not produce a usable call to continue from.' };
  const opaque = extractOpaqueContinuationData(ctx.apiKind, toolCalling._continuation);
  const toolResult = { id: toolCalling._call.id, name: toolCalling._call.name, content: JSON.stringify({ ok: true, echoedNonce: toolCalling._call.arguments?.nonce }) };
  const turn = await runTurn(ctx, { turnKind: 'continuation', continuation: toolCalling._continuation, toolResult, userText: 'Acknowledge the tool result in one short sentence.' });
  const text = joinText(turn.events);
  const done = turn.events.some(event => event.type === 'done');
  const preserved = opaque === undefined ? null : JSON.stringify(turn.requestBody).includes(opaque);
  const ok = done && text.length > 0 && preserved !== false;
  return {
    ok,
    detail: ok ? 'Continued the conversation past the tool result and preserved any opaque reasoning/signature data unchanged.' : preserved === false ? 'Opaque reasoning/signature continuation data was not round-tripped into the follow-up request.' : 'The continuation turn did not complete with streamed text.',
    preservedOpaqueContinuationData: preserved
  };
}

async function checkCancellation(ctx) {
  const controller = new AbortController();
  const startedAt = ctx.now();
  let firstTextAt;
  let abortAt;
  const turn = runTurn(ctx, {
    turnKind: 'cancellation',
    userText: 'Stream a long, multi-sentence answer.',
    signal: controller.signal,
    onEvent: event => {
      if (event.type === 'text' && firstTextAt === undefined) {
        firstTextAt = ctx.now();
        abortAt = ctx.now();
        controller.abort(new DOMException('Qualification cancellation check aborted mid-stream.', 'AbortError'));
      }
    }
  });
  let error;
  try {
    await turn;
  } catch (caught) {
    error = caught;
  }
  const endedAt = ctx.now();
  const isAbortError = error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));
  const ok = abortAt !== undefined && isAbortError;
  return {
    ok,
    detail: abortAt === undefined ? 'No text was streamed before the check ended; cancellation was never exercised.' : ok ? 'The stream terminated with an abort error promptly after the client cancelled it.' : 'The stream did not terminate with an abort error after the client cancelled it.',
    teardownMs: abortAt !== undefined ? endedAt - abortAt : null,
    timeToFirstTokenMs: firstTextAt !== undefined ? firstTextAt - startedAt : null
  };
}

function checkUsageAccounting(streaming) {
  const usage = streaming._usageEvent;
  if (!usage)
    return { ok: false, detail: 'No usage event was received.', usage: UNKNOWN_USAGE };
  const known = usage.promptTokens !== 'unknown' && usage.completionTokens !== 'unknown';
  return {
    ok: known,
    detail: known ? 'Prompt and completion token counts were reported; cache token fields were parsed or explicitly marked unknown.' : 'Prompt or completion token counts were missing or invalid; nothing was defaulted to zero.',
    usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens }
  };
}

function extractOpaqueContinuationData(apiKind, continuation) {
  const state = continuation?.state;
  if (!state) return undefined;
  if (apiKind === 'responses') {
    const reasoning = (state.input ?? []).find(item => isRecord(item) && item.type === 'reasoning' && typeof item.encrypted_content === 'string');
    return reasoning?.encrypted_content;
  }
  const assistant = [...(state.messages ?? [])].reverse().find(message => message.role === 'assistant');
  if (apiKind === 'anthropic') {
    const thinking = Array.isArray(assistant?.content) ? assistant.content.find(block => isRecord(block) && block.type === 'thinking' && typeof block.signature === 'string') : undefined;
    return thinking?.signature;
  }
  // Chat Completions has no reasoning/signature concept; the tool-call id is the analogous opaque token to round-trip.
  return assistant?.tool_calls?.[0]?.id;
}

function joinText(events) {
  return events.filter(event => event.type === 'text').map(event => event.text).join('');
}

// ---------------------------------------------------------------------------
// Turn execution: builds the request, sends or simulates it, and parses the stream
// ---------------------------------------------------------------------------

async function runTurn(ctx, { turnKind, tools, userText, continuation, toolResult, signal, onEvent }) {
  const effectiveSignal = signal ?? new AbortController().signal;
  const built = buildTurn(ctx.apiKind, { deployment: ctx.deployment, outputLimit: ctx.outputLimit, tools, continuation, userText, toolResult });
  const startedAt = ctx.now();
  let firstTextAt;
  const events = [];
  const chunks = ctx.mock
    ? mockChunkStream(mockFrames(ctx.apiKind, turnKind, ctx.nonce, ctx.overrides), effectiveSignal)
    : liveChunkStream(await sendLiveRequest(ctx, built, effectiveSignal), effectiveSignal);
  for await (const event of parseKindEvents(ctx.apiKind, sseFrames(chunks), built.state)) {
    if (event.type === 'text' && firstTextAt === undefined) firstTextAt = ctx.now();
    events.push(event);
    onEvent?.(event);
  }
  const endedAt = ctx.now();
  const done = events.find(event => event.type === 'done');
  return { events, requestBody: built.body, continuation: done?.continuation, ttftMs: firstTextAt !== undefined ? firstTextAt - startedAt : null, totalMs: endedAt - startedAt };
}

function buildTurn(apiKind, { deployment, outputLimit, tools, continuation, userText, toolResult }) {
  if (continuation && continuation.apiKind !== apiKind)
    throw new Error('Continuation belongs to a different API kind.');
  if (apiKind === 'responses') {
    const input = continuation ? [...continuation.state.input] : [];
    if (toolResult) input.push({ type: 'function_call_output', call_id: toolResult.id, output: toolResult.content });
    if (userText !== undefined) input.push({ role: 'user', content: userText });
    const body = { model: deployment, input, stream: true, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: outputLimit, ...(tools?.length ? { tools: tools.map(toResponsesTool) } : {}) };
    return { body, state: { input } };
  }
  if (apiKind === 'chat-completions') {
    const messages = continuation ? [...continuation.state.messages] : [];
    if (toolResult) messages.push({ role: 'tool', tool_call_id: toolResult.id, content: toolResult.content });
    if (userText !== undefined) messages.push({ role: 'user', content: userText });
    const body = { model: deployment, messages, stream: true, stream_options: { include_usage: true }, max_completion_tokens: outputLimit, ...(tools?.length ? { tools: tools.map(toChatTool) } : {}) };
    return { body, state: { messages } };
  }
  const messages = continuation ? [...continuation.state.messages] : [];
  if (toolResult) messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolResult.id, content: toolResult.content, is_error: false }] });
  if (userText !== undefined) messages.push({ role: 'user', content: userText });
  const body = { model: deployment, messages, stream: true, max_tokens: outputLimit, ...(tools?.length ? { tools: tools.map(toAnthropicTool) } : {}) };
  return { body, state: { messages } };
}

function toResponsesTool(tool) { return { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }; }
function toChatTool(tool) { return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false } }; }
function toAnthropicTool(tool) { return { name: tool.name, description: tool.description, input_schema: tool.inputSchema }; }

function normalizeEndpoint(value, mock) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The --endpoint value must be a valid URL.');
  }
  if (mock) return url;
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocal)
    throw new Error('The --endpoint value must use HTTPS (plain HTTP is only accepted for localhost gateways).');
  return url;
}

function buildTarget(endpoint, apiKind) {
  const url = new URL(endpoint);
  url.pathname = apiKind === 'responses' ? '/openai/v1/responses' : apiKind === 'chat-completions' ? '/openai/v1/chat/completions' : '/anthropic/v1/messages';
  url.search = '';
  url.hash = '';
  return url;
}

function headersFor(apiKind, credential) {
  return { accept: 'text/event-stream', 'content-type': 'application/json', 'api-key': credential, ...(apiKind === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) };
}

async function sendLiveRequest(ctx, built, signal) {
  const response = await ctx.fetchImpl(buildTarget(ctx.endpoint, ctx.apiKind), { method: 'POST', headers: headersFor(ctx.apiKind, ctx.credential), body: JSON.stringify(built.body), signal, redirect: 'error' });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Provider request failed with HTTP ${response.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}.`);
  }
  if (!response.body) throw new Error('Provider returned no response stream.');
  return response.body;
}

function computeFingerprint({ endpoint, deployment, apiKind }) {
  return createHash('sha256').update(JSON.stringify({ endpoint, deployment, apiKind })).digest('hex');
}

// ---------------------------------------------------------------------------
// Chunk sources: live network bytes or mock canned frames, unified before SSE parsing
// ---------------------------------------------------------------------------

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function* mockChunkStream(frames, signal) {
  for (const frame of frames) {
    // Checked before the delay, not just before yielding, so an abort fired while idle between
    // frames is caught on the very next resumption instead of waiting for another full frame.
    if (signal.aborted) throw abortError(signal);
    await delay(12, signal);
    if (signal.aborted) throw abortError(signal);
    yield frame;
  }
}

async function* liveChunkStream(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => { reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw abortError(signal);
      const next = await reader.read();
      if (signal.aborted) throw abortError(signal);
      if (next.done) return;
      yield decoder.decode(next.value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

async function* sseFrames(chunks) {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseSseFrame(raw);
      if (frame) yield frame;
    }
  }
}

function parseSseFrame(raw) {
  let event;
  const data = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join('\n') } : undefined;
}

// ---------------------------------------------------------------------------
// Per-API-kind SSE parsing into normalized events, mirroring each provider's real wire format
// ---------------------------------------------------------------------------

async function* parseKindEvents(apiKind, frames, initialState) {
  if (apiKind === 'responses') yield* parseResponses(frames, initialState);
  else if (apiKind === 'chat-completions') yield* parseChat(frames, initialState);
  else yield* parseAnthropic(frames, initialState);
}

function parseJson(data) {
  try {
    const value = JSON.parse(data);
    if (!isRecord(value)) throw new Error();
    return value;
  } catch {
    throw new Error('Provider sent malformed SSE JSON.');
  }
}

function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function validInt(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function usageValue(value) { return validInt(value) ? value : 'unknown'; }
function parseToolArguments(value) {
  try { return JSON.parse(value); } catch { throw new Error('Tool call arguments were not complete JSON.'); }
}

async function* parseResponses(frames, initialState) {
  const items = [];
  let completed = false;
  for await (const frame of frames) {
    const payload = parseJson(frame.data);
    const type = frame.event ?? payload.type;
    if (type === 'response.output_text.delta') {
      if (typeof payload.delta !== 'string') throw new Error('Invalid Responses text delta.');
      yield { type: 'text', text: payload.delta };
    } else if (type === 'response.output_item.done') {
      if (!isRecord(payload.item)) throw new Error('Invalid Responses output item.');
      items.push(payload.item);
    } else if (type === 'response.completed') {
      const response = isRecord(payload.response) ? payload.response : {};
      if (response.status !== 'completed') throw new Error(`Responses completion ended with status "${String(response.status)}".`);
      const output = Array.isArray(response.output) ? response.output : items;
      const usage = usageFromResponses(response.usage);
      if (usage) yield usage;
      const calls = output.filter(item => isRecord(item) && item.type === 'function_call').map(toResponsesCall);
      for (const call of calls) yield { type: 'tool_call', call };
      completed = true;
      yield { type: 'done', continuation: { apiKind: 'responses', state: { input: [...(initialState?.input ?? []), ...output] } } };
    } else if (type === 'response.failed' || type === 'error') {
      throw new Error('Responses provider reported a failure.');
    }
  }
  if (!completed) throw new Error('Provider stream ended before a completion signal.');
}

function toResponsesCall(item) {
  if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string')
    throw new Error('Invalid Responses function call.');
  return { id: item.call_id, name: item.name, arguments: parseToolArguments(item.arguments) };
}

function usageFromResponses(usage) {
  if (!isRecord(usage)) return undefined;
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  return { type: 'usage', promptTokens: usageValue(usage.input_tokens), completionTokens: usageValue(usage.output_tokens), cacheReadTokens: usageValue(details?.cached_tokens), cacheCreationTokens: 'unknown' };
}

async function* parseChat(frames, initialState) {
  const parts = new Map();
  let content = '';
  let done = false;
  let terminal;
  let usageEvent;
  for await (const frame of frames) {
    if (frame.data === '[DONE]') { done = true; break; }
    const payload = parseJson(frame.data);
    if (payload.error) throw new Error('Chat Completions provider reported an error.');
    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === 'string') { content += delta.content; yield { type: 'text', text: delta.content }; }
      if (Array.isArray(delta.tool_calls)) for (const part of delta.tool_calls) addChatPart(parts, part);
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') terminal = choice.finish_reason;
    }
    const maybeUsage = usageFromChat(payload.usage);
    if (maybeUsage) usageEvent = maybeUsage;
  }
  if (!done) throw new Error('Provider stream ended before [DONE].');
  if (!terminal) throw new Error('Chat completion ended without a terminal finish reason.');
  const calls = [...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => toChatCall(part));
  if ((terminal === 'tool_calls') !== Boolean(calls.length))
    throw new Error('Chat completion tool-call finish state was inconsistent.');
  if (usageEvent) yield usageEvent;
  for (const call of calls) yield { type: 'tool_call', call };
  const assistant = { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) };
  yield { type: 'done', continuation: { apiKind: 'chat-completions', state: { messages: [...(initialState?.messages ?? []), assistant] } } };
}

function addChatPart(parts, raw) {
  if (!isRecord(raw) || !Number.isInteger(raw.index)) throw new Error('Invalid chat tool-call delta.');
  const part = parts.get(raw.index) ?? { arguments: '' };
  if (typeof raw.id === 'string') part.id = raw.id;
  const fn = isRecord(raw.function) ? raw.function : {};
  if (typeof fn.name === 'string') part.name = fn.name;
  if (typeof fn.arguments === 'string') part.arguments += fn.arguments;
  parts.set(raw.index, part);
}

function toChatCall(part) {
  if (!part.id || !part.name) throw new Error('Incomplete chat tool call.');
  return { id: part.id, name: part.name, arguments: parseToolArguments(part.arguments) };
}

function usageFromChat(usage) {
  if (!isRecord(usage)) return undefined;
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  return { type: 'usage', promptTokens: usageValue(usage.prompt_tokens), completionTokens: usageValue(usage.completion_tokens), cacheReadTokens: usageValue(details?.cached_tokens), cacheCreationTokens: 'unknown' };
}

async function* parseAnthropic(frames, initialState) {
  const blocks = new Map();
  const stopped = new Set();
  let promptTokens, cacheRead, cacheCreation, completionTokens;
  let usageEvent;
  let done = false;
  let stopReason;
  for await (const frame of frames) {
    const payload = parseJson(frame.data);
    const type = frame.event ?? payload.type;
    if (type === 'message_start') {
      const usage = isRecord(payload.message) && isRecord(payload.message.usage) ? payload.message.usage : {};
      if (validInt(usage.input_tokens)) promptTokens = usage.input_tokens;
      if (validInt(usage.cache_read_input_tokens)) cacheRead = usage.cache_read_input_tokens;
      if (validInt(usage.cache_creation_input_tokens)) cacheCreation = usage.cache_creation_input_tokens;
    } else if (type === 'content_block_start') {
      if (!Number.isInteger(payload.index) || !isRecord(payload.content_block)) throw new Error('Invalid Anthropic content block.');
      if (blocks.has(payload.index)) throw new Error('Duplicate Anthropic content block.');
      blocks.set(payload.index, { ...payload.content_block });
    } else if (type === 'content_block_delta') {
      const text = applyAnthropicDelta(blocks, payload);
      if (text) yield { type: 'text', text };
    } else if (type === 'content_block_stop') {
      if (!Number.isInteger(payload.index) || !blocks.has(payload.index)) throw new Error('Invalid Anthropic content block stop.');
      stopped.add(payload.index);
    } else if (type === 'message_delta') {
      const delta = isRecord(payload.delta) ? payload.delta : {};
      if (delta.stop_reason !== 'end_turn' && delta.stop_reason !== 'tool_use')
        throw new Error(`Anthropic completion ended with stop reason "${String(delta.stop_reason)}".`);
      stopReason = delta.stop_reason;
      const usage = isRecord(payload.usage) ? payload.usage : {};
      if (validInt(usage.output_tokens)) completionTokens = usage.output_tokens;
      if (validInt(usage.cache_read_input_tokens)) cacheRead = usage.cache_read_input_tokens;
      if (validInt(usage.cache_creation_input_tokens)) cacheCreation = usage.cache_creation_input_tokens;
      usageEvent = { type: 'usage', promptTokens: usageValue(promptTokens), completionTokens: usageValue(completionTokens), cacheReadTokens: usageValue(cacheRead), cacheCreationTokens: usageValue(cacheCreation) };
    } else if (type === 'message_stop') {
      done = true;
    } else if (type === 'error') {
      throw new Error('Anthropic provider reported an error.');
    }
  }
  if (!done) throw new Error('Provider stream ended before message_stop.');
  if (!stopReason) throw new Error('Anthropic completion ended without a stop reason.');
  if (stopped.size !== blocks.size) throw new Error('Anthropic completion ended before all content blocks stopped.');
  if (usageEvent) yield usageEvent;
  const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => finalizeAnthropicBlock(block));
  const calls = content.filter(block => block.type === 'tool_use').map(toAnthropicCall);
  if ((stopReason === 'tool_use') !== Boolean(calls.length))
    throw new Error('Anthropic tool-call stop state was inconsistent.');
  for (const call of calls) yield { type: 'tool_call', call };
  yield { type: 'done', continuation: { apiKind: 'anthropic', state: { messages: [...(initialState?.messages ?? []), { role: 'assistant', content }] } } };
}

function applyAnthropicDelta(blocks, payload) {
  const block = blocks.get(payload.index);
  const delta = isRecord(payload.delta) ? payload.delta : undefined;
  if (!block || !delta) throw new Error('Invalid Anthropic content delta.');
  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`;
    return delta.text;
  }
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
    return undefined;
  }
  if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
    block.signature = delta.signature;
    return undefined;
  }
  if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
    block.__json = `${typeof block.__json === 'string' ? block.__json : ''}${delta.partial_json}`;
    return undefined;
  }
  throw new Error('Invalid Anthropic content delta.');
}

function finalizeAnthropicBlock(block) {
  const output = { ...block };
  if (typeof output.__json === 'string') {
    output.input = parseToolArguments(output.__json);
    delete output.__json;
  }
  return output;
}

function toAnthropicCall(block) {
  if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name)
    throw new Error('Incomplete Anthropic tool call.');
  return { id: block.id, name: block.name, arguments: block.input };
}

// ---------------------------------------------------------------------------
// Mock (offline) fixtures: canned SSE frames fed through the same parsers as a live response
// ---------------------------------------------------------------------------

function mockFrames(apiKind, turnKind, nonce, overrides) {
  const override = overrides?.[apiKind]?.[turnKind];
  if (override) return typeof override === 'function' ? override(nonce) : override;
  if (apiKind === 'responses') return mockResponsesFrames(turnKind, nonce);
  if (apiKind === 'chat-completions') return mockChatFrames(turnKind, nonce);
  return mockAnthropicFrames(turnKind, nonce);
}

function sseEvent(event, payload) { return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`; }
function sseData(payload) { return `data: ${JSON.stringify(payload)}\n\n`; }
const SSE_DONE = 'data: [DONE]\n\n';

function mockResponsesFrames(turnKind, nonce) {
  if (turnKind === 'streaming') return [
    sseEvent('response.output_text.delta', { delta: 'Hello' }),
    sseEvent('response.output_text.delta', { delta: ', world.' }),
    sseEvent('response.completed', { response: { status: 'completed', output: [{ type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'Hello, world.' }] }], usage: { input_tokens: 18, output_tokens: 6, input_tokens_details: { cached_tokens: 4 } } } })
  ];
  if (turnKind === 'tool-call') {
    const reasoning = { type: 'reasoning', id: 'r1', encrypted_content: `opaque-reasoning-${nonce}` };
    const call = { type: 'function_call', call_id: 'call-1', name: 'report_nonce', arguments: JSON.stringify({ nonce }) };
    return [sseEvent('response.output_item.done', { item: reasoning }), sseEvent('response.output_item.done', { item: call }), sseEvent('response.completed', { response: { status: 'completed', output: [reasoning, call], usage: { input_tokens: 24, output_tokens: 9 } } })];
  }
  if (turnKind === 'continuation') return [
    sseEvent('response.output_text.delta', { delta: `Acknowledged ${nonce}.` }),
    sseEvent('response.completed', { response: { status: 'completed', output: [{ type: 'message', id: 'm2', content: [{ type: 'output_text', text: `Acknowledged ${nonce}.` }] }], usage: { input_tokens: 30, output_tokens: 5 } } })
  ];
  if (turnKind === 'cancellation') return Array.from({ length: 6 }, (_, index) => sseEvent('response.output_text.delta', { delta: `chunk-${index} ` }));
  throw new Error(`Unknown mock scenario "${turnKind}" for responses.`);
}

function mockChatFrames(turnKind, nonce) {
  if (turnKind === 'streaming') return [
    sseData({ choices: [{ delta: { content: 'Hello' } }] }),
    sseData({ choices: [{ delta: { content: ', world.' }, finish_reason: 'stop' }] }),
    sseData({ choices: [], usage: { prompt_tokens: 18, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 4 } } }),
    SSE_DONE
  ];
  if (turnKind === 'tool-call') return [
    sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'report_nonce', arguments: '{"nonce":"' } }] } }] }),
    sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `${nonce}"}` } }] }, finish_reason: 'tool_calls' }] }),
    sseData({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } }),
    SSE_DONE
  ];
  if (turnKind === 'continuation') return [
    sseData({ choices: [{ delta: { content: `Acknowledged ${nonce}.` }, finish_reason: 'stop' }] }),
    sseData({ choices: [], usage: { prompt_tokens: 26, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } } }),
    SSE_DONE
  ];
  if (turnKind === 'cancellation') return [...Array.from({ length: 6 }, (_, index) => sseData({ choices: [{ delta: { content: `chunk-${index} ` } }] })), SSE_DONE];
  throw new Error(`Unknown mock scenario "${turnKind}" for chat-completions.`);
}

function mockAnthropicFrames(turnKind, nonce) {
  if (turnKind === 'streaming') return [
    sseEvent('message_start', { message: { usage: { input_tokens: 15 } } }),
    sseEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ', world.' } }),
    sseEvent('content_block_stop', { index: 0 }),
    sseEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } }),
    sseEvent('message_stop', {})
  ];
  if (turnKind === 'tool-call') return [
    sseEvent('message_start', { message: { usage: { input_tokens: 20 } } }),
    sseEvent('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sseEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Deciding to call report_nonce.' } }),
    sseEvent('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: `sig-${nonce}` } }),
    sseEvent('content_block_stop', { index: 0 }),
    sseEvent('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'report_nonce' } }),
    sseEvent('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ nonce }) } }),
    sseEvent('content_block_stop', { index: 1 }),
    sseEvent('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }),
    sseEvent('message_stop', {})
  ];
  if (turnKind === 'continuation') return [
    sseEvent('message_start', { message: { usage: { input_tokens: 25, cache_read_input_tokens: 12, cache_creation_input_tokens: 5 } } }),
    sseEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `Acknowledged ${nonce}.` } }),
    sseEvent('content_block_stop', { index: 0 }),
    sseEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    sseEvent('message_stop', {})
  ];
  if (turnKind === 'cancellation') return [
    sseEvent('message_start', { message: { usage: { input_tokens: 10 } } }),
    sseEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...Array.from({ length: 6 }, (_, index) => sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `chunk-${index} ` } }))
  ];
  throw new Error(`Unknown mock scenario "${turnKind}" for anthropic.`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const FLAGS = { '--endpoint': 'endpoint', '--deployment': 'deployment', '--api-kind': 'apiKind', '--credential-env': 'credentialEnv', '--output': 'output' };

function parseArgs(argv) {
  const result = { mock: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--mock') { result.mock = true; continue; }
    if (arg === '--help' || arg === '-h') { result.help = true; continue; }
    const eq = arg.indexOf('=');
    const [flag, inlineValue] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const key = FLAGS[flag];
    if (!key) throw new Error(`Unknown argument "${arg}".`);
    const value = inlineValue !== undefined ? inlineValue : argv[++index];
    if (value === undefined) throw new Error(`Missing value for "${flag}".`);
    result[key] = value;
  }
  return result;
}

function printUsage() {
  console.log([
    'Usage: node scripts/qualify-deployments.mjs [options]',
    '',
    '  --endpoint <url>          Azure Foundry endpoint. Required unless --mock.',
    '  --deployment <name>       Model deployment name. Required unless --mock.',
    '  --api-kind <kind>         responses | chat-completions | anthropic. Defaults to responses.',
    `  --credential-env <var>    Env var holding the API key. Defaults to ${DEFAULT_CREDENTIAL_ENV}.`,
    '  --mock                    Run entirely offline against simulated provider responses.',
    `  --output <path>           Report destination. Defaults to ./${DEFAULT_OUTPUT_PATH}.`
  ].join('\n'));
}

function printSummary(report, outputPath) {
  const lines = Object.entries(report.capabilities).map(([name, ok]) => `  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`Qualification of ${report.deployment} (${report.apiKind}${report.mock ? ', mock' : ''}):`);
  console.log(lines.join('\n'));
  console.log(`Report written to ${outputPath}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (args.help) { printUsage(); return; }
  const mock = args.mock;
  if (!mock && (!args.endpoint || !args.deployment || !args.apiKind)) {
    console.error('--endpoint, --deployment, and --api-kind are required unless --mock is set.');
    printUsage();
    process.exitCode = 1;
    return;
  }
  let credential;
  if (!mock) {
    const credentialEnv = args.credentialEnv ?? DEFAULT_CREDENTIAL_ENV;
    credential = process.env[credentialEnv];
    if (!credential) {
      console.error(`Environment variable ${credentialEnv} is not set or is empty.`);
      process.exitCode = 1;
      return;
    }
  }
  let report;
  try {
    report = await runQualification({ endpoint: args.endpoint, deployment: args.deployment, apiKind: args.apiKind ?? 'responses', credential, mock });
  } catch (error) {
    console.error(`Qualification could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const outputPath = path.resolve(process.cwd(), args.output ?? DEFAULT_OUTPUT_PATH);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  printSummary(report, outputPath);
  if (!Object.values(report.capabilities).every(Boolean)) process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main().catch(error => { console.error(error); process.exitCode = 1; });
