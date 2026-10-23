import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import type { McpServerConfig } from '../../protocol/src/index';
import { McpClient, McpManager, type McpHostResult, type McpProcess } from '../src/mcp';
import { Redactor } from '../src/redaction';

function runningSession(stop: () => Promise<McpHostResult | undefined>) {
  const config: McpServerConfig = { id: randomUUID(), key: 'fixture', name: 'Fixture', command: 'C:\\fixture.exe', arguments: [], cwd: '', environment: {}, enabled: true, readOnlyTools: [], callTimeoutMs: 1000 };
  const output = new PassThrough(); const input = new PassThrough();
  const client = new McpClient(output, input);
  const manager = new McpManager(() => [], new Redactor());
  const fingerprint = createHash('sha256').update(JSON.stringify([config.command, config.arguments, config.cwd, config.environment])).digest('hex');
  manager['sessions'].set(config.id, { config, fingerprint, client, process: { running: true, stop } as unknown as McpProcess, tools: [{ name: 'mutate', description: '', inputSchema: {}, readOnlyHint: false }], serverInfo: null, busy: 0 });
  return { manager, config, output };
}

describe('MCP session cleanup', () => {
  it('does not dispatch or stop a shared session when cancelled while awaiting it', async () => {
    const stop = vi.fn(async () => undefined);
    const { manager, config, output } = runningSession(stop);
    const abort = new AbortController();
    const pending = manager.call(config, 'mutate', {}, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'McpError', unknownOutcome: false });
    expect(output.read()).toBe(null);
    expect(stop).not.toHaveBeenCalled();
    expect(manager.statusOf(config.id).running).toBe(true);
    await manager.shutdown();
  });

  it('keeps every interrupted caller waiting for the same verified host stop', async () => {
    let finish!: (result: McpHostResult) => void;
    const stop = vi.fn(() => new Promise<McpHostResult>(resolve => { finish = resolve; }));
    const { manager, config, output } = runningSession(stop);
    const abort = new AbortController(); let firstSettled = false; let secondSettled = false;
    const first = manager.call(config, 'mutate', {}, abort.signal).catch(error => { firstSettled = true; return error as unknown; });
    const second = manager.call(config, 'mutate', {}, new AbortController().signal).catch(error => { secondSettled = true; return error as unknown; });
    await new Promise(resolve => setImmediate(resolve));
    expect(output.read()?.toString().split('\n').filter(Boolean)).toHaveLength(2);
    abort.abort(); await new Promise(resolve => setImmediate(resolve));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(firstSettled).toBe(false); expect(secondSettled).toBe(false);
    finish({ cleanupVerified: true, exitCode: null, cancelled: true, parentDied: false, lifetimeExpired: false, processId: 1, nonce: 'fixture' });
    await expect(first).resolves.toMatchObject({ name: 'McpError', unknownOutcome: true });
    await expect(second).resolves.toMatchObject({ name: 'McpError', unknownOutcome: true });
    expect(manager.statusOf(config.id)).toEqual({ running: false, lastError: null });
  });

  it.each([undefined, { cleanupVerified: false }])('retains a visible cleanup warning without verified host evidence (%#)', async result => {
    const { manager, config } = runningSession(async () => result as McpHostResult | undefined);
    await manager.stopServer(config.id);
    expect(manager.statusOf(config.id)).toMatchObject({ running: false, lastError: expect.stringContaining('could not verify') });
  });
});
