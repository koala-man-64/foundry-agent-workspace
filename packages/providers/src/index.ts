import { createHash } from 'node:crypto';
import type {
  ApiKind,
  ModelProfile,
  ProbeResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest
} from '../../protocol/src/index.js';

const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_SSE_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_SSE_EVENTS = 10_000;
const AZURE_HOST_SUFFIXES = [
  '.openai.azure.com',
  '.services.ai.azure.com',
  '.cognitiveservices.azure.com',
  '.inference.ai.azure.com'
] as const;

type FetchImplementation = typeof fetch;

export interface ProviderOptions {
  fetch?: FetchImplementation;
}

interface SseFrame {
  event?: string;
  data: string;
}

/** Creates a text-chat provider. Tool calls and continuation are intentionally unsupported. */
export function createProvider(apiKind: ApiKind, options: ProviderOptions = {}): ProviderAdapter {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (apiKind === 'fake') return new FakeProvider();
  return new AzureTextProvider(apiKind, fetchImplementation);
}

export function profileFingerprint(profile: ModelProfile): string {
  // Credential identifiers, verification timestamps, and the credential itself are deliberately excluded.
  const configuration = JSON.stringify({
    apiKind: profile.apiKind,
    endpoint: profile.apiKind === 'fake' ? profile.endpoint : normalizeEndpoint(profile.endpoint).toString(),
    deployment: profile.deployment,
    contextLimit: profile.contextLimit,
    outputLimit: profile.outputLimit
  });
  return createHash('sha256').update(configuration).digest('hex');
}

class FakeProvider implements ProviderAdapter {
  async *streamTurn(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    throwIfAborted(request.signal);
    const prompt = lastUserMessage(request.messages);
    const response = `Fake response: ${prompt || 'No user message.'}`;

    for (const text of splitDeterministically(response, 12)) {
      throwIfAborted(request.signal);
      yield { type: 'text', text };
      // Yield to the event loop so timer- and UI-driven cancellation is observable.
      await yieldToEventLoop(request.signal);
    }
    throwIfAborted(request.signal);
    yield { type: 'done' };
  }

  async probe(profile: ModelProfile): Promise<ProbeResult> {
    return {
      ok: profile.apiKind === 'fake',
      capabilities: { streaming: true, tools: false, continuation: false, cancellation: true, usage: false },
      detail: profile.apiKind === 'fake' ? 'Offline deterministic text-chat provider is available.' : 'Profile API kind does not match this provider.',
      fingerprint: profileFingerprint(profile)
    };
  }
}

class AzureTextProvider implements ProviderAdapter {
  constructor(private readonly apiKind: Exclude<ApiKind, 'fake'>, private readonly fetchImplementation: FetchImplementation | undefined) {}

  async *streamTurn(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    if (!this.fetchImplementation) throw new Error('Fetch is unavailable.');
    if (request.profile.apiKind !== this.apiKind) throw new Error('Profile API kind does not match this provider.');
    if (!request.credential?.trim()) throw new Error('A credential is required for this provider.');
    throwIfAborted(request.signal);

    const endpoint = normalizeEndpoint(request.profile.endpoint);
    const target = buildTarget(endpoint, this.apiKind, request.profile.deployment);
    const requestInit = requestFor(this.apiKind, request.profile, request.messages, request.credential, request.signal);
    const response = await this.fetchImplementation(target, requestInit);
    if (!response.ok) throw new Error(`Provider request failed with HTTP ${response.status}.`);
    if (!response.body) throw new Error('Provider returned no response stream.');

    let completed = false;
    let anthropicInputTokens: number | undefined;
    for await (const frame of readSse(response.body, request.signal)) {
      if (this.apiKind === 'anthropic') {
        const usage = anthropicUsageFrom(frame, anthropicInputTokens);
        if (usage.inputTokens !== undefined) anthropicInputTokens = usage.inputTokens;
        if (usage.event) yield usage.event;
      }
      const event = parseProviderFrame(this.apiKind, frame);
      if (!event) continue;
      if (this.apiKind === 'responses' && frame.event === 'response.completed' && event.type === 'usage') {
        yield event;
        completed = true;
        yield { type: 'done' };
        continue;
      }
      if (event.type === 'done') completed = true;
      yield event;
    }
    if (!completed) throw new Error('Provider stream ended before a completion signal.');
  }

  async probe(profile: ModelProfile, credential?: string): Promise<ProbeResult> {
    try {
      if (profile.apiKind !== this.apiKind) throw new Error('Profile API kind does not match this provider.');
      normalizeEndpoint(profile.endpoint);
      if (!profile.deployment.trim()) throw new Error('Deployment is required.');
      if (!credential?.trim()) throw new Error('A credential is required to probe this provider.');
      if (!this.fetchImplementation) throw new Error('Fetch is unavailable.');

      const probeProfile = { ...profile, outputLimit: Math.min(profile.outputLimit, 16) };
      const probeMessages: ProviderMessage[] = [{ role: 'user', content: 'Reply with exactly: OK' }];
      let sawText = false;
      let sawUsage = false;
      let sawDone = false;
      await withProbeDeadline('Probe completion stream timed out.', async signal => {
        for await (const event of this.streamTurn({ profile: probeProfile, messages: probeMessages, credential, signal })) {
          sawText ||= event.type === 'text' && event.text.length > 0;
          sawUsage ||= event.type === 'usage';
          sawDone ||= event.type === 'done';
        }
      });
      if (!sawText || !sawUsage || !sawDone) throw new Error('Probe stream did not provide text, usage, and completion.');

      // This checks local reader cancellation only; server work and billing may continue.
      await withProbeDeadline('Probe cancellation stream timed out.', async signal => {
        const cancellation = new AbortController();
        const onDeadline = () => cancellation.abort(signal.reason);
        signal.addEventListener('abort', onDeadline, { once: true });
        try {
          const iterator = this.streamTurn({ profile: probeProfile, messages: probeMessages, credential, signal: cancellation.signal })[Symbol.asyncIterator]();
          let receivedText = false;
          while (!receivedText) {
            const next = await iterator.next();
            if (next.done) throw new Error('Probe cancellation stream completed before text was received.');
            receivedText = next.value.type === 'text' && next.value.text.length > 0;
          }
          cancellation.abort();
          try {
            await iterator.next();
            throw new Error('Probe cancellation stream continued after abort.');
          } catch (error) {
            if (!isAbortError(error)) throw error;
          }
        } finally {
          signal.removeEventListener('abort', onDeadline);
        }
      });
      return {
        ok: true,
        capabilities: { streaming: true, tools: false, continuation: false, cancellation: true, usage: true },
        detail: 'Text streaming and reported usage were verified. Cancellation verifies the local client stream only; server-side cancellation and billing are not guaranteed.',
        fingerprint: profileFingerprint(profile)
      };
    } catch (error) {
      return {
        ok: false,
        capabilities: { streaming: false, tools: false, continuation: false, cancellation: false, usage: false },
        detail: error instanceof Error ? error.message : 'Invalid provider configuration.',
        fingerprint: safeFingerprint(profile)
      };
    }
  }
}

function requestFor(
  apiKind: Exclude<ApiKind, 'fake'>,
  profile: ModelProfile,
  messages: ProviderMessage[],
  credential: string,
  signal: AbortSignal
): RequestInit {
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'content-type': 'application/json'
  };
  let body: unknown;

  if (apiKind === 'responses') {
    headers['api-key'] = credential;
    body = {
      model: profile.deployment,
      input: messages.map((message) => ({ role: message.role, content: message.content })),
      stream: true,
      max_output_tokens: profile.outputLimit
    };
  } else if (apiKind === 'chat-completions') {
    headers['api-key'] = credential;
    body = {
      model: profile.deployment,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: profile.outputLimit
    };
  } else {
    headers['api-key'] = credential;
    headers['anthropic-version'] = '2023-06-01';
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    body = {
      model: profile.deployment,
      max_tokens: profile.outputLimit,
      stream: true,
      ...(system ? { system } : {}),
      messages: messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role, content: message.content }))
    };
  }

  return { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' };
}

function buildTarget(endpoint: URL, apiKind: Exclude<ApiKind, 'fake'>, deployment: string): URL {
  if (!deployment.trim()) throw new Error('Deployment is required.');
  const target = new URL(endpoint);
  if (apiKind === 'responses') target.pathname = '/openai/v1/responses';
  else if (apiKind === 'chat-completions') target.pathname = '/openai/v1/chat/completions';
  else target.pathname = '/anthropic/v1/messages';
  target.search = '';
  // Defense in depth: changing endpoint parsing must never send credentials elsewhere.
  if (target.origin !== endpoint.origin || target.username || target.password || target.hash) throw new Error('Provider target is outside the configured Azure endpoint.');
  return target;
}

function normalizeEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('Endpoint must be a valid HTTPS Azure URL.');
  }
  const hostname = endpoint.hostname.toLowerCase();
  const knownAzureHost = AZURE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length);
  if (endpoint.protocol !== 'https:' || !knownAzureHost || endpoint.port && endpoint.port !== '443' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('Endpoint must be an HTTPS Azure resource URL without path, credentials, query, or fragment.');
  }
  endpoint.hostname = hostname;
  return endpoint;
}

async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  let frames = 0;
  const cancelReader = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      throwIfAborted(signal);
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_SSE_STREAM_BYTES) throw new Error('Provider stream exceeded the configured byte limit.');
      buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BYTES) throw new Error('Provider event exceeded the configured byte limit.');
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        frames += 1;
        if (frames > MAX_SSE_EVENTS) throw new Error('Provider stream exceeded the configured event limit.');
        const frame = parseSseFrame(raw);
        if (frame) yield frame;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    await reader.cancel(signal.reason).catch(() => undefined);
    reader.releaseLock();
  }
}

function parseSseFrame(raw: string): SseFrame | undefined {
  if (!raw || raw.startsWith(':')) return undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join('\n') } : undefined;
}

function parseProviderFrame(apiKind: Exclude<ApiKind, 'fake'>, frame: SseFrame): ProviderEvent | undefined {
  if (apiKind === 'chat-completions' && frame.data === '[DONE]') return { type: 'done' };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(frame.data) as Record<string, unknown>;
  } catch {
    throw new Error('Provider sent malformed SSE JSON.');
  }
  rejectUnsupportedTextEvent(apiKind, frame.event, payload);
  if (apiKind === 'responses') return parseResponsesFrame(frame.event, payload);
  if (apiKind === 'chat-completions') return parseChatFrame(payload);
  return parseAnthropicFrame(frame.event, payload);
}

function parseResponsesFrame(eventName: string | undefined, payload: Record<string, unknown>): ProviderEvent | undefined {
  if (eventName === 'response.output_text.delta' && typeof payload.delta === 'string') return { type: 'text', text: payload.delta };
  if (eventName === 'response.completed') return usageFrom(payload.response) ?? { type: 'done' };
  if (eventName === 'response.failed' || eventName === 'error') throw new Error('Responses provider reported a stream error.');
  return undefined;
}

function parseChatFrame(payload: Record<string, unknown>): ProviderEvent | undefined {
  if (payload.error) throw new Error('Chat Completions provider reported a stream error.');
  const choices = payload.choices;
  if (Array.isArray(choices)) {
    const delta = choices[0] as { delta?: { content?: unknown } } | undefined;
    if (typeof delta?.delta?.content === 'string') return { type: 'text', text: delta.delta.content };
  }
  return usageFrom(payload);
}

function rejectUnsupportedTextEvent(apiKind: Exclude<ApiKind, 'fake'>, eventName: string | undefined, payload: Record<string, unknown>): void {
  if (apiKind === 'responses') {
    if (eventName?.includes('refusal') || containsUnsupportedTextContent(payload)) throw new Error('Provider requested an unsupported tool or refusal response.');
    return;
  }
  if (apiKind === 'chat-completions') {
    const choices = payload.choices;
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const item = choice as { delta?: { tool_calls?: unknown; function_call?: unknown; refusal?: unknown }; finish_reason?: unknown };
      if (item.delta?.tool_calls || item.delta?.function_call || item.delta?.refusal || item.finish_reason === 'tool_calls' || item.finish_reason === 'content_filter') {
        throw new Error('Provider requested an unsupported tool, refusal, or filtered response.');
      }
    }
    return;
  }
  const block = payload.content_block as { type?: unknown } | undefined;
  const delta = payload.delta as { stop_reason?: unknown } | undefined;
  if (block?.type === 'tool_use' || delta?.stop_reason === 'tool_use' || containsUnsupportedTextContent(payload)) {
    throw new Error('Provider requested an unsupported tool or refusal response.');
  }
}

function containsUnsupportedTextContent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsUnsupportedTextContent);
  const record = value as Record<string, unknown>;
  if (record.type === 'function_call' || record.type === 'tool_call' || record.type === 'tool_use' || record.type === 'refusal') return true;
  if (record.refusal) return true;
  return Object.values(record).some(containsUnsupportedTextContent);
}

function parseAnthropicFrame(eventName: string | undefined, payload: Record<string, unknown>): ProviderEvent | undefined {
  if (eventName === 'content_block_delta') {
    const delta = payload.delta as { type?: unknown; text?: unknown } | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') return { type: 'text', text: delta.text };
  }
  if (eventName === 'message_stop') return { type: 'done' };
  if (eventName === 'error') throw new Error('Anthropic provider reported a stream error.');
  return undefined;
}

function anthropicUsageFrom(frame: SseFrame, inputTokens: number | undefined): { inputTokens?: number; event?: Extract<ProviderEvent, { type: 'usage' }> } {
  if (frame.event !== 'message_start' && frame.event !== 'message_delta') return {};
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(frame.data) as Record<string, unknown>;
  } catch {
    throw new Error('Provider sent malformed SSE JSON.');
  }
  if (frame.event === 'message_start') {
    const message = payload.message as { usage?: { input_tokens?: unknown } } | undefined;
    return typeof message?.usage?.input_tokens === 'number' ? { inputTokens: message.usage.input_tokens } : {};
  }
  const usage = payload.usage as { output_tokens?: unknown } | undefined;
  return inputTokens !== undefined && typeof usage?.output_tokens === 'number'
    ? { event: { type: 'usage', inputTokens, outputTokens: usage.output_tokens } }
    : {};
}

function usageFrom(value: unknown): Extract<ProviderEvent, { type: 'usage' }> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = 'usage' in value ? value.usage : value;
  if (!usage || typeof usage !== 'object') return undefined;
  const input = 'input_tokens' in usage ? usage.input_tokens : 'prompt_tokens' in usage ? usage.prompt_tokens : undefined;
  const output = 'output_tokens' in usage ? usage.output_tokens : 'completion_tokens' in usage ? usage.completion_tokens : undefined;
  return typeof input === 'number' && Number.isFinite(input) && typeof output === 'number' && Number.isFinite(output)
    ? { type: 'usage', inputTokens: input, outputTokens: output }
    : undefined;
}

function lastUserMessage(messages: ProviderMessage[]): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

function splitDeterministically(value: string, size: number): string[] {
  return Array.from({ length: Math.ceil(value.length / size) }, (_, index) => value.slice(index * size, (index + 1) * size));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}

function yieldToEventLoop(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 0);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function withProbeDeadline<T>(message: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), 20_000);
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function safeFingerprint(profile: ModelProfile): string {
  try {
    return profileFingerprint(profile);
  } catch {
    return createHash('sha256').update(`${profile.apiKind}\u0000${profile.endpoint}\u0000${profile.deployment}`).digest('hex');
  }
}
