// A stand-in runtime for tests/integration/runtime-trace.test.ts: newline-delimited JSON-RPC on stdio, random ids and
// timestamps, one host round trip, and the awkward cases a trace must survive. Output order is deterministic.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';

let buffer = '';
let sequence = 0;
let credential = '';
const waiting = new Map();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);

// With TRACE_FIXTURE_GREETING set, the fixture speaks first, before any driver has asked for output.
if (process.env.TRACE_FIXTURE_GREETING) send({ jsonrpc: '2.0', method: 'fixture.ready', params: {} });

async function handle(message) {
  if (Array.isArray(message) || typeof message !== 'object' || message === null) return; // No batches, as in the runtime.
  if (message.method === 'browser.host.result') { waiting.get(message.id)?.(message.result); return; }
  const { id, method, params } = message;
  if (method === 'runtime.credential') { credential = params.value; send({ jsonrpc: '2.0', id, result: null }); return; }
  if (method === 'demo.create') {
    const created = { id: randomUUID(), path: params.path, createdAt: new Date().toISOString() };
    // Like a fixture commit and a fingerprint over ids: random per run, each shown twice.
    const commit = randomBytes(20).toString('hex');
    const fingerprint = createHash('sha256').update(created.id).digest('hex');
    send({ jsonrpc: '2.0', method: 'workspace.event', params: { sequence: ++sequence, type: 'task.created', taskId: created.id, data: { path: params.path, commit }, createdAt: created.createdAt } });
    send({ jsonrpc: '2.0', id, result: { ...created, baseCommit: commit, fingerprint, summary: `${fingerprint} at ${commit}`, children: { [randomUUID()]: 'first', [randomUUID()]: 'second' } } });
    return;
  }
  if (method === 'demo.browser') {
    const call = randomUUID();
    const tabs = await new Promise(resolve => { waiting.set(call, resolve); send({ jsonrpc: '2.0', id: call, method: 'browser.host', params: { kind: 'tabs' } }); });
    send({ jsonrpc: '2.0', id, result: { tabs } });
    return;
  }
  if (method === 'demo.leak') { send({ jsonrpc: '2.0', id, error: { code: -32000, message: `rejected key ${credential}` } }); return; }
  if (method === 'demo.noise') {
    process.stdout.write('not json\n');
    process.stderr.write('fixture diagnostics\r\n');
    send({ jsonrpc: '2.0', id, result: 'noisy' });
    return;
  }
  if (method === 'demo.oversized') {
    process.stdout.write(`${'x'.repeat(1024 * 1024 + 10)}\n`);
    send({ jsonrpc: '2.0', id, result: 'survived' });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; } // Malformed input is dropped, as the runtime rejects it.
    void handle(message);
  }
});
// An unterminated trailing fragment is ignored, as the real runtime ignores input after the transport closes.
process.stdin.on('end', () => process.exit(0));
