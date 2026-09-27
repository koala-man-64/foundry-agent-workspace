import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BrowserHostCallSchema, BrowserHostError, BrowserHostReplySchema, BrowserInvalidationSchema, MAX_RPC_BYTES, RpcRequestSchema } from '../../protocol/src/index';
import type { BrowserHost, BrowserHostRequest, BrowserHostResult, RpcResponse } from '../../protocol/src/index';
import { LineDecoder } from '../../protocol/src/framing';
import { RepositoryService } from './repository';
import { RuntimeService } from './service';
import { Store } from './store';

const directory = process.env.FOUNDRY_WORKSPACE_DATA;
if (!directory) throw new Error('Runtime data directory is required.');
const output = (value: unknown): void => {
  let line = JSON.stringify(value);
  if (Buffer.byteLength(line) > MAX_RPC_BYTES) {
    const id = typeof value === 'object' && value !== null && 'id' in value ? value.id : null;
    line = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'The result exceeds the display limit. Retained data has not been deleted.' } });
  }
  process.stdout.write(line + '\n');
};
const browserPending = new Map<string, { resolve: (result: BrowserHostResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }>();
let transportClosing = false;
const browserHost: BrowserHost = { request(input: BrowserHostRequest, signal?: AbortSignal): Promise<BrowserHostResult> {
  if (transportClosing) return input.kind === 'revoke' ? Promise.resolve(null) : Promise.reject(new BrowserHostError('stale', 'Browser transport is closing.'));
  if (browserPending.size >= 32) return Promise.reject(new BrowserHostError('unknown', 'Browser host is busy.'));
  if (signal?.aborted) return Promise.reject(new BrowserHostError('stale', 'Browser request was cancelled before dispatch.'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error: Error): void => { const pending = browserPending.get(id); if (!pending) return; browserPending.delete(id); clearTimeout(pending.timer); pending.cleanup(); reject(error); };
    const onAbort = (): void => finish(new BrowserHostError('unknown', 'Browser request was cancelled; result may be unknown.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(new BrowserHostError('unknown', 'Browser host reply timed out; result may be unknown.')), 30_000);
    browserPending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', onAbort) });
    try { output(BrowserHostCallSchema.parse({ jsonrpc: '2.0', id, method: 'browser.host', params: input })); }
    catch (error) { finish(error instanceof Error ? error : new Error('Browser request could not be sent.')); }
  });
} };
const service = new RuntimeService(new Store(join(directory, 'workspace.db')), new RepositoryService(join(directory, 'wt')), event => output({ jsonrpc: '2.0', method: 'workspace.event', params: event }), undefined, undefined, { browserHost });
const CredentialSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.string(), method: z.literal('runtime.credential'), params: z.object({ id: z.string().uuid(), value: z.string().min(4).max(8192), binding: z.string().max(4096) }).strict() }).strict();
const decoder = new LineDecoder(MAX_RPC_BYTES);
let stopped = false;
const activeHandles = new Set<Promise<void>>();
const stop = async (): Promise<void> => {
  if (stopped) return;
  stopped = true;
  transportClosing = true;
  for (const [id, pending] of browserPending) { browserPending.delete(id); clearTimeout(pending.timer); pending.cleanup(); pending.reject(new BrowserHostError('unknown', 'Runtime is shutting down.')); }
  await service.shutdown();
  process.stdin.pause();
  await Promise.allSettled(activeHandles);
  process.exit(0);
};
async function handle(line: string): Promise<void> {
  let id = 'invalid';
  try {
    const input: unknown = JSON.parse(line);
    if (transportClosing) return;
    const browserReply = BrowserHostReplySchema.safeParse(input);
    if (browserReply.success) {
      const pending = browserPending.get(browserReply.data.id);
      if (!pending) return;
      browserPending.delete(browserReply.data.id); clearTimeout(pending.timer); pending.cleanup();
      if (browserReply.data.error) pending.reject(new BrowserHostError(browserReply.data.error.code, browserReply.data.error.message));
      else pending.resolve(browserReply.data.result!);
      return;
    }
    const invalidation = BrowserInvalidationSchema.safeParse(input);
    if (invalidation.success) { service.notifyBrowserInvalidated(invalidation.data.params.taskId, invalidation.data.params.tabId); return; }
    if (stopped) return;
    const credential = CredentialSchema.safeParse(input);
    if (credential.success) {
      id = credential.data.id; service.setCredential(credential.data.params.id, credential.data.params.value, credential.data.params.binding);
      await service.flushCredentialRepairs();
      output({ jsonrpc: '2.0', id, result: null }); return;
    }
    const request = RpcRequestSchema.parse(input); id = request.id;
    const result = await service.dispatch(request.method, request.params);
    output({ jsonrpc: '2.0', id, result } satisfies RpcResponse);
  } catch (error) {
    output({ jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof z.ZodError ? 'Invalid request.' : service.redactor.text(error instanceof Error ? error.message : 'Runtime request failed.') } } satisfies RpcResponse);
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  let lines: string[];
  try { lines = decoder.push(chunk); }
  catch { process.stderr.write('Oversized RPC input; runtime stopped.\n'); void stop(); return; }
  for (const line of lines) {
    if (line.trim()) {
      const operation = handle(line);
      activeHandles.add(operation);
      void operation.then(() => activeHandles.delete(operation), () => activeHandles.delete(operation));
    }
  }
});
process.stdin.on('end', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('uncaughtException', () => { process.stderr.write('Runtime failed unexpectedly; restart to reconcile retained state.\n'); process.exit(1); });
