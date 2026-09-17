import { createHash, randomUUID } from "node:crypto";
import type { ApiKind, ModelProfile, ProbeResult, ProviderAdapter, ProviderContinuation, ProviderEvent, ProviderMessage, ProviderRequest, ProviderToolResult, ToolCall, ToolDefinition } from "../../protocol/src/index.js";
import { isOrchestrationRequest, orchestrationFixture } from "./orchestration-fixture.js";
/** A definite HTTP rejection before any response stream was accepted. Retry-After is bounded and advisory only; nothing retries automatically. */
export class ProviderHttpError extends Error {
    constructor(readonly status: number, readonly retryAfterSeconds: number | undefined) { super(`Provider request failed with HTTP ${status}.`); this.name = "ProviderHttpError"; }
}
function retryAfter(value: string | null): number | undefined { if (!value) return undefined; const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds)); const date = Date.parse(value); return Number.isNaN(date) ? undefined : Math.min(3600, Math.max(0, Math.ceil((date - Date.now()) / 1000))); }
const MAX_SSE_EVENT_BYTES = 1024 * 1024, MAX_SSE_STREAM_BYTES = 8 * 1024 * 1024, MAX_SSE_EVENTS = 10000;
const AZURE_HOST_SUFFIXES = [".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com", ".inference.ai.azure.com"] as const;
type FetchImplementation = typeof fetch;
export interface ProviderOptions {
    fetch?: FetchImplementation;
}
interface SseFrame {
    event?: string;
    data: string;
}
export function createProvider(apiKind: ApiKind, options: ProviderOptions = {}): ProviderAdapter { return apiKind === "fake" ? new FakeProvider() : new AzureProvider(apiKind, options.fetch ?? globalThis.fetch); }
export function profileFingerprint(profile: ModelProfile): string { return createHash("sha256").update(JSON.stringify({ apiKind: profile.apiKind, endpoint: profile.apiKind === "fake" ? profile.endpoint : normalizeEndpoint(profile.endpoint).toString(), deployment: profile.deployment, contextLimit: profile.contextLimit, outputLimit: profile.outputLimit })).digest("hex"); }
class FakeProvider implements ProviderAdapter {
    async *streamTurn(request: ProviderRequest): AsyncIterable<ProviderEvent> {
        if (isOrchestrationRequest(request)) { yield* orchestrationFixture(request); return; }
        const state = fakeState(request.continuation);
        throwIfAborted(request.signal);
        if (!state && request.tools?.length && lastUser(request.messages).startsWith("/demo")) {
            requireTools(request.tools, ["read_file", "replace_text", "run_command"]);
            const call = { id: "fake-read-1", name: "read_file", arguments: { path: "README.md" } };
            yield { type: "tool_call", call };
            yield { type: "done", continuation: fakeContinuation("read", [call]) };
            return;
        }
        if (state?.stage === "read") {
            const result = requiredResults(request, state.calls)[0]!;
            const read = parseToolContent(result, "read_file");
            if (result.isError || !isRecord(read) || typeof read.path !== "string" || typeof read.content !== "string" || typeof read.hash !== "string") {
                yield* fakeText("Offline demo stopped: read_file failed or returned invalid content.", request.signal);
                yield { type: "done", continuation: fakeContinuation("complete", []) };
                return;
            }
            const call = { id: "fake-replace-1", name: "replace_text", arguments: { path: read.path, expectedHash: read.hash, oldText: read.content, newText: `${read.content}\nFoundry offline demo completed.\n` } };
            yield { type: "tool_call", call };
            yield { type: "done", continuation: fakeContinuation("replace", [call]) };
            return;
        }
        if (state?.stage === "replace") {
            const result = requiredResults(request, state.calls)[0]!;
            if (result.isError) {
                yield* fakeText("Offline demo stopped: replace_text was rejected or failed.", request.signal);
                yield { type: "done", continuation: fakeContinuation("complete", []) };
                return;
            }
            const call = { id: "fake-command-1", name: "run_command", arguments: { command: "Write-Output 'Foundry command demo completed'", cwd: "", environment: {}, timeoutMs: 10000 } };
            yield { type: "tool_call", call };
            yield { type: "done", continuation: fakeContinuation("command", [call]) };
            return;
        }
        if (state?.stage === "command") {
            const result = requiredResults(request, state.calls)[0]!;
            yield* fakeText(result.isError ? "Offline demo completed with a command error." : "Foundry offline demo completed.", request.signal);
            yield { type: "done", continuation: fakeContinuation("complete", []) };
            return;
        }
        if (state && state.stage !== "complete" && state.stage !== "chat")
            throw new Error("Invalid fake continuation.");
        yield* fakeText(`Fake response: ${lastUser(request.messages) || "No user message."}`, request.signal);
        yield { type: "done", continuation: fakeContinuation("chat", []) };
    }
    async probe(profile: ModelProfile): Promise<ProbeResult> { return { ok: profile.apiKind === "fake", capabilities: { streaming: true, tools: true, continuation: true, cancellation: true, usage: false }, detail: profile.apiKind === "fake" ? "Offline deterministic text, tools, and continuation are available." : "Profile API kind does not match this provider.", fingerprint: profileFingerprint(profile) }; }
}
class AzureProvider implements ProviderAdapter {
    constructor(private readonly apiKind: Exclude<ApiKind, "fake">, private readonly fetchImplementation: FetchImplementation | undefined) { }
    async *streamTurn(request: ProviderRequest): AsyncIterable<ProviderEvent> {
        if (!this.fetchImplementation)
            throw new Error("Fetch is unavailable.");
        if (request.profile.apiKind !== this.apiKind)
            throw new Error("Profile API kind does not match this provider.");
        if (!request.credential?.trim())
            throw new Error("A credential is required for this provider.");
        throwIfAborted(request.signal);
        const prepared = nativeRequest(this.apiKind, request);
        const response = await this.fetchImplementation(buildTarget(normalizeEndpoint(request.profile.endpoint), this.apiKind), { method: "POST", headers: headersFor(this.apiKind, request.credential), body: JSON.stringify(prepared.body), signal: request.signal, redirect: "error" });
        if (!response.ok)
            throw new ProviderHttpError(response.status, response.status === 429 ? retryAfter(response.headers.get("retry-after")) : undefined);
        if (!response.body)
            throw new Error("Provider returned no response stream.");
        if (this.apiKind === "responses")
            yield* streamResponses(response.body, request.signal, prepared);
        else if (this.apiKind === "chat-completions")
            yield* streamChat(response.body, request.signal, prepared);
        else
            yield* streamAnthropic(response.body, request.signal, prepared);
    }
    async probe(profile: ModelProfile, credential?: string): Promise<ProbeResult> {
        try {
            if (profile.apiKind !== this.apiKind || !credential?.trim())
                throw new Error("A matching profile and credential are required to probe this provider.");
            normalizeEndpoint(profile.endpoint);
            const small = { ...profile, outputLimit: 256 };
            const base = { profile: small, credential, messages: [{ role: "user" as const, content: "Reply with exactly: OK" }] };
            const text = await withDeadline("Probe text stream timed out.", signal => this.streamTurn({ ...base, signal }));
            if (!text.some(e => e.type === "text") || !text.some(e => e.type === "usage") || !text.some(e => e.type === "done"))
                throw new Error("Probe text stream was incomplete.");
            await verifyCancellation(signal => this.streamTurn({ ...base, signal }));
            const token = randomUUID();
            const fixture: ToolDefinition = { name: "fixture_tool", description: "Probe-only fixture.", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
            const toolStart = await withDeadline("Probe tool stream timed out.", signal => this.streamTurn({ ...base, signal, tools: [fixture], messages: [{ role: "user", content: "Call fixture_tool with an empty object, then reply exactly with the token it returns." }] }));
            const call = toolStart.find((e): e is Extract<ProviderEvent, {
                type: "tool_call";
            }> => e.type === "tool_call")?.call;
            const continuation = toolStart.find((e): e is Extract<ProviderEvent, {
                type: "done";
            }> => e.type === "done")?.continuation;
            if (!call || !continuation || call.name !== fixture.name)
                throw new Error("Probe tool stream did not return a completed tool call.");
            const end = await withDeadline("Probe continuation stream timed out.", signal => this.streamTurn({ profile: small, credential, signal, messages: [], tools: [fixture], continuation, toolResults: [{ id: call.id, name: call.name, content: JSON.stringify({ ok: true, token }), isError: false }] }));
            if (!end.some(e => e.type === "done") || end.some(e => e.type === "tool_call") || !end.filter((e): e is Extract<ProviderEvent, { type: "text" }> => e.type === "text").map(e => e.text).join("").includes(token))
                throw new Error("Probe tool continuation was incomplete.");
            return { ok: true, capabilities: { streaming: true, tools: true, continuation: true, cancellation: true, usage: true }, detail: "Text, usage, tool continuation, and local client cancellation were verified. Server cancellation and billing are not guaranteed.", fingerprint: profileFingerprint(profile) };
        }
        catch (error) {
            return { ok: false, capabilities: { streaming: false, tools: false, continuation: false, cancellation: false, usage: false }, detail: error instanceof Error ? error.message : "Invalid provider configuration.", fingerprint: safeFingerprint(profile) };
        }
    }
}
interface Prepared {
    body: Record<string, unknown>;
    state: Record<string, unknown>;
    calls: ToolCall[];
    tools: ToolDefinition[];
}
function nativeRequest(kind: Exclude<ApiKind, "fake">, request: ProviderRequest): Prepared {
    const data = request.continuation ? continuationData(kind, request.continuation) : undefined;
    const tools = request.tools ?? [];
    if (kind === "responses") {
        const input = data ? array(data.input).slice() : request.messages.map(message => ({ role: message.role, content: message.content }));
        const calls = data ? callsFrom(data.calls) : [];
        if (data)
            input.push(...responseResults(request, calls), ...request.messages.map(message => ({ role: message.role, content: message.content })));
        return { body: { model: request.profile.deployment, input, stream: true, store: false, include: ["reasoning.encrypted_content"], max_output_tokens: request.profile.outputLimit, ...(tools.length ? { tools: tools.map(responseTool) } : {}) }, state: { input }, calls, tools };
    }
    if (kind === "chat-completions") {
        const messages = data ? array(data.messages).slice() : request.messages.map(message => ({ role: message.role, content: message.content }));
        const calls = data ? callsFrom(data.calls) : [];
        if (data)
            messages.push(...chatResults(request, calls), ...request.messages.map(message => ({ role: message.role, content: message.content })));
        return { body: { model: request.profile.deployment, messages, stream: true, stream_options: { include_usage: true }, max_completion_tokens: request.profile.outputLimit, ...(tools.length ? { tools: tools.map(chatTool) } : {}) }, state: { messages }, calls, tools };
    }
    const state = data ?? { messages: request.messages.filter(message => message.role !== "system").map(message => ({ role: message.role, content: message.content })), system: request.messages.filter(message => message.role === "system").map(message => message.content).join("\n\n"), calls: [] };
    const messages = array(state.messages).slice();
    const calls = callsFrom(state.calls);
        if (data) {
            const nextMessages = request.messages.filter(message => message.role !== "system");
            const results = anthropicResults(request, calls);
            if (results.length && nextMessages.length === 1 && nextMessages[0]?.role === "user") {
                const toolResultContent = (results[0] as { content: unknown[] }).content;
                messages.push({ role: "user", content: [...toolResultContent, { type: "text", text: nextMessages[0].content }] });
            }
            else messages.push(...results, ...nextMessages.map(message => ({ role: message.role, content: message.content })));
        }
    return { body: { model: request.profile.deployment, messages, stream: true, max_tokens: request.profile.outputLimit, ...(typeof state.system === "string" && state.system ? { system: state.system } : {}), ...(tools.length ? { tools: tools.map(anthropicTool) } : {}) }, state: { messages, system: state.system }, calls, tools };
}
async function* streamResponses(body: ReadableStream<Uint8Array>, signal: AbortSignal, prepared: Prepared): AsyncIterable<ProviderEvent> {
    const streamedItems: Record<string, unknown>[] = [];
    let completed = false;
    let sawText = false;
    let completedOutput: Record<string, unknown>[] | undefined;
    for await (const frame of readSse(body, signal)) {
        const payload = json(frame);
        const type = eventType(frame, payload);
        if (completed)
            throw new Error("Responses provider sent content after completion.");
        if (type === "response.output_text.delta") {
            if (typeof payload.delta !== "string")
                throw new Error("Invalid Responses text delta.");
            sawText = true;
            yield { type: "text", text: payload.delta };
        }
        else if (type === "response.output_item.done") {
            if (!isRecord(payload.item))
                throw new Error("Invalid Responses output item.");
            if (containsUnsupported(payload.item))
                throw new Error("Responses provider returned unsupported content.");
            streamedItems.push(payload.item);
        }
        else if (type === "response.completed") {
            const response = isRecord(payload.response) ? payload.response : {};
            if (response.status !== "completed" || response.incomplete_details)
                throw new Error("Responses completion was incomplete.");
            if (containsUnsupported(response))
                throw new Error("Responses provider returned unsupported content.");
            if (response.output !== undefined) {
                if (!Array.isArray(response.output) || !response.output.every(isRecord))
                    throw new Error("Responses completion output was invalid.");
                completedOutput = response.output;
                validateResponseCompletion(streamedItems, completedOutput);
            }
            else if (sawText || streamedItems.length) {
                if (sawText || !streamedItems.length)
                    throw new Error("Responses completion omitted authoritative output items.");
            }
            const usage = usageFrom(response);
            if (usage)
                yield usage;
            completed = true;
        }
        else if (type === "response.failed" || type === "error" || type?.includes("refusal") || containsUnsupported(payload))
            throw new Error("Responses provider returned unsupported or failed content.");
    }
    if (!completed)
        throw new Error("Provider stream ended before a completion signal.");
    const output = completedOutput ?? streamedItems;
    if (containsUnsupported(output))
        throw new Error("Responses provider returned unsupported content.");
    const calls = output.filter(item => item.type === "function_call").map(responseCall);
    validateCalls(calls, prepared);
    for (const call of calls)
        yield { type: "tool_call", call };
    yield { type: "done", continuation: { apiKind: "responses", data: { input: [...array(prepared.state.input), ...output], calls } } };
}
async function* streamChat(body: ReadableStream<Uint8Array>, signal: AbortSignal, prepared: Prepared): AsyncIterable<ProviderEvent> {
    const parts = new Map<number, {
        id?: string;
        name?: string;
        arguments: string;
    }>();
    let content = "", done = false, terminal: "stop" | "tool_calls" | undefined;
    let usage: Extract<ProviderEvent, {
        type: "usage";
    }> | undefined;
    for await (const frame of readSse(body, signal)) {
        if (frame.data === "[DONE]") {
            if (done)
                throw new Error("Chat Completions provider sent duplicate [DONE].");
            done = true;
            continue;
        }
        if (done)
            throw new Error("Chat Completions provider sent data after [DONE].");
        const payload = json(frame);
        eventType(frame, payload);
        if (payload.error)
            throw new Error("Chat Completions provider reported an error.");
        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        for (const choice of choices) {
            if (!isRecord(choice))
                continue;
            const delta = isRecord(choice.delta) ? choice.delta : {};
            if (terminal && (typeof delta.content === "string" || Array.isArray(delta.tool_calls) || choice.finish_reason !== null && choice.finish_reason !== undefined))
                throw new Error("Chat Completions provider sent content after its terminal finish reason.");
            if (typeof delta.content === "string") {
                content += delta.content;
                yield { type: "text", text: delta.content };
            }
            if (delta.refusal || delta.function_call)
                throw new Error("Chat Completions returned unsupported content.");
            if (Array.isArray(delta.tool_calls))
                for (const part of delta.tool_calls)
                    addChatPart(parts, part);
            if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
                if (terminal)
                    throw new Error("Chat completion reported a repeated terminal finish reason.");
                terminal = choice.finish_reason;
            }
            else if (choice.finish_reason)
                throw new Error(`Chat completion ended with ${String(choice.finish_reason)}.`);
        }
        usage = usageFrom(payload) ?? usage;
    }
    if (!done)
        throw new Error("Provider stream ended before [DONE].");
    if (!terminal)
        throw new Error("Chat completion ended without a terminal finish reason.");
    const calls = [...parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => chatCall(part));
    if ((terminal === "tool_calls") !== Boolean(calls.length))
        throw new Error("Chat completion tool-call finish state was inconsistent.");
    if (usage)
        yield usage;
    validateCalls(calls, prepared);
    for (const call of calls)
        yield { type: "tool_call", call };
    const assistant: Record<string, unknown> = { role: "assistant", content: content || null };
    if (calls.length)
        assistant.tool_calls = calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
    yield { type: "done", continuation: { apiKind: "chat-completions", data: { messages: [...array(prepared.state.messages), assistant], calls } } };
}
async function* streamAnthropic(body: ReadableStream<Uint8Array>, signal: AbortSignal, prepared: Prepared): AsyncIterable<ProviderEvent> {
    const blocks = new Map<number, Record<string, unknown>>();
    const stopped = new Set<number>();
    let input: number | undefined;
    let cacheCreation = 0;
    let cacheRead = 0;
    let usage: Extract<ProviderEvent, {
        type: "usage";
    }> | undefined, done = false, stopReason: "end_turn" | "tool_use" | undefined;
    for await (const frame of readSse(body, signal)) {
        const payload = json(frame);
        const type = eventType(frame, payload);
        if (done && type !== "ping")
            throw new Error("Anthropic provider sent content after message_stop.");
        if (type === "message_start") {
            const msg = isRecord(payload.message) ? payload.message : {};
            const messageUsage = isRecord(msg.usage) ? msg.usage : undefined;
            const value = messageUsage?.input_tokens;
            if (validUsageInteger(value))
                input = value;
            if (validUsageInteger(messageUsage?.cache_creation_input_tokens))
                cacheCreation = messageUsage.cache_creation_input_tokens;
            if (validUsageInteger(messageUsage?.cache_read_input_tokens))
                cacheRead = messageUsage.cache_read_input_tokens;
        }
        else if (type === "content_block_start") {
            if (!Number.isInteger(payload.index) || !isRecord(payload.content_block))
                throw new Error("Invalid Anthropic content block.");
            const index = payload.index as number;
            if (blocks.has(index))
                throw new Error("Duplicate Anthropic content block.");
            blocks.set(index, { ...payload.content_block });
        }
        else if (type === "content_block_delta") {
            const text = applyAnthropicDelta(blocks, payload);
            if (text)
                yield { type: "text", text };
        }
        else if (type === "message_delta") {
            const delta = isRecord(payload.delta) ? payload.delta : {};
            if (delta.stop_reason !== "end_turn" && delta.stop_reason !== "tool_use")
                throw new Error(`Anthropic completion ended with ${String(delta.stop_reason)}.`);
            stopReason = delta.stop_reason;
            const messageUsage = isRecord(payload.usage) ? payload.usage : undefined;
            const out = messageUsage?.output_tokens;
            const outputCacheCreation = messageUsage?.cache_creation_input_tokens ?? cacheCreation;
            const outputCacheRead = messageUsage?.cache_read_input_tokens ?? cacheRead;
            if (validUsageInteger(input) && validUsageInteger(out) && validUsageInteger(outputCacheCreation) && validUsageInteger(outputCacheRead)) {
                const totalInput = input + outputCacheCreation + outputCacheRead;
                if (!Number.isSafeInteger(totalInput))
                    throw new Error("Anthropic usage exceeded the supported range.");
                usage = { type: "usage", inputTokens: totalInput, outputTokens: out };
            }
        }
        else if (type === "content_block_stop") {
            if (!Number.isInteger(payload.index) || !blocks.has(payload.index as number) || stopped.has(payload.index as number))
                throw new Error("Invalid Anthropic content block stop.");
            stopped.add(payload.index as number);
        }
        else if (type === "message_stop")
            done = true;
        else if (type === "error")
            throw new Error("Anthropic provider reported an error.");
    }
    if (!done)
        throw new Error("Provider stream ended before message_stop.");
    if (!stopReason)
        throw new Error("Anthropic completion ended without a stop reason.");
    if (stopped.size !== blocks.size)
        throw new Error("Anthropic completion ended before all content blocks stopped.");
    if (usage)
        yield usage;
    const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => finalizeAnthropic(block));
    const calls = content.filter(block => block.type === "tool_use").map(block => ({ id: String(block.id), name: String(block.name), arguments: block.input }));
    if ((stopReason === "tool_use") !== Boolean(calls.length))
        throw new Error("Anthropic tool-call stop state was inconsistent.");
    validateCalls(calls, prepared);
    for (const call of calls)
        yield { type: "tool_call", call };
    yield { type: "done", continuation: { apiKind: "anthropic", data: { messages: [...array(prepared.state.messages), { role: "assistant", content }], system: prepared.state.system, calls } } };
}
function applyAnthropicDelta(
    blocks: Map<number, Record<string, unknown>>,
    payload: Record<string, unknown>,
): string | undefined {
    const block = blocks.get(payload.index as number);
    const delta = isRecord(payload.delta) ? payload.delta : undefined;
    if (!block || !delta)
        throw new Error("Invalid Anthropic content delta.");

    if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
        return delta.text;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
        return undefined;
    }
    if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        block.signature = delta.signature;
        return undefined;
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        block.__json = `${typeof block.__json === "string" ? block.__json : ""}${delta.partial_json}`;
        return undefined;
    }
    throw new Error("Invalid Anthropic content delta.");
}
function responseTool(tool: ToolDefinition): Record<string, unknown> { return { type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }; }
function chatTool(tool: ToolDefinition): Record<string, unknown> { return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false } }; }
function anthropicTool(tool: ToolDefinition): Record<string, unknown> { return { name: tool.name, description: tool.description, input_schema: tool.inputSchema }; }
function headersFor(kind: Exclude<ApiKind, "fake">, credential: string): Record<string, string> { return { accept: "text/event-stream", "content-type": "application/json", "api-key": credential, ...(kind === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}) }; }
function buildTarget(endpoint: URL, kind: Exclude<ApiKind, "fake">): URL { const target = new URL(endpoint); target.pathname = kind === "responses" ? "/openai/v1/responses" : kind === "chat-completions" ? "/openai/v1/chat/completions" : "/anthropic/v1/messages"; return target; }
function normalizeEndpoint(value: string): URL { let endpoint: URL; try {
    endpoint = new URL(value);
}
catch {
    throw new Error("Endpoint must be a valid HTTPS Azure URL.");
} const host = endpoint.hostname.toLowerCase(); if (endpoint.protocol !== "https:" || !AZURE_HOST_SUFFIXES.some(s => host.endsWith(s) && host.length > s.length) || endpoint.port && endpoint.port !== "443" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/")
    throw new Error("Endpoint must be an HTTPS Azure resource URL without path, credentials, query, or fragment."); endpoint.hostname = host; return endpoint; }
function continuationData(kind: Exclude<ApiKind, "fake">, continuation: ProviderContinuation): Record<string, unknown> { if (continuation.apiKind !== kind || !isRecord(continuation.data))
    throw new Error("Continuation belongs to a different or invalid provider."); return continuation.data; }
function responseResults(request: ProviderRequest, calls: ToolCall[]): unknown[] { return requiredResults(request, calls).map(result => ({ type: "function_call_output", call_id: result.id, output: result.content })); }
function chatResults(request: ProviderRequest, calls: ToolCall[]): unknown[] { return requiredResults(request, calls).map(result => ({ role: "tool", tool_call_id: result.id, content: result.content })); }
function anthropicResults(request: ProviderRequest, calls: ToolCall[]): unknown[] { return requiredResults(request, calls).map(result => ({ role: "user", content: [{ type: "tool_result", tool_use_id: result.id, content: result.content, is_error: result.isError }] })); }
function requiredResults(request: ProviderRequest, calls: ToolCall[]): ProviderToolResult[] { if (!calls.length) {
    if (request.toolResults?.length)
        throw new Error("Tool results were supplied without pending calls.");
    return [];
} if (!request.toolResults?.length)
    throw new Error("Pending tool calls require matching results."); const expected = new Map(calls.map(call => [call.id, call])); const seen = new Set<string>(); for (const result of request.toolResults) {
    const call = expected.get(result.id);
    if (!call || seen.has(result.id) || result.name !== call.name)
        throw new Error("Tool result does not match a pending call.");
    seen.add(result.id);
} if (seen.size !== expected.size)
    throw new Error("Missing tool result for a pending call."); return request.toolResults; }
function validateCalls(calls: ToolCall[], prepared: Prepared): void { const known = new Set(prepared.tools.map(tool => tool.name)); const ids = new Set<string>(); for (const call of calls) {
    if (!known.has(call.name))
        throw new Error(`Provider requested unadvertised tool ${call.name}.`);
    if (ids.has(call.id))
        throw new Error("Provider returned duplicate tool-call IDs.");
    ids.add(call.id);
} }
function requireTools(tools: ToolDefinition[] | undefined, names: string[]): void { const known = new Set(tools?.map(tool => tool.name)); for (const name of names)
    if (!known.has(name))
        throw new Error(`Tool ${name} was not advertised.`); }
function responseCall(item: Record<string, unknown>): ToolCall { if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string")
    throw new Error("Invalid Responses function call."); return { id: item.call_id, name: item.name, arguments: parseArguments(item.arguments) }; }
function validateResponseCompletion(streamed: Record<string, unknown>[], completed: Record<string, unknown>[]): void {
    for (const item of streamed) {
        if (!completed.some(candidate => matchingResponseItem(item, candidate)))
            throw new Error("Responses completion output did not match an output item event.");
    }
}
function matchingResponseItem(streamed: Record<string, unknown>, completed: Record<string, unknown>): boolean {
    if (streamed.type !== completed.type)
        return false;
    if (typeof streamed.id === "string" || typeof completed.id === "string") {
        if (streamed.id !== completed.id)
            return false;
    }
    if (streamed.type === "function_call") {
        return streamed.call_id === completed.call_id
            && streamed.name === completed.name
            && streamed.arguments === completed.arguments;
    }
    if ("content" in streamed || "content" in completed)
        return JSON.stringify(streamed.content) === JSON.stringify(completed.content);
    return true;
}
function chatCall(value: {
    id?: string;
    name?: string;
    arguments: string;
}): ToolCall { if (!value.id || !value.name)
    throw new Error("Incomplete chat tool call."); return { id: value.id, name: value.name, arguments: parseArguments(value.arguments) }; }
function addChatPart(parts: Map<number, {
    id?: string;
    name?: string;
    arguments: string;
}>, raw: unknown): void { if (!isRecord(raw) || !Number.isInteger(raw.index))
    throw new Error("Invalid chat tool-call delta."); const part = parts.get(raw.index as number) ?? { arguments: "" }; if (typeof raw.id === "string")
    part.id = raw.id; const fn = isRecord(raw.function) ? raw.function : {}; if (typeof fn.name === "string")
    part.name = fn.name; if (typeof fn.arguments === "string")
    part.arguments += fn.arguments; parts.set(raw.index as number, part); }
function parseArguments(value: string): unknown { try {
    return JSON.parse(value);
}
catch {
    throw new Error("Tool call arguments were not complete JSON.");
} }
function finalizeAnthropic(block: Record<string, unknown>): Record<string, unknown> { const output = { ...block }; if (typeof output.__json === "string") {
    output.input = parseArguments(output.__json);
    delete output.__json;
} if (output.type === "tool_use" && (typeof output.id !== "string" || !output.id || typeof output.name !== "string" || !output.name || !("input" in output)))
    throw new Error("Incomplete Anthropic tool call."); return output; }
function containsUnsupported(value: unknown): boolean { if (Array.isArray(value))
    return value.some(containsUnsupported); if (!isRecord(value))
    return false; return value.type === "refusal" || value.type === "computer_call" || Object.values(value).some(containsUnsupported); }
function json(frame: SseFrame): Record<string, unknown> { try {
    const value = JSON.parse(frame.data);
    if (!isRecord(value))
        throw new Error();
    return value;
}
catch {
    throw new Error("Provider sent malformed SSE JSON.");
} }
function eventType(frame: SseFrame, payload: Record<string, unknown>): string | undefined {
    const payloadType = typeof payload.type === "string" ? payload.type : undefined;
    if (frame.event && payloadType && frame.event !== payloadType)
        throw new Error("Provider SSE event type did not match its payload type.");
    return frame.event ?? payloadType;
}
function validUsageInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function usageFrom(value: unknown): Extract<ProviderEvent, {
    type: "usage";
}> | undefined {
    if (!isRecord(value))
        return undefined;
    const usage = isRecord(value.usage) ? value.usage : value;
    const input = usage.input_tokens ?? usage.prompt_tokens;
    const output = usage.output_tokens ?? usage.completion_tokens;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    if (!validUsageInteger(input) || !validUsageInteger(output) || !validUsageInteger(cacheCreation) || !validUsageInteger(cacheRead))
        return undefined;
    const totalInput = input + cacheCreation + cacheRead;
    return Number.isSafeInteger(totalInput) ? { type: "usage", inputTokens: totalInput, outputTokens: output } : undefined;
}
async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<SseFrame> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    let events = 0;
    const cancel = () => {
        void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
    while (true) {
        throwIfAborted(signal);
        const next = await reader.read();
        throwIfAborted(signal);
        if (next.done)
            break;
        bytes += next.value.byteLength;
        if (bytes > MAX_SSE_STREAM_BYTES)
            throw new Error("Provider stream exceeded the configured byte limit.");
        buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_EVENT_BYTES)
            throw new Error("Provider event exceeded the configured byte limit.");
        while (true) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0)
                break;
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (++events > MAX_SSE_EVENTS)
                throw new Error("Provider stream exceeded the configured event limit.");
            const frame = parseSse(raw);
            if (frame)
                yield frame;
        }
    }
    }
    finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel(signal.reason).catch(() => undefined);
        reader.releaseLock();
    }
}
function parseSse(raw: string): SseFrame | undefined {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of raw.split("\n")) {
        if (line.startsWith("event:"))
            event = line.slice(6).trim();
        else if (line.startsWith("data:"))
            data.push(line.slice(5).trimStart());
    }
    return data.length ? { event, data: data.join("\n") } : undefined;
}
function fakeState(continuation: ProviderContinuation | undefined): {
    stage: string;
    calls: ToolCall[];
} | undefined { if (!continuation)
    return undefined; if (continuation.apiKind !== "fake" || !isRecord(continuation.data) || typeof continuation.data.stage !== "string")
    throw new Error("Invalid fake continuation."); return { stage: continuation.data.stage, calls: callsFrom(continuation.data.calls) }; }
function fakeContinuation(stage: string, calls: ToolCall[]): ProviderContinuation { return { apiKind: "fake", data: { stage, calls } }; }
async function* fakeText(value: string, signal: AbortSignal): AsyncIterable<ProviderEvent> { for (const text of split(value, 12)) {
    throwIfAborted(signal);
    yield { type: "text", text };
    await yieldToEventLoop(signal);
} }
function split(value: string, size: number): string[] { return Array.from({ length: Math.ceil(value.length / size) }, (_, index) => value.slice(index * size, (index + 1) * size)); }
function lastUser(messages: ProviderMessage[]): string { return [...messages].reverse().find(message => message.role === "user")?.content ?? ""; }
function parseToolContent(result: ProviderToolResult, name: string): unknown { if (result.name !== name)
    throw new Error("Tool result name mismatch."); try {
    return JSON.parse(result.content);
}
catch {
    return undefined;
} }
function callsFrom(value: unknown): ToolCall[] { if (!Array.isArray(value))
    return []; return value.map(call => { if (!isRecord(call) || typeof call.id !== "string" || typeof call.name !== "string")
    throw new Error("Invalid continuation call."); return { id: call.id, name: call.name, arguments: call.arguments }; }); }
function array(value: unknown): unknown[] { if (!Array.isArray(value))
    throw new Error("Invalid continuation state."); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted)
    throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"); }
function yieldToEventLoop(signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 0); const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError")); }; signal.addEventListener("abort", abort, { once: true }); }); }
async function withDeadline(message: string, action: (signal: AbortSignal) => AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> { const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException(message, "AbortError")), 20000); try {
    const output: ProviderEvent[] = [];
    for await (const event of action(controller.signal))
        output.push(event);
    return output;
}
finally {
    clearTimeout(timer);
} }
async function verifyCancellation(create: (signal: AbortSignal) => AsyncIterable<ProviderEvent>): Promise<void> { const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new DOMException("Probe cancellation stream timed out.", "AbortError")), 20000); try {
    const cancellation = new AbortController();
    deadline.signal.addEventListener("abort", () => cancellation.abort(deadline.signal.reason), { once: true });
    const iterator = create(cancellation.signal)[Symbol.asyncIterator]();
    while (true) {
        const next = await iterator.next();
        if (next.done)
            throw new Error("Probe cancellation stream completed before text.");
        if (next.value.type === "text")
            break;
    }
    cancellation.abort();
    try {
        await iterator.next();
        throw new Error("Probe cancellation stream continued after abort.");
    }
    catch (error) {
        if (!(error instanceof Error && error.name === "AbortError"))
            throw error;
    }
}
finally {
    clearTimeout(timer);
} }
function safeFingerprint(profile: ModelProfile): string { try {
    return profileFingerprint(profile);
}
catch {
    return createHash("sha256").update(`${profile.apiKind}\0${profile.endpoint}\0${profile.deployment}`).digest("hex");
} }
