import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_RPC_BYTES, RpcResponseSchema } from '../../../../packages/protocol/src/index';
import type { WorkspaceEvent } from '../../../../packages/protocol/src/index';
import { LineDecoder } from '../../../../packages/protocol/src/framing';

const EventSchema = z.object({ jsonrpc: z.literal('2.0'), method: z.literal('workspace.event'), params: z.object({ sequence: z.number().int(), type: z.string(), taskId: z.string().optional(), data: z.unknown(), createdAt: z.string() }).strict() }).strict();
export class RuntimeSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private decoder = new LineDecoder(MAX_RPC_BYTES);
  private closed = false;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(private readonly runtimePath: string, private readonly dataDirectory: string, private readonly onEvent: (event: WorkspaceEvent) => void, private readonly onExit: () => void, private readonly extraEnvironment: Record<string, string> = {}) {}
  start(): void {
    if (this.child) return;
    this.closed = false; this.decoder = new LineDecoder(MAX_RPC_BYTES);
    // The runtime receives no inherited API tokens or Azure credentials.
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', FOUNDRY_WORKSPACE_DATA: this.dataDirectory, ...this.extraEnvironment };
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE', 'APPDATA', 'HOME']) if (process.env[name]) env[name] = process.env[name];
    const child = spawn(process.execPath, [this.runtimePath], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Runtime diagnostics are intentionally bounded and contain no provider payloads.
    child.stderr.on('data', () => { /* UI receives only the exit state. */ });
    child.on('error', () => this.fail());
    child.on('exit', () => { this.child = undefined; this.fail(); if (!this.closed) this.onExit(); });
  }
  private fail(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('The runtime stopped. Restart the application to recover saved tasks.')); }
    this.pending.clear();
  }
  private receive(chunk: string): void {
    let lines: string[];
    try { lines = this.decoder.push(chunk); } catch { this.child?.kill(); return; }
    for (const line of lines) {
      try {
        const data: unknown = JSON.parse(line);
        const event = EventSchema.safeParse(data);
        if (event.success) { this.onEvent(event.data.params); continue; }
        const response = RpcResponseSchema.parse(data);
        const request = this.pending.get(response.id); if (!request) continue;
        clearTimeout(request.timer); this.pending.delete(response.id);
        if ('error' in response) request.reject(new Error(response.error.message)); else request.resolve(response.result);
      } catch { this.child?.kill(); return; }
    }
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error('The runtime is not available. Restart the application.'));
    const id = randomUUID(); const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (Buffer.byteLength(payload) > MAX_RPC_BYTES) return Promise.reject(new Error('Request exceeds the allowed size.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Runtime request timed out. Its outcome may be unknown; do not blindly retry a task creation.')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(payload, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Could not communicate with the runtime.')); } });
    });
  }
  async stop(): Promise<void> {
    this.closed = true;
    const child = this.child; if (!child) return;
    child.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 45000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
