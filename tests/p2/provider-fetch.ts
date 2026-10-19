import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { createProvider, ProviderHttpError } from '../../packages/providers/src/index';
import type { ApiKind, ModelProfile, ProviderContinuation, ProviderEvent, ProviderMessage, ProviderToolResult, ToolDefinition } from '../../packages/protocol/src/index';

// The recording fetch the P2.4 provider oracles drive the shipping createProvider(kind, { fetch }) through. Each request's
// response stream returns exactly the listed chunks, one per read; then it closes, fails as undici fails on a lost
// connection ("terminated"), or waits. The C# replays (ProviderTransportTests, ProviderStreamTests) answer with the same
// chunks. The credential is generated per run and recorded as {credential}.
export const credential = ['fixture', randomBytes(12).toString('hex')].join('-');
export type Chunk = string | { bytes: number[] } | { text: string; times: number };
export type Body = Array<Chunk | { chunk: Chunk; count: number }>;
export interface Response { status?: number; headers?: [string, string][]; body?: Body | null; end?: 'close' | 'hang' | 'terminated' }
export interface Input {
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
  response?: Response;
}
export interface Outcome { requests: unknown[]; events: ProviderEvent[]; error: Record<string, unknown> | null }

export function encode(body: Body): Uint8Array[] {
  const encoder = new TextEncoder();
  const one = (chunk: Chunk): Uint8Array => typeof chunk === 'string' ? encoder.encode(chunk) : 'bytes' in chunk ? Uint8Array.from(chunk.bytes) : encoder.encode(chunk.text.repeat(chunk.times));
  return body.flatMap(item => typeof item === 'object' && 'chunk' in item ? Array.from({ length: item.count }, () => one(item.chunk)) : [one(item)]);
}
export const scrub = (value: string): string => value.split(credential).join('{credential}');
export const base = (kind: ApiKind): ModelProfile => ({ id: '0c46787b-9dce-4a8d-a8aa-6fe7f8a44d53', name: 'Transport', apiKind: kind, endpoint: 'https://sample.openai.azure.com', deployment: 'test-model', contextLimit: 4096, outputLimit: 256 });

/** Streams one input through the shipping adapter and records each request, every event and the error. */
export async function run(input: Input): Promise<Outcome> {
  vi.restoreAllMocks();
  if (input.now !== undefined) vi.spyOn(Date, 'now').mockReturnValue(input.now);
  const requests: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const headers = init?.headers as Record<string, string>;
    requests.push({ url: String(url), method: init?.method, headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, scrub(value)])), body: scrub(String(init?.body)), redirect: init?.redirect });
    if (input.fetchRejects) throw new TypeError('fetch failed');
    const response = input.response ?? {};
    const chunks = response.body === null ? null : encode(response.body ?? []);
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
    return new globalThis.Response(stream, { status: response.status ?? 200, headers: response.headers ?? [] });
  });
  const controller = new AbortController(); if (input.abortBefore) controller.abort();
  const profile = { ...base(input.kind), ...input.profile } as ModelProfile;
  const events: ProviderEvent[] = []; let error: Record<string, unknown> | null = null;
  try {
    const request = { profile, messages: input.messages ?? [{ role: 'user' as const, content: 'hello' }], signal: controller.signal, ...(input.credential === null ? {} : { credential: input.credential ?? credential }),
      ...(input.tools ? { tools: input.tools } : {}), ...(input.continuation ? { continuation: input.continuation } : {}), ...(input.toolResults ? { toolResults: input.toolResults } : {}) };
    for await (const event of createProvider(input.provider ?? input.kind, { fetch }).streamTurn(request)) {
      events.push(event);
      if (events.length === input.abortAfterEvents) controller.abort();
    }
  } catch (caught) {
    if (!(caught instanceof Error)) throw caught;
    error = { name: caught.name, message: scrub(caught.message), ...(caught instanceof ProviderHttpError ? { status: caught.status, retryAfterSeconds: caught.retryAfterSeconds ?? null } : {}) };
  }
  return { requests, events, error };
}

/** The input as a vector records it: the run's credential as {credential}. */
export const recorded = (input: Input): Input => ({ ...input, credential: input.credential === undefined ? '{credential}' : input.credential });
