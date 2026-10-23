// Deterministic stdio MCP fixture used by integration, E2E and packaged smoke tests. No network access.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const notesPath = process.env.MCP_FIXTURE_NOTES || join(process.cwd(), 'fixture-notes.txt');
const tools = [
  { name: 'echo', description: 'Echo the given text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'write_note', description: 'Append a line to the fixture notes file (state changing).', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'slow', description: 'Wait for the given milliseconds.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] }, annotations: { readOnlyHint: true } },
  { name: 'spawn_child', description: 'Spawn a long-lived descendant process and return its pid.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'secret_echo', description: 'Return the fixture canary from the environment.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'huge', description: 'Return a large text block.', inputSchema: { type: 'object', properties: { bytes: { type: 'number' } }, required: ['bytes'] }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Return an error result.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'bad.name', description: 'Unsupported tool name that must be skipped.', inputSchema: { type: 'object', properties: {} } }
];
const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], isError });
async function call(name, args) {
  switch (name) {
    case 'echo': return text(`echo: ${String(args.text)}`);
    case 'write_note': appendFileSync(notesPath, `${String(args.text)}\n`); return text(`note written to ${notesPath}`);
    case 'slow': await new Promise(resolve => setTimeout(resolve, Number(args.ms))); return text('slept');
    case 'spawn_child': { const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true }); child.unref(); return text(JSON.stringify({ pid: child.pid })); }
    case 'secret_echo': return text(`canary=${process.env.MCP_FIXTURE_CANARY ?? 'mcp-canary-secret-value-8899'}`);
    case 'huge': return text('x'.repeat(Number(args.bytes)));
    case 'fail': return text('fixture failure', true);
    case 'malformed': return 'not-an-object';
    case 'break_transport': {
      appendFileSync(notesPath, 'mutation-before-broken-frame\n');
      process.stdout.write(args.kind === 'oversized' ? 'x'.repeat(1024 * 1024 + 10) + '\n' : args.kind === 'non-jsonrpc' ? '{"jsonrpc":"1.0","id":"broken"}\n' : '{not json\n');
      return new Promise(() => {});
    }
    case 'barrier_write': {
      const tag = String(args.tag); const release = process.env.MCP_FIXTURE_RELEASE;
      if (!release) throw new Error('The lifecycle fixture requires a release marker.');
      const childSource = `
        const { appendFileSync, existsSync, watch } = require('node:fs');
        const { dirname } = require('node:path');
        const release = ${JSON.stringify(release)};
        let released = false;
        const finish = () => { if (!released && existsSync(release)) { released = true; watcher.close(); appendFileSync(${JSON.stringify(notesPath)}, ${JSON.stringify(tag + ':child-effect\n')}); } };
        const watcher = watch(dirname(release), finish);
        appendFileSync(${JSON.stringify(notesPath)}, JSON.stringify({ tag: ${JSON.stringify(tag)}, actor: 'child', pid: process.pid }) + '\\n');
        finish();
      `;
      const child = spawn(process.execPath, ['-e', childSource], { stdio: 'ignore', windowsHide: true });
      child.unref();
      await new Promise(resolve => {
        const check = () => { if (existsSync(release)) { watcher.close(); resolve(); } };
        const watcher = watch(dirname(release), check);
        appendFileSync(notesPath, JSON.stringify({ tag, actor: 'server', pid: process.pid }) + '\n');
        check();
      });
      appendFileSync(notesPath, tag + ':server-effect\n'); return text('effect complete');
    }
    default: throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  }
}
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  const reply = async () => {
    if (method === 'initialize') return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'foundry-fixture', version: '1.0.0' } };
    if (method === 'ping') return {};
    if (method === 'tools/list') {
      if (process.env.MCP_FIXTURE_PAGINATE === 'loop') {
        return { tools: [{ name: 'loop_tool', inputSchema: { type: 'object' } }], nextCursor: 'stuck-cursor' };
      }
      if (process.env.MCP_FIXTURE_PAGINATE === '1') {
        if (params?.cursor === 'page-2') return { tools: [{ name: 'page2_tool', inputSchema: { type: 'object' } }] };
        return { tools: [{ name: 'page1_tool', inputSchema: { type: 'object' } }], nextCursor: 'page-2' };
      }
      if (process.env.MCP_FIXTURE_MALFORMED === '1') {
        return { tools: [...tools, { name: 'malformed', description: 'Return a non-object call result.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      }
      if (process.env.MCP_FIXTURE_LIFECYCLE === '1') {
        return { tools: [...tools, ...['break_transport', 'barrier_write'].map(name => ({ name, inputSchema: { type: 'object' } }))] };
      }
      return { tools };
    }
    if (method === 'tools/call') return call(params?.name, params?.arguments ?? {});
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  };
  if (id === undefined) return; // notification
  reply().then(result => write({ jsonrpc: '2.0', id, result })).catch(error => write({ jsonrpc: '2.0', id, error: { code: error.code ?? -32000, message: error.message } }));
});
rl.on('close', () => process.exit(0));
process.stderr.write('fixture server ready\n');
