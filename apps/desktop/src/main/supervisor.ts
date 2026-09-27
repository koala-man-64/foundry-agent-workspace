import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_RPC_BYTES, RpcResponseSchema, BrowserHostCallSchema, BrowserHostReplySchema, BrowserHostError, BrowserInvalidationSchema, type BrowserHost } from '../../../../packages/protocol/src/index';
import type { WorkspaceEvent } from '../../../../packages/protocol/src/index';
import { LineDecoder } from '../../../../packages/protocol/src/framing';

export const EventSchema = z.object({ jsonrpc: z.literal('2.0'), method: z.literal('workspace.event'), params: z.object({ sequence: z.number().int(), type: z.string(), taskId: z.string().optional(), rootTaskId: z.string().optional(), version: z.literal(1).optional(), source: z.enum(['runtime', 'legacy']).optional(), legacy: z.literal(true).optional(), data: z.unknown(), createdAt: z.string() }).strict() }).strict();
export class RuntimeSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private decoder = new LineDecoder(MAX_RPC_BYTES);
  private closed = false;
  private readonly browserCalls = new Set<string>();
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(private readonly runtimePath: string, private readonly dataDirectory: string, private readonly onEvent: (event: WorkspaceEvent) => void, private readonly onExit: () => void, private readonly extraEnvironment: Record<string, string> = {}, private readonly browserHost?: BrowserHost) {}
  start(): void {
    if (this.child) return;
    this.closed = false; this.decoder = new LineDecoder(MAX_RPC_BYTES);
    this.browserCalls.clear();
    // The runtime receives no inherited API tokens or Azure credentials.
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', FOUNDRY_WORKSPACE_DATA: this.dataDirectory, ...this.extraEnvironment };
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE', 'APPDATA', 'HOME']) if (process.env[name]) env[name] = process.env[name];
    const child = spawn(process.execPath, [this.runtimePath], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(child, chunk));
    // Runtime diagnostics are intentionally bounded and contain no provider payloads.
    child.stderr.on('data', () => { /* UI receives only the exit state. */ });
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => this.transportFailed(child));
    child.on('error', () => this.transportFailed(child));
    child.on('exit', () => this.transportFailed(child));
  }
  private transportFailed(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = undefined;
    try { child.kill(); } catch { /* Already exited. */ }
    this.fail();
    if (!this.closed) this.onExit();
  }
  private fail(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('The runtime transport stopped. The request outcome may be unknown; restart the application and inspect saved tasks before retrying.')); }
    this.pending.clear();
  }
  private receive(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    let lines: string[];
    try { lines = this.decoder.push(chunk); } catch { this.transportFailed(child); return; }
    for (const line of lines) {
      try {
        const data: unknown = JSON.parse(line);
        const browserCall = BrowserHostCallSchema.safeParse(data);
        if (browserCall.success) {
          if (this.browserCalls.size >= 32 || this.browserCalls.has(browserCall.data.id)) throw new Error('Invalid browser call concurrency.');
          this.browserCalls.add(browserCall.data.id);
          void this.answerBrowser(browserCall.data, this.child!);
          continue;
        }
        const event = EventSchema.safeParse(data);
        if (event.success) { this.onEvent(event.data.params); continue; }
        const response = RpcResponseSchema.parse(data);
        const request = this.pending.get(response.id); if (!request) continue;
        clearTimeout(request.timer); this.pending.delete(response.id);
        if ('error' in response) request.reject(new Error(response.error.message)); else request.resolve(response.result);
      } catch { this.transportFailed(child); return; }
    }
  }
  private async answerBrowser(call: z.infer<typeof BrowserHostCallSchema>, child: ChildProcessWithoutNullStreams): Promise<void> {
    let reply: z.infer<typeof BrowserHostReplySchema>;
    try {
      if (!this.browserHost || this.closed) throw new BrowserHostError('stale', 'The browser is unavailable.');
      const result = await this.browserHost.request(call.params);
      reply = BrowserHostReplySchema.parse({ jsonrpc: '2.0', id: call.id, method: 'browser.host.result', result });
    } catch (error) {
      reply = { jsonrpc: '2.0', id: call.id, method: 'browser.host.result', error: {
        code: error instanceof BrowserHostError ? error.code : call.params.kind === 'execute' ? 'unknown' : 'failed',
        message: error instanceof BrowserHostError ? error.message.slice(0, 1000) : 'The browser request did not complete. Inspect the tab before continuing.'
      } };
    }
    if (this.child !== child) return;
    this.browserCalls.delete(call.id);
    if (this.closed || !child.stdin.writable) return;
    const line = JSON.stringify(reply) + '\n';
    if (Buffer.byteLength(line) > MAX_RPC_BYTES) { this.transportFailed(child); return; }
    try { child.stdin.write(line, error => { if (error) this.transportFailed(child); }); }
    catch { this.transportFailed(child); }
  }
  invalidateBrowser(taskId: string, tabId: string): void {
    const payload = BrowserInvalidationSchema.parse({ jsonrpc: '2.0', method: 'browser.invalidated', params: { taskId, tabId } });
    const child = this.child;
    if (child && !this.closed) {
      try { child.stdin.write(JSON.stringify(payload) + '\n', error => { if (error) this.transportFailed(child); }); }
      catch { this.transportFailed(child); }
    }
  }
  request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(new Error('The runtime is not available. Restart the application.'));
    const id = randomUUID(); const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (Buffer.byteLength(payload) > MAX_RPC_BYTES) return Promise.reject(new Error('Request exceeds the allowed size.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Runtime request timed out. Its outcome may be unknown; do not blindly retry a task creation.')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(payload, error => { if (error) this.transportFailed(child); }); }
      catch { this.transportFailed(child); }
    });
  }
  async stop(): Promise<void> {
    this.closed = true;
    const child = this.child; if (!child) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 45000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.stdin.end(); } catch { this.transportFailed(child); }
    });
  }
}
