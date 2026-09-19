import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerConfig, McpServerStatus, McpTool, ToolDefinition } from '../../protocol/src/index';
import { LineDecoder } from '../../protocol/src/framing';
import { Redactor } from './redaction';

/**
 * Model Context Protocol (stdio) under the runtime's execution policy.
 *
 * Servers are launched only from explicit user configuration, hosted in a kill-on-close Windows
 * Job Object by `mcp-host.ps1` (the server inherits this process's pipes, so JSON-RPC traffic
 * never passes through PowerShell), and terminated on cancellation, idle timeout, lifetime expiry,
 * runtime shutdown or runtime death. Tool names, descriptions, schemas and results are untrusted
 * data: they are bounded, secret-screened, and never grant permissions. Whether a tool runs without
 * a per-call approval is decided only by the user-managed allowlist in the server configuration;
 * server annotations are shown as hints and nothing more.
 */

export const MCP_TOOL_PREFIX = 'mcp__';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_TOOLS = 128;
const MAX_TOOL_DESCRIPTION_CHARS = 1024;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const START_TIMEOUT_MS = 30_000;
const IDLE_STOP_MS = 2 * 60 * 1000;
const LIFETIME_MS = 6 * 60 * 60 * 1000;
const STOP_GRACE_MS = 10_000;
// Name screening is a best-effort guard (values are also screened by the redactor); the settings UI says so. Segment matches
// such as AUTH, KEY, PASS, PAT or PWD are refused in addition to the credential-like substrings.
const FORBIDDEN_ENVIRONMENT = /(?:credential|secret|token|password|passwd|authorization|api[_-]?key|cookie|proxy|node_options|bearer|private)|(?:^|_)(?:auth|key|keys|pass|pat|pwd|session|signing)(?:_|$)/i;
const RESERVED_ENVIRONMENT = /^(?:path|comspec|systemroot|windir|pathext|psmodulepath|temp|tmp|userprofile)$/i;

/** `unknownOutcome` marks failures after the request may have reached the server (timeouts, broken transport): never treated as success or replayed. */
export class McpError extends Error { constructor(message: string, readonly unknownOutcome = false) { super(message); this.name = 'McpError'; } }

export interface McpCallResult { content: string; isError: boolean; truncated: boolean }
export interface McpListing { tools: McpTool[]; skipped: string[]; serverInfo: { name: string; version: string } | null }
export interface McpHostResult { exitCode: number | null; cancelled: boolean; parentDied: boolean; lifetimeExpired: boolean; cleanupVerified: boolean; processId: number; nonce: string }

interface JsonRpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }

/** Newline-delimited JSON-RPC 2.0 client over any pair of streams. Requests are bounded and time out; nothing retries. */
export class McpClient {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly decoder = new LineDecoder(MAX_MESSAGE_BYTES);
  private closed: Error | undefined;
  private sequence = 0;
  readonly notifications: { method: string; params: unknown }[] = [];
  constructor(private readonly output: NodeJS.WritableStream, input: NodeJS.ReadableStream, private readonly onProtocolError: (error: Error) => void = () => undefined) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.receive(chunk));
    input.on('end', () => this.close(new McpError('The MCP server closed its output stream.')));
    input.on('error', error => this.close(new McpError(`MCP transport failed: ${error instanceof Error ? error.message : 'unknown error'}`)));
  }
  private receive(chunk: string): void {
    let lines: string[];
    try { lines = this.decoder.push(chunk); } catch { this.close(new McpError('The MCP server sent a message above the size limit.')); return; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try { message = JSON.parse(line) as JsonRpcMessage; } catch { this.close(new McpError('The MCP server sent malformed JSON.')); return; }
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') { this.close(new McpError('The MCP server sent a non JSON-RPC 2.0 message.')); return; }
      if (message.id === undefined || message.id === null) {
        if (typeof message.method === 'string') { if (this.notifications.length < 100) this.notifications.push({ method: message.method, params: message.params }); }
        continue;
      }
      if (typeof message.method === 'string') {
        // Server-to-client requests (sampling, roots, elicitation) are not supported and never grant anything.
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client requests are not supported by this host.' } });
        continue;
      }
      const waiter = this.pending.get(String(message.id));
      if (!waiter) continue;
      clearTimeout(waiter.timer); this.pending.delete(String(message.id));
      if (message.error) waiter.reject(new McpError(`MCP server error${typeof message.error.code === 'number' ? ` ${message.error.code}` : ''}: ${typeof message.error.message === 'string' ? message.error.message.slice(0, 500) : 'unknown'}`));
      else waiter.resolve(message.result);
    }
  }
  private send(value: unknown): void {
    const line = JSON.stringify(value);
    if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) throw new McpError('MCP request exceeds the message size limit.');
    this.output.write(line + '\n');
  }
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = `${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const finish = (): void => { this.pending.delete(id); signal?.removeEventListener('abort', onAbort); };
      const timer = setTimeout(() => { finish(); reject(new McpError(`MCP ${method} timed out after ${timeoutMs} ms.`, true)); }, timeoutMs);
      const onAbort = (): void => { clearTimeout(timer); finish(); reject(abortError(signal!)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve: value => { clearTimeout(timer); finish(); resolve(value); }, reject: error => { clearTimeout(timer); finish(); reject(error); }, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) { clearTimeout(timer); finish(); reject(error); }
    });
  }
  notify(method: string, params: unknown): void { if (!this.closed) this.send({ jsonrpc: '2.0', method, params }); }
  close(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    this.onProtocolError(error);
  }
  get isClosed(): boolean { return Boolean(this.closed); }
}

/** One hosted server process. */
export class McpProcess {
  private stopping: Promise<McpHostResult | undefined> | undefined;
  private stderrText = '';
  private constructor(private readonly child: ChildProcess, private readonly directory: string, private readonly nonce: string, readonly exited: Promise<number | null>) {
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { if (this.stderrText.length < MAX_STDERR_BYTES) this.stderrText += chunk.slice(0, MAX_STDERR_BYTES - this.stderrText.length); });
  }
  get stdin(): NodeJS.WritableStream { return this.child.stdin!; }
  get stdout(): NodeJS.ReadableStream { return this.child.stdout!; }
  get stderr(): string { return this.stderrText; }
  get running(): boolean { return this.child.exitCode === null && !this.child.killed && !this.stopping; }
  static async start(hostPath: string, config: McpServerConfig, environment: Record<string, string>): Promise<McpProcess> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-mcp-'));
    const nonce = randomUUID();
    const spec = { nonce, resultPath: path.join(directory, 'result.json'), cancelPath: path.join(directory, 'cancel'), command: config.command, arguments: config.arguments, cwd: config.cwd, environment, lifetimeMs: LIFETIME_MS, parentPid: process.pid, parentStartedAtMs: Math.floor(Date.now() - process.uptime() * 1000) };
    const specPath = path.join(directory, 'spec.json');
    await fs.writeFile(specPath, JSON.stringify(spec), { flag: 'wx' });
    const shell = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hostPath, specPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: environment });
    const exited = new Promise<number | null>(resolve => { child.once('error', () => resolve(null)); child.once('exit', code => resolve(code)); });
    return new McpProcess(child, directory, nonce, exited);
  }
  /** Ask the host to terminate the job, wait for verified cleanup, then remove the spec directory. */
  stop(): Promise<McpHostResult | undefined> {
    this.stopping ??= (async () => {
      await fs.writeFile(path.join(this.directory, 'cancel'), 'cancelled', { flag: 'w' }).catch(() => undefined);
      try { this.child.stdin?.end(); } catch { /* already closed */ }
      const timer = setTimeout(() => this.child.kill(), STOP_GRACE_MS);
      await this.exited.catch(() => undefined);
      clearTimeout(timer);
      let result: McpHostResult | undefined;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.directory, 'result.json'), 'utf8')) as McpHostResult;
        if (parsed.nonce === this.nonce) result = parsed;
      } catch { result = undefined; }
      await fs.rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
      return result;
    })();
    return this.stopping;
  }
}

interface Session { config: McpServerConfig; fingerprint: string; process: McpProcess; client: McpClient; tools: McpTool[]; serverInfo: { name: string; version: string } | null; idle?: NodeJS.Timeout; busy: number; failed?: Error }

export interface McpManagerOptions { hostPath?: string; forbiddenRoots?: () => string[] }

export class McpManager {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<Session>>();
  private readonly hostPath: string;
  private closing = false;
  constructor(private readonly servers: () => McpServerStatus[], private readonly redactor: Redactor, private readonly options: McpManagerOptions = {}) {
    this.hostPath = path.resolve(options.hostPath ?? unpackedHostPath());
  }

  /** Tool definitions advertised to models from the retained listing of enabled servers. */
  toolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const server of this.servers()) {
      if (!server.enabled) continue;
      for (const tool of server.tools) {
        const name = composeName(server.key, tool.name);
        if (!name) continue;
        definitions.push({ name, description: `[MCP server "${server.name}"${server.readOnlyTools.includes(tool.name) ? ', runs without approval' : ', requires user approval'}] ${tool.description}`, inputSchema: tool.inputSchema });
      }
    }
    return definitions;
  }

  static isMcpToolName(name: string): boolean { return name.startsWith(MCP_TOOL_PREFIX); }

  /** Resolve an advertised name to its configured server and retained tool description. */
  resolve(name: string): { server: McpServerStatus; tool: McpTool; readOnly: boolean } | undefined {
    if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined;
    const rest = name.slice(MCP_TOOL_PREFIX.length);
    const separator = rest.indexOf('__');
    if (separator <= 0) return undefined;
    const key = rest.slice(0, separator); const toolName = rest.slice(separator + 2);
    const server = this.servers().find(item => item.key === key && item.enabled);
    const tool = server?.tools.find(item => item.name === toolName);
    if (!server || !tool || composeName(server.key, tool.name) !== name) return undefined;
    return { server, tool, readOnly: server.readOnlyTools.includes(tool.name) };
  }

  /** Validate a configuration and launch the server once to list its tools. The listing is what the runtime later advertises. */
  async connect(config: McpServerConfig): Promise<McpListing> {
    await this.validate(config, true);
    const session = await this.openSession(config, true);
    try {
      const listing = await this.listTools(session);
      session.tools = listing.tools; session.serverInfo = listing.serverInfo;
      return listing;
    } finally { this.touch(session); }
  }

  /** Execute a tool call. The caller has already applied policy (approval or allowlist) and secret screening of the arguments. */
  async call(config: McpServerConfig, toolName: string, args: unknown, signal: AbortSignal): Promise<McpCallResult> {
    if (this.closing) throw new McpError('The runtime is shutting down.');
    if (!isRecord(args)) throw new McpError('MCP tool arguments must be a JSON object.');
    const encoded = JSON.stringify(args);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_ARGUMENT_BYTES) throw new McpError('MCP tool arguments exceed the size limit.');
    const session = await this.openSession(config, false);
    if (!session.tools.some(tool => tool.name === toolName)) throw new McpError(`The running server no longer lists tool ${toolName}. Reconnect the server from settings.`);
    session.busy++;
    try {
      const raw = await session.client.request('tools/call', { name: toolName, arguments: args }, config.callTimeoutMs, signal);
      return this.boundResult(raw);
    } catch (error) {
      if (!(error instanceof McpError) && session.client.isClosed) throw new McpError(`The MCP server connection closed during the call: ${error instanceof Error ? error.message : 'unknown error'}`, true);
      // A timed-out or protocol-broken session is stopped so a stuck server cannot hold the slot; it is not retried.
      if (error instanceof McpError && (error.unknownOutcome || session.client.isClosed)) await this.stopSession(session.config.id, error);
      throw error;
    } finally { session.busy--; this.touch(session); }
  }

  statusOf(serverId: string): { running: boolean; lastError: string | null } {
    const session = this.sessions.get(serverId);
    const note = session?.failed ? this.redactor.text(session.failed.message) : this.unverifiedStops.has(serverId) ? 'The last stop could not verify that every server process ended within five seconds; the kill-on-close job still terminates the tree when the host exits.' : null;
    return { running: Boolean(session?.process.running), lastError: note };
  }
  private readonly unverifiedStops = new Set<string>();

  async stopServer(serverId: string): Promise<void> { await this.stopSession(serverId, undefined); }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.sessions.keys()].map(id => this.stopSession(id, new McpError('Runtime shutdown.'))));
  }

  // ---------------------------------------------------------------- internals

  /** Secret screening of stored values happens when the configuration is authored; a launch re-checks only the filesystem facts. */
  private async validate(config: McpServerConfig, screenSecrets: boolean): Promise<void> {
    if (!path.isAbsolute(config.command) || !/\.exe$/i.test(config.command)) throw new McpError('The server command must be an absolute path to an .exe file; pass scripts as arguments to their interpreter.');
    const command = await fs.realpath(config.command).catch(() => { throw new McpError('The server command was not found.'); });
    if (!(await fs.stat(command)).isFile()) throw new McpError('The server command must be a file.');
    const forbidden = this.options.forbiddenRoots?.() ?? [];
    for (const root of forbidden) if (isInside(root, command)) throw new McpError('The server command must not live inside app-owned worktrees.');
    if (config.cwd) {
      if (!path.isAbsolute(config.cwd)) throw new McpError('The server working directory must be an absolute path.');
      if (!(await fs.stat(config.cwd).catch(() => undefined))?.isDirectory()) throw new McpError('The server working directory was not found.');
      const realCwd = await fs.realpath(config.cwd).catch(() => path.resolve(config.cwd));
      for (const root of forbidden) if (isInside(root, realCwd)) throw new McpError('The server working directory must not live inside app-owned worktrees.');
    }
    for (const [key, value] of Object.entries(config.environment)) {
      if (RESERVED_ENVIRONMENT.test(key) || FORBIDDEN_ENVIRONMENT.test(key)) throw new McpError(`Environment variable ${key} is not permitted for MCP servers.`);
      if (value.includes('\0')) throw new McpError(`Environment variable ${key} has an invalid value.`);
      if (screenSecrets && this.redactor.text(value) !== value) throw new McpError(`Environment variable ${key} contains secret-like content and cannot be stored.`);
    }
    for (const argument of config.arguments) {
      if (argument.includes('\0') || (screenSecrets && this.redactor.text(argument) !== argument)) throw new McpError('Server arguments contain NUL or secret-like content.');
      if (path.isAbsolute(argument)) {
        const resolved = await fs.realpath(argument).catch(() => path.resolve(argument));
        for (const root of forbidden) if (isInside(root, resolved)) throw new McpError('Server arguments must not reference files inside app-owned worktrees.');
      }
    }
  }

  private environment(config: McpServerConfig): Record<string, string> {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new McpError('SystemRoot is unavailable.');
    const temp = process.env.TEMP ?? process.env.TMP ?? path.join(systemRoot, 'Temp');
    const base: Record<string, string> = {
      SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
      PATH: [path.dirname(config.command), path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter),
      TEMP: temp, TMP: temp, USERPROFILE: process.env.USERPROFILE ?? path.dirname(temp)
    };
    return Object.fromEntries(Object.entries({ ...base, ...config.environment }).sort(([left], [right]) => left.localeCompare(right)));
  }

  private async openSession(config: McpServerConfig, fresh: boolean): Promise<Session> {
    if (this.closing) throw new McpError('The runtime is shutting down.');
    const fingerprint = configFingerprint(config);
    const existing = this.sessions.get(config.id);
    if (existing && existing.fingerprint === fingerprint && existing.process.running && !existing.client.isClosed && !fresh) return existing;
    if (existing) await this.stopSession(config.id, undefined);
    const inflight = this.starting.get(config.id);
    if (inflight) return inflight;
    const start = (async () => {
      await this.validate(config, false);
      const host = await fs.realpath(this.hostPath);
      if (!path.isAbsolute(host)) throw new McpError('MCP host helper is unavailable.');
      const cwd = config.cwd || path.dirname(config.command);
      const processHandle = await McpProcess.start(host, { ...config, cwd }, this.environment(config));
      const session: Session = { config, fingerprint, process: processHandle, client: undefined as unknown as McpClient, tools: [], serverInfo: null, busy: 0 };
      session.client = new McpClient(processHandle.stdin, processHandle.stdout, error => { session.failed = error; });
      void processHandle.exited.then(() => session.client.close(new McpError(`The MCP server exited${processHandle.stderr ? `: ${this.redactor.text(processHandle.stderr).slice(0, 500)}` : '.'}`)));
      try {
        const init = await session.client.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'foundry-agent-workspace', version: '0.2.0' } }, START_TIMEOUT_MS);
        if (!isRecord(init) || typeof init.protocolVersion !== 'string') throw new McpError('The MCP server returned an invalid initialize result.');
        const info = isRecord(init.serverInfo) ? init.serverInfo : {};
        session.serverInfo = { name: String(info.name ?? 'unknown').slice(0, 100), version: String(info.version ?? '').slice(0, 50) };
        session.client.notify('notifications/initialized', {});
        session.tools = (await this.listTools(session)).tools;
      } catch (error) {
        const host = await processHandle.stop();
        const detail = [error instanceof Error ? this.redactor.text(error.message) : 'unknown error', host ? `host: exit ${host.exitCode ?? 'terminated'}${host.parentDied ? ', runtime parent check failed' : ''}` : 'host result unavailable', processHandle.stderr ? `stderr: ${this.redactor.text(processHandle.stderr).slice(0, 300)}` : ''].filter(Boolean).join('; ');
        throw new McpError(`The MCP server failed to start. ${detail}`);
      }
      this.sessions.set(config.id, session);
      this.touch(session);
      return session;
    })();
    this.starting.set(config.id, start);
    try { return await start; } finally { this.starting.delete(config.id); }
  }

  private async listTools(session: Session): Promise<McpListing> {
    const tools: McpTool[] = []; const skipped: string[] = [];
    let cursor: string | undefined = undefined;
    let totalFetched = 0;
    const seenCursors = new Set<string>();
    let pages = 0;
    const MAX_PAGES = 32;
    do {
      if (cursor) {
        if (seenCursors.has(cursor)) {
          skipped.push('pagination loop detected in MCP tools/list');
          break;
        }
        seenCursors.add(cursor);
      }
      pages++;
      if (pages > MAX_PAGES) {
        skipped.push('MCP tools/list exceeded page limit');
        break;
      }
      const params: Record<string, unknown> = cursor ? { cursor } : {};
      const result = await session.client.request('tools/list', params, START_TIMEOUT_MS);
      if (!isRecord(result) || !Array.isArray(result.tools)) throw new McpError('The MCP server returned an invalid tools/list result.');
      for (const raw of result.tools) {
        totalFetched++;
        if (tools.length >= MAX_TOOLS) continue;
        if (!isRecord(raw) || typeof raw.name !== 'string') { skipped.push('(invalid tool entry)'); continue; }
        if (!TOOL_NAME.test(raw.name) || !composeName(session.config.key, raw.name)) { skipped.push(`${raw.name.slice(0, 64)}: unsupported name`); continue; }
        const schema = isRecord(raw.inputSchema) && raw.inputSchema.type === 'object' ? raw.inputSchema : { type: 'object', properties: {}, additionalProperties: true };
        if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_SCHEMA_BYTES) { skipped.push(`${raw.name}: schema too large`); continue; }
        const description = this.redactor.text(typeof raw.description === 'string' ? raw.description : '').replace(/\s+/g, ' ').trim().slice(0, MAX_TOOL_DESCRIPTION_CHARS);
        const annotations = isRecord(raw.annotations) ? raw.annotations : {};
        tools.push({ name: raw.name, description, inputSchema: JSON.parse(this.redactor.text(JSON.stringify(schema))) as Record<string, unknown>, readOnlyHint: annotations.readOnlyHint === true });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor.length ? result.nextCursor : undefined;
    } while (cursor && tools.length < MAX_TOOLS);
    if (totalFetched > MAX_TOOLS) skipped.push(`${totalFetched - MAX_TOOLS} further tools beyond the limit`);
    return { tools, skipped, serverInfo: session.serverInfo };
  }

  private boundResult(raw: unknown): McpCallResult {
    if (!isRecord(raw)) throw new McpError('The MCP server returned an invalid tools/call result.', true);
    const blocks = Array.isArray(raw.content) ? raw.content : [];
    const parts: string[] = [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else parts.push(`[${typeof block.type === 'string' ? block.type : 'unknown'} content omitted]`);
    }
    if (!blocks.length && raw.structuredContent !== undefined) parts.push(JSON.stringify(raw.structuredContent));
    const text = this.redactor.text(parts.join('\n'));
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= MAX_RESULT_BYTES) return { content: text, isError: raw.isError === true, truncated: false };
    const head = Buffer.from(text, 'utf8').subarray(0, MAX_RESULT_BYTES - 2048).toString('utf8').replace(/\uFFFD$/, '');
    const tail = Buffer.from(text, 'utf8').subarray(bytes - 1024).toString('utf8').replace(/^\uFFFD/, '');
    return { content: `${head}\n[MCP output truncated: ${bytes} bytes total; head and tail excerpts shown]\n${tail}`, isError: raw.isError === true, truncated: true };
  }

  private touch(session: Session): void {
    if (session.idle) clearTimeout(session.idle);
    session.idle = setTimeout(() => { if (!session.busy) void this.stopSession(session.config.id, undefined); }, IDLE_STOP_MS);
    session.idle.unref?.();
  }

  private async stopSession(serverId: string, error: Error | undefined): Promise<void> {
    const session = this.sessions.get(serverId);
    if (!session) return;
    this.sessions.delete(serverId);
    if (session.idle) clearTimeout(session.idle);
    session.client.close(error ?? new McpError('The MCP server was stopped.'));
    const result = await session.process.stop();
    if (result && !result.cleanupVerified) this.unverifiedStops.add(serverId); else if (result) this.unverifiedStops.delete(serverId);
  }
}

export function composeName(key: string, tool: string): string | undefined {
  const name = `${MCP_TOOL_PREFIX}${key}__${tool}`;
  return TOOL_NAME.test(tool) && name.length <= 64 ? name : undefined;
}
function configFingerprint(config: McpServerConfig): string { return createHash('sha256').update(JSON.stringify([config.command, config.arguments, config.cwd, config.environment])).digest('hex'); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function abortError(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'); }
function isInside(root: string, candidate: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function unpackedHostPath(): string {
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-host.ps1');
  const marker = `${path.sep}app.asar${path.sep}`;
  return source.toLowerCase().includes(marker.toLowerCase())
    ? source.replace(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${path.sep}app.asar.unpacked${path.sep}`)
    : source;
}
