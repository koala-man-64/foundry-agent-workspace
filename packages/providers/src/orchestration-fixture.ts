import type { ProviderContinuation, ProviderEvent, ProviderRequest, ProviderToolResult, ToolCall } from "../../protocol/src/index.js";

/**
 * Deterministic offline coordinator/child script. It only proposes tool calls; every
 * effect still goes through runtime scope checks, approvals, typed Git operations and
 * real command execution. Nothing here fabricates commits, trees or evidence.
 */
interface Memo { [key: string]: unknown }
interface FixtureState { fixture: "coordinator" | "child"; stage: string; calls: ToolCall[]; memo: Memo }

export function isOrchestrationRequest(request: ProviderRequest): boolean {
    return Boolean(request.tools?.some(tool => tool.name === "delegate_assignments" || tool.name === "submit_handoff"));
}

export async function* orchestrationFixture(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const state = parseState(request.continuation);
    const child = request.tools!.some(tool => tool.name === "submit_handoff");
    if (child) yield* childScript(request, state);
    else yield* coordinatorScript(request, state);
}

async function* coordinatorScript(request: ProviderRequest, state: FixtureState | undefined): AsyncIterable<ProviderEvent> {
    const say = (text: string, memo: Memo = state?.memo ?? {}) => finish(request, "coordinator", text, memo);
    if (!state || state.stage === "chat" || state.stage === "complete") {
        const user = lastUser(request);
        if (!user.startsWith("/orchestrate-demo")) { yield* say(`Fake coordinator response: ${user || "No user message."}`); return; }
        const config = parseLine(request, "FOUNDRY_CONFIG");
        if (!config) { yield* say("Coordinator fixture stopped: configuration was not provided by the runtime."); return; }
        const validation = config.requiredValidation;
        // Use a second explicitly configured child profile for beta when the user selected one.
        const profiles = Array.isArray(config.childProfiles) ? config.childProfiles as { id: string }[] : [];
        const betaProfile = profiles[1]?.id;
        const assignment = (key: string, dependsOn: string[] = []) => ({ ...(key === "beta" && betaProfile ? { profileId: betaProfile } : {}), key, objective: `Append the line "${key} child change" to ${key}.txt.`, acceptance: [`${key}.txt ends with "${key} child change"`], writePaths: [`${key}.txt`], readPaths: [`${key}.txt`], allocation: 60000, dependsOn, validation: { command: `if ((Get-Content -Raw ${key}.txt) -notmatch '${key} child change') { exit 3 }; Write-Output 'validated ${key}'`, cwd: "", timeoutMs: 60000 } });
        yield* call(request, "coordinator", "delegate", "delegate_assignments", { assignments: [assignment("alpha"), assignment("beta"), assignment("gamma", ["alpha"])] }, { validation });
        return;
    }
    const result = single(request, state);
    const memo = { ...state.memo };
    const fail = (why: string) => say(`Coordinator fixture stopped at ${state.stage}: ${why}. ${result.content.slice(0, 400)}`, memo);
    if (result.isError) { yield* fail("the tool returned an error"); return; }
    const data = parse(result.content);
    switch (state.stage) {
        case "delegate": {
            const ids = Object.fromEntries(array(data?.assignments).map(item => [String(item.key), String(item.assignmentId)]));
            if (!ids.alpha || !ids.beta || !ids.gamma) { yield* fail("assignment ids missing"); return; }
            memo.ids = ids;
            yield* call(request, "coordinator", "await-first", "await_children", { assignmentIds: [ids.alpha, ids.beta] }, memo);
            return;
        }
        case "await-first": {
            const results = resultIds(data);
            if (!results.alpha || !results.beta) { yield* fail("children did not submit results"); return; }
            memo.results = results;
            yield* call(request, "coordinator", "integrate-alpha", "integrate_result", { resultId: results.alpha }, memo);
            return;
        }
        case "integrate-alpha":
            yield* call(request, "coordinator", "integrate-beta", "integrate_result", { resultId: (memo.results as Record<string, string>).beta }, memo);
            return;
        case "integrate-beta":
            yield* call(request, "coordinator", "validate-first", "run_command", validationArgs(memo), memo);
            return;
        case "validate-first":
            if (data?.validationPassed !== true) { yield* fail("combined validation did not pass"); return; }
            yield* call(request, "coordinator", "await-gamma", "await_children", { assignmentIds: [(memo.ids as Record<string, string>).gamma] }, memo);
            return;
        case "await-gamma": {
            const results = resultIds(data);
            if (!results.gamma) { yield* fail("dependent child did not submit a result"); return; }
            memo.results = { ...(memo.results as Record<string, string>), gamma: results.gamma };
            yield* call(request, "coordinator", "integrate-gamma", "integrate_result", { resultId: results.gamma }, memo);
            return;
        }
        case "integrate-gamma":
            yield* call(request, "coordinator", "validate-final", "run_command", validationArgs(memo), memo);
            return;
        case "validate-final":
            if (data?.validationPassed !== true) { yield* fail("final combined validation did not pass"); return; }
            yield* call(request, "coordinator", "complete", "complete_task", { summary: "Integrated alpha, beta and dependent gamma; combined validation passed on the final tree." }, memo);
            return;
        case "complete":
            yield* say("Coordinated demo completed: three child handoffs were integrated serially and the combined validation passed on the exact final tree.", memo);
            return;
        default:
            throw new Error("Invalid coordinator fixture continuation.");
    }
}

async function* childScript(request: ProviderRequest, state: FixtureState | undefined): AsyncIterable<ProviderEvent> {
    const say = (text: string, memo: Memo = state?.memo ?? {}) => finish(request, "child", text, memo);
    if (!state || state.stage === "chat" || state.stage === "complete") {
        const assignment = parseLine(request, "FOUNDRY_ASSIGNMENT");
        const path = Array.isArray(assignment?.writePaths) ? assignment.writePaths[0] : undefined;
        if (!assignment || typeof path !== "string") { yield* say("Child fixture stopped: assignment was not provided by the runtime."); return; }
        yield* call(request, "child", "read", "read_file", { path }, { path, key: assignment.key, validation: assignment.validation });
        return;
    }
    const result = single(request, state);
    const memo = { ...state.memo };
    if (result.isError) { yield* say(`Child fixture stopped at ${state.stage}: ${result.content.slice(0, 400)}`, memo); return; }
    const data = parse(result.content);
    switch (state.stage) {
        case "read": {
            if (typeof data?.content !== "string" || typeof data.hash !== "string") { yield* say("Child fixture stopped: file content unavailable.", memo); return; }
            const content = data.content.endsWith("\n") || !data.content ? data.content : `${data.content}\n`;
            yield* call(request, "child", "edit", "replace_text", { path: memo.path, expectedHash: data.hash, oldText: data.content, newText: `${content}${String(memo.key)} child change\n` }, memo);
            return;
        }
        case "edit":
            yield* call(request, "child", "commit", "commit_handoff", { paths: [memo.path], summary: `Append ${String(memo.key)} child change` }, memo);
            return;
        case "commit": {
            const validation = memo.validation as { command: string; cwd: string; timeoutMs: number } | null;
            if (!validation) { yield* call(request, "child", "submit", "submit_handoff", { summary: "Committed the change; no validation command was assigned.", unresolved: "", evidenceIds: [] }, memo); return; }
            yield* call(request, "child", "validate", "run_command", { command: validation.command, cwd: validation.cwd, environment: {}, timeoutMs: validation.timeoutMs }, memo);
            return;
        }
        case "validate": {
            if (typeof data?.evidenceId !== "string" || data.validationPassed !== true) { yield* say("Child fixture stopped: validation did not produce passing runtime evidence.", memo); return; }
            yield* call(request, "child", "submit", "submit_handoff", { summary: `Appended ${String(memo.key)} child change; validation passed on the committed tree.`, unresolved: "", evidenceIds: [data.evidenceId] }, memo);
            return;
        }
        case "submit":
            yield* say("Handoff submitted.", memo);
            return;
        default:
            throw new Error("Invalid child fixture continuation.");
    }
}

function validationArgs(memo: Memo): Record<string, unknown> {
    const validation = memo.validation as { command: string; cwd: string; timeoutMs: number };
    return { command: validation.command, cwd: validation.cwd, environment: {}, timeoutMs: validation.timeoutMs };
}
function resultIds(data: Record<string, unknown> | undefined): Record<string, string> {
    return Object.fromEntries(array(data?.children).filter(item => item.result && typeof (item.result as Record<string, unknown>).id === "string").map(item => [String(item.key), String((item.result as Record<string, unknown>).id)]));
}
async function* call(request: ProviderRequest, fixture: FixtureState["fixture"], stage: string, name: string, args: unknown, memo: Memo): AsyncIterable<ProviderEvent> {
    throwIfAborted(request.signal);
    const toolCall: ToolCall = { id: `fixture-${fixture}-${stage}`, name, arguments: args };
    yield { type: "tool_call", call: toolCall };
    yield { type: "done", continuation: continuation(fixture, stage, [toolCall], memo) };
}
async function* finish(request: ProviderRequest, fixture: FixtureState["fixture"], text: string, memo: Memo): AsyncIterable<ProviderEvent> {
    for (let index = 0; index < text.length; index += 24) {
        throwIfAborted(request.signal);
        yield { type: "text", text: text.slice(index, index + 24) };
        await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    yield { type: "done", continuation: continuation(fixture, "complete", [], memo) };
}
function continuation(fixture: FixtureState["fixture"], stage: string, calls: ToolCall[], memo: Memo): ProviderContinuation { return { apiKind: "fake", data: { fixture, stage, calls, memo } }; }
function parseState(value: ProviderContinuation | undefined): FixtureState | undefined {
    if (!value) return undefined;
    const data = value.data as Partial<FixtureState> | undefined;
    if (value.apiKind !== "fake" || !data || typeof data !== "object") throw new Error("Invalid fixture continuation.");
    if (data.fixture !== "coordinator" && data.fixture !== "child") return { fixture: "coordinator", stage: "chat", calls: [], memo: {} };
    if (typeof data.stage !== "string" || !Array.isArray(data.calls)) throw new Error("Invalid fixture continuation.");
    return { fixture: data.fixture, stage: data.stage, calls: data.calls as ToolCall[], memo: (data.memo ?? {}) as Memo };
}
function single(request: ProviderRequest, state: FixtureState): ProviderToolResult {
    const pending = state.calls[0];
    const result = request.toolResults?.find(item => item.id === pending?.id);
    if (!pending || !result || result.name !== pending.name || request.toolResults!.length !== state.calls.length) throw new Error("Pending fixture call requires its matching result.");
    return result;
}
function parseLine(request: ProviderRequest, marker: string): Record<string, unknown> | undefined {
    for (const message of request.messages) {
        const line = message.content.split("\n").find(entry => entry.startsWith(`${marker} `));
        if (line) return parse(line.slice(marker.length + 1));
    }
    return undefined;
}
function parse(value: string): Record<string, unknown> | undefined {
    try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
}
function array(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : []; }
function lastUser(request: ProviderRequest): string { return [...request.messages].reverse().find(message => message.role === "user")?.content ?? ""; }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"); }
