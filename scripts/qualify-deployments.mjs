// Azure Foundry deployment qualification developer tool. Requires installed dev dependencies;
// plain `node scripts/qualify-deployments.mjs` runs the shipping provider adapter. --mock never uses the network.
import { randomUUID } from 'node:crypto';
import console from 'node:console';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { loadQualificationProvider } from './qualification-provider.mjs';

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
  const { createProvider, profileFingerprint } = await loadQualificationProvider();
  const profile = { id: 'qualification', name: 'Qualification', apiKind, endpoint: resolvedEndpoint, deployment: resolvedDeployment, contextLimit: 32000, outputLimit: 512 };
  // Use the same endpoint validation and configuration seal as the application.
  const fingerprint = profileFingerprint(profile);

  const ctx = { apiKind, profile, createProvider, mock, fetchImpl, now, credential, nonce: random(), overrides: mockOverrides };

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
    fingerprint,
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
  const state = continuation?.data;
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
  let requestBody;
  const provider = ctx.createProvider(ctx.apiKind, { fetch: async (target, init) => {
    requestBody = JSON.parse(init.body);
    if (!ctx.mock) return ctx.fetchImpl(target, init);
    const chunks = mockChunkStream(mockFrames(ctx.apiKind, turnKind, ctx.nonce, ctx.overrides), effectiveSignal);
    const iterator = chunks[Symbol.asyncIterator]();
    const encoder = new globalThis.TextEncoder();
    return new globalThis.Response(new globalThis.ReadableStream({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (error) { controller.error(error); }
      },
      async cancel() { await iterator.return?.(); }
    }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const startedAt = ctx.now();
  let firstTextAt;
  const events = [];
  for await (const event of provider.streamTurn({
    profile: ctx.profile, credential: ctx.mock ? 'qualification-fixture' : ctx.credential,
    signal: effectiveSignal, messages: userText ? [{ role: 'user', content: userText }] : [],
    tools, continuation, ...(toolResult ? { toolResults: [{ ...toolResult, isError: false }] } : {})
  })) {
    if (event.type === 'text' && firstTextAt === undefined) firstTextAt = ctx.now();
    events.push(event.type === 'usage' ? {
      ...event, promptTokens: event.inputTokens, completionTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens ?? 'unknown', cacheCreationTokens: event.cacheCreationTokens ?? 'unknown'
    } : event);
    onEvent?.(event);
  }
  const endedAt = ctx.now();
  const done = events.find(event => event.type === 'done');
  return { events, requestBody, continuation: done?.continuation, ttftMs: firstTextAt !== undefined ? firstTextAt - startedAt : null, totalMs: endedAt - startedAt };
}

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

function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

// Wire fixtures are inputs to the production adapter, never a separate parser.
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
