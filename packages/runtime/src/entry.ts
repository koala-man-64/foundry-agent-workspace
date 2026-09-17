import { join } from 'node:path';
import { z } from 'zod';
import { MAX_RPC_BYTES, RpcRequestSchema } from '../../protocol/src/index';
import type { RpcResponse } from '../../protocol/src/index';
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
const service = new RuntimeService(new Store(join(directory, 'workspace.db')), new RepositoryService(join(directory, 'wt')), event => output({ jsonrpc: '2.0', method: 'workspace.event', params: event }));
const CredentialSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.string(), method: z.literal('runtime.credential'), params: z.object({ id: z.string().uuid(), value: z.string().min(4).max(8192), binding: z.string().max(4096) }).strict() }).strict();
const decoder = new LineDecoder(MAX_RPC_BYTES);
let stopped = false;
const activeHandles = new Set<Promise<void>>();
const stop = async (): Promise<void> => {
  if (stopped) return;
  stopped = true;
  process.stdin.pause();
  await service.shutdown();
  await Promise.allSettled(activeHandles);
  process.exit(0);
};
async function handle(line: string): Promise<void> {
  let id = 'invalid';
  try {
    const input: unknown = JSON.parse(line);
    const credential = CredentialSchema.safeParse(input);
    if (credential.success) {
      id = credential.data.id; service.setCredential(credential.data.params.id, credential.data.params.value, credential.data.params.binding);
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
    if (line.trim() && !stopped) {
      const operation = handle(line);
      activeHandles.add(operation);
      void operation.then(() => activeHandles.delete(operation), () => activeHandles.delete(operation));
    }
  }
});
process.stdin.on('end', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('uncaughtException', () => { process.stderr.write('Runtime failed unexpectedly; restart to reconcile retained state.\n'); process.exit(1); });
