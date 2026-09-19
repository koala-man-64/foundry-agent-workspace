import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { McpClient, McpError, composeName } from '../src/mcp';

function pair(): { client: McpClient; fromClient: PassThrough; toClient: PassThrough; errors: Error[] } {
  const fromClient = new PassThrough(); const toClient = new PassThrough(); const errors: Error[] = [];
  return { client: new McpClient(fromClient, toClient, error => errors.push(error)), fromClient, toClient, errors };
}
const lines = (stream: PassThrough): string[] => stream.read()?.toString('utf8').split('\n').filter(Boolean) ?? [];

describe('MCP JSON-RPC client', () => {
  it('correlates responses, ignores notifications, and refuses server-initiated requests', async () => {
    const { client, fromClient, toClient } = pair();
    const pending = client.request('tools/list', {}, 1000);
    const [sent] = lines(fromClient);
    const request = JSON.parse(sent!) as { id: string; method: string };
    expect(request.method).toBe('tools/list');
    toClient.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } }) + '\n');
    toClient.write(JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage', params: {} }) + '\n');
    toClient.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }) + '\n');
    await expect(pending).resolves.toEqual({ tools: [] });
    await new Promise(resolve => setImmediate(resolve));
    const refusal = lines(fromClient).map(line => JSON.parse(line) as { id: string; error?: { code: number } }).find(item => item.id === 'srv-1');
    expect(refusal?.error?.code).toBe(-32601);
    expect(client.notifications).toEqual([{ method: 'notifications/message', params: { level: 'info' } }]);
  });
  it('times out with an unknown-outcome error and surfaces server errors as known failures', async () => {
    const { client, fromClient, toClient } = pair();
    await expect(client.request('tools/call', { name: 'slow' }, 20)).rejects.toMatchObject({ name: 'McpError', unknownOutcome: true });
    const failing = client.request('tools/call', { name: 'x' }, 1000);
    const [, sent] = lines(fromClient);
    toClient.write(JSON.stringify({ jsonrpc: '2.0', id: (JSON.parse(sent!) as { id: string }).id, error: { code: -32602, message: 'bad params' } }) + '\n');
    await expect(failing).rejects.toMatchObject({ name: 'McpError', unknownOutcome: false, message: expect.stringContaining('-32602') });
  });
  it('closes on malformed or oversized frames and fails every pending request', async () => {
    const { client, toClient, errors } = pair();
    const pending = client.request('ping', {}, 1000);
    toClient.write('{not json\n');
    await expect(pending).rejects.toBeInstanceOf(McpError);
    expect(client.isClosed).toBe(true);
    expect(errors[0]?.message).toContain('malformed');
    const big = pair();
    const waiting = big.client.request('ping', {}, 1000);
    big.toClient.write('x'.repeat(1024 * 1024 + 10) + '\n');
    await expect(waiting).rejects.toThrow('size limit');
  });
  it('composes advertised names only within provider limits', () => {
    expect(composeName('fixture', 'echo')).toBe('mcp__fixture__echo');
    expect(composeName('fixture', 'bad.name')).toBeUndefined();
    expect(composeName('k'.repeat(32), 't'.repeat(30))).toBeUndefined();
  });
});
