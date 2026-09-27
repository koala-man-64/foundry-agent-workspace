import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { McpClient, McpError, canonicalizeContainmentPath, composeName } from '../src/mcp';

describe('MCP path containment', () => {
  it('canonicalizes an aliased ancestor when the final argument does not exist', async () => {
    const alias = path.resolve('fixture', 'SHORT~1', 'worktrees');
    const canonical = path.resolve('fixture', 'Long Profile', 'worktrees');
    const missing = Object.assign(new Error('Missing path'), { code: 'ENOENT' });
    const realpath = async (candidate: string): Promise<string> => candidate === alias ? canonical : Promise.reject(missing);
    await expect(canonicalizeContainmentPath(path.join(alias, 'new', 'script.js'), realpath)).resolves.toBe(path.join(canonical, 'new', 'script.js'));
  });
  it('fails closed when an existing ancestor cannot be inspected', async () => {
    const denied = Object.assign(new Error('Denied'), { code: 'EACCES' });
    await expect(canonicalizeContainmentPath(path.resolve('fixture', 'private', 'script.js'), async () => { throw denied; })).rejects.toBe(denied);
  });
});

function pair(): { client: McpClient; fromClient: PassThrough; toClient: PassThrough; errors: Error[] } {
  const fromClient = new PassThrough(); const toClient = new PassThrough(); const errors: Error[] = [];
  return { client: new McpClient(fromClient, toClient, error => errors.push(error)), fromClient, toClient, errors };
}
const lines = (stream: PassThrough): string[] => stream.read()?.toString('utf8').split('\n').filter(Boolean) ?? [];

describe('MCP JSON-RPC client', () => {
  it('counts stdout transport progress without retaining reply content or identifiers', async () => {
    const { client, fromClient, toClient } = pair();
    const pending = client.request('initialize', {}, 1000);
    const [sent] = lines(fromClient);
    const id = (JSON.parse(sent!) as { id: string }).id;
    const secret = 'private-canary-do-not-log';
    const reply = JSON.stringify({ jsonrpc: '2.0', id, result: { value: secret } }) + '\n';
    const unmatched = JSON.stringify({ jsonrpc: '2.0', id: 'not-pending', result: secret }) + '\n';
    const split = Math.floor(reply.length / 2);
    toClient.write(reply.slice(0, split));
    toClient.write(reply.slice(split) + unmatched);
    await expect(pending).resolves.toEqual({ value: secret });
    const diagnostics = client.diagnostics;
    expect(diagnostics).toMatchObject({
      receivedBytes: Buffer.byteLength(reply + unmatched, 'utf8'),
      receivedChunks: 2,
      completedFrames: 2,
      matchedReplies: 1,
      unmatchedReplies: 1
    });
    expect(diagnostics.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.firstChunkMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.firstFrameMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.firstMatchedReplyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(JSON.stringify(diagnostics)).not.toContain('not-pending');
    expect(Object.keys(diagnostics).sort()).toEqual([
      'elapsedMs', 'firstChunkMs', 'firstFrameMs', 'firstMatchedReplyMs',
      'receivedBytes', 'receivedChunks', 'completedFrames', 'matchedReplies', 'unmatchedReplies'
    ].sort());
    expect(JSON.stringify(diagnostics)).not.toContain('initialize');
  });

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
  it('handles writable transport errors without crashing and rejects in-flight calls as unknown', async () => {
    const { client, fromClient, errors } = pair();
    const pending = client.request('tools/call', { name: 'in_flight' }, 1000);
    const writeError = new Error('EPIPE: broken pipe');
    fromClient.emit('error', writeError);
    await expect(pending).rejects.toMatchObject({ name: 'McpError', unknownOutcome: true, message: expect.stringContaining('write failed') });
    expect(client.isClosed).toBe(true);
    expect(errors.some(err => err.message.includes('write failed'))).toBe(true);
  });
});
