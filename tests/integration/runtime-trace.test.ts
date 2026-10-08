import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { HOST_TO_RUNTIME, RUNTIME_EXIT, RUNTIME_STDERR, RUNTIME_TO_HOST, TRACE_META, compareTraces, normalizeTrace, readTrace, traceRuntime, type TraceRecord } from '../../scripts/runtime-trace.mjs';

const fixture = fileURLToPath(new URL('./fixtures/trace-runtime.mjs', import.meta.url));
const script = fileURLToPath(new URL('../../scripts/runtime-trace.mjs', import.meta.url));
// Assembled at run time so the canary never appears in source a scan could match. The quote, backslash, control
// character and non-ASCII letter make its JSON-escaped form differ from the raw one; both must stay out of a trace.
// The random tail survives any amount of escaping, so finding it anywhere means some form of the value leaked.
const CANARY_TAIL = randomUUID().replaceAll('-', '');
const CANARY = ['trace"canary', '\\', '\u0007', 'é', CANARY_TAIL].join('-');
const ESCAPED = JSON.stringify(CANARY).slice(1, -1);
const BINDING = 'responses|https://user:secret@fixture.invalid/?key=1|deployment';

type Transport = 'text' | 'split' | 'base64' | 'bytes';

/** A driver like scripts/packaged-smoke.mjs: requests by id, stderr collected, browser.host answered inline. */
function drive(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let buffer = '';
  let errors = '';
  let sequence = 0;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { errors += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message: { id?: string; method?: string; result?: unknown; error?: { message: string } };
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'browser.host') { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, method: 'browser.host.result', result: [] })}\n`); continue; }
      const waiter = message.id === undefined ? undefined : pending.get(message.id);
      if (!waiter || message.id === undefined) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
    }
  });
  const exit = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  /** Every way a driver can hand a frame to a Node stream: a string, split Buffers, an encoded string, raw bytes. */
  const write = (line: string, transport: Transport) => {
    const bytes = Buffer.from(line);
    if (transport === 'text') child.stdin.write(line);
    else if (transport === 'base64') child.stdin.write(bytes.toString('base64'), 'base64');
    else if (transport === 'bytes') child.stdin.write(new Uint8Array(bytes));
    else for (let offset = 0; offset < bytes.length; offset += 7) child.stdin.write(bytes.subarray(offset, offset + 7));
  };
  const invoke = (method: string, params: unknown, transport: Transport = 'text') => new Promise<unknown>((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, { resolve, reject });
    write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, transport);
  });
  return { invoke, raw: (line: string) => write(line, 'text'), exit, errors: () => errors };
}

const fixtureProcess = (env: NodeJS.ProcessEnv = process.env) => spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
const stop = (child: ChildProcessWithoutNullStreams) => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
const record = (frame: unknown): TraceRecord => ({ n: 1, ms: 0, dir: RUNTIME_TO_HOST, frame });

async function recordScenario(): Promise<{ root: string; path: string; records: TraceRecord[]; text: string }> {
  const root = await mkdtemp(join(tmpdir(), 'foundry-trace-'));
  const path = join(root, 'traces', 'trace.jsonl');
  const child = fixtureProcess();
  const trace = traceRuntime(child, path, { roots: [root] });
  const runtime = drive(child);
  let traceError: Error | undefined;
  try {
    for (const transport of ['text', 'split', 'base64', 'bytes'] as const) {
      await runtime.invoke('runtime.credential', { id: randomUUID(), value: CANARY, binding: BINDING }, transport);
    }
    runtime.raw(`${JSON.stringify([{ jsonrpc: '2.0', id: 'batch', method: 'runtime.credential', params: { id: randomUUID(), value: CANARY, binding: BINDING } }])}\n`);
    runtime.raw(`{"jsonrpc":"2.0","id":"broken","method":"runtime.credential","params":{"value":${JSON.stringify(CANARY)}\n`);
    await runtime.invoke('demo.create', { path: join(root, 'Project') });
    expect(await runtime.invoke('demo.browser', {})).toEqual({ tabs: [] });
    await expect(runtime.invoke('demo.leak', {})).rejects.toThrow(CANARY); // The driver sees the leak; the trace must not.
    expect(await runtime.invoke('demo.noise', {})).toBe('noisy');
    expect(await runtime.invoke('demo.oversized', {})).toBe('survived');
    child.stdin.on('error', () => undefined);
    child.stdin.end('{"unterminated":');
    child.stdin.write('{"after":"end"}\n', () => undefined); // Refused by the ended stream, so never recorded.
    expect(await runtime.exit).toBe(0);
    expect(runtime.errors()).toContain('fixture diagnostics');
  } finally {
    traceError = trace.close();
    stop(child);
  }
  expect(traceError).toBeUndefined();
  return { root, path, records: readTrace(path), text: await readFile(path, 'utf8') };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('runtime stdio trace recorder', () => {
  it('records both directions, keeps credentials out of the file and normalizes runs to the same trace', async () => {
    const first = await recordScenario();
    const second = await recordScenario();
    try {
      for (const run of [first, second]) {
        expect(run.text).not.toContain(CANARY);
        expect(run.text).not.toContain(ESCAPED);
        expect(run.text).not.toContain(CANARY_TAIL);
        expect(run.text).not.toContain('user:secret');
        const records = run.records;
        expect(records[0]).toMatchObject({ n: 0, dir: TRACE_META, format: 1, roots: [run.root] });
        expect(records.map(item => item.n)).toEqual(records.map((_, index) => index));

        const frames = (direction: string) => records.filter(item => item.dir === direction && item.frame !== undefined).map(item => item.frame as Record<string, unknown>);
        const sent = frames(HOST_TO_RUNTIME);
        const received = frames(RUNTIME_TO_HOST);
        const credentials = sent.filter(frame => frame.method === 'runtime.credential');
        expect(credentials).toHaveLength(4);
        for (const frame of credentials) expect(frame).toMatchObject({ params: { value: '[REDACTED]', binding: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) } });
        expect(sent.find(Array.isArray)).toEqual([expect.objectContaining({ id: 'batch', params: expect.objectContaining({ value: '[REDACTED]' }) })]);
        expect(records.filter(item => item.unparsed !== undefined)).toEqual([
          expect.objectContaining({ dir: HOST_TO_RUNTIME, unparsed: expect.any(Number) }),
          expect.objectContaining({ dir: HOST_TO_RUNTIME, unparsed: 16, partial: true }),
        ]);
        expect(received.find(frame => frame.method === 'browser.host')).toMatchObject({ params: { kind: 'tabs' } });
        expect(sent.find(frame => frame.method === 'browser.host.result')).toMatchObject({ result: [] });
        expect(received.find(frame => (frame.error as { message?: string } | undefined)?.message?.startsWith('rejected key'))).toMatchObject({ error: { message: 'rejected key [REDACTED]' } });
        expect(run.text).not.toContain('"after"');

        expect(records).toContainEqual(expect.objectContaining({ dir: RUNTIME_TO_HOST, text: 'not json' }));
        expect(records).toContainEqual(expect.objectContaining({ dir: RUNTIME_STDERR, text: 'fixture diagnostics' }));
        expect(records.find(item => item.oversized !== undefined)).toMatchObject({ dir: RUNTIME_TO_HOST, oversized: 1024 * 1024 + 10 });
        expect(records.filter(item => item.dir === RUNTIME_EXIT)).toEqual([expect.objectContaining({ code: 0 })]);
        // 'close' follows the end of stdio: after the exit only the host fragment flushed by close() may appear.
        const exit = records.findIndex(item => item.dir === RUNTIME_EXIT);
        expect(records.slice(exit + 1)).toEqual([expect.objectContaining({ dir: HOST_TO_RUNTIME, partial: true })]);
      }

      const normalized = normalizeTrace(first.records);
      expect(normalizeTrace(second.records)).toEqual(normalized);
      const text = JSON.stringify(normalized);
      expect(text).toContain('<uuid:0>');
      expect(text).toContain('<time>');
      expect(text).toContain('<root:0>\\\\Project');
      expect(text).toMatch(/"summary":"<digest:\d+> at <git:0>"/);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(text).not.toMatch(/[0-9a-f]{40}/);

      const compare = spawnSync(process.execPath, [script, 'compare', first.path, second.path], { encoding: 'utf8', windowsHide: true });
      expect(compare.status, compare.stderr).toBe(0);
      expect(compare.stdout).toContain(`Equal: ${normalized.length} normalized records.`);
      const altered = normalizeTrace(second.records).map((item, index) => (index === 3 ? { ...(item as object), changed: true } : item));
      expect(compareTraces(normalized, altered).map(difference => difference.index)).toEqual([3]);
      expect(compareTraces(normalized, normalized.slice(0, -1))).toEqual([{ index: normalized.length - 1, left: normalized.at(-1), right: undefined }]);
    } finally {
      await rm(first.root, { recursive: true, force: true });
      await rm(second.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('leaves the driver every chunk it reads, however late it starts reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'foundry-trace-late-'));
    const path = join(root, 'late.jsonl');
    const child = fixtureProcess({ ...process.env, TRACE_FIXTURE_GREETING: '1' });
    const trace = traceRuntime(child, path, { roots: [root] });
    try {
      await delay(500); // The fixture has spoken, and nobody is reading yet.
      child.stdout.setEncoding('utf8');
      const greeting = await new Promise<string>(resolve => child.stdout.once('data', resolve));
      expect(greeting).toContain('fixture.ready');
      child.stdout.resume();
      child.stderr.resume();
      const closed = new Promise(resolve => child.once('close', resolve));
      child.stdin.end();
      await closed;
      expect(trace.close()).toBeUndefined();
      expect(readTrace(path)).toContainEqual(expect.objectContaining({ dir: RUNTIME_TO_HOST, frame: expect.objectContaining({ method: 'fixture.ready' }) }));
    } finally {
      trace.close();
      stop(child);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([HOST_TO_RUNTIME, RUNTIME_TO_HOST, RUNTIME_EXIT])('never throws into the driver when recording %s fails; close() reports it', async direction => {
    const root = await mkdtemp(join(tmpdir(), 'foundry-trace-failing-'));
    const path = join(root, 'failing.jsonl');
    const child = fixtureProcess();
    const trace = traceRuntime(child, path, { roots: [root] });
    const runtime = drive(child);
    const write = fs.writeSync;
    // The first failure happens on a record from the given direction; everything before it is written.
    vi.spyOn(fs, 'writeSync').mockImplementation(((file: number, data: string) => {
      if (typeof data === 'string' && data.includes(`"dir":"${direction}"`)) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return write(file, data);
    }) as typeof fs.writeSync);
    try {
      expect(await runtime.invoke('demo.noise', {})).toBe('noisy'); // Delivered and answered whatever the trace does.
      child.stdin.end();
      expect(await runtime.exit).toBe(0);
      const failure = trace.close();
      expect(failure).toMatchObject({ code: 'ENOSPC' });
      expect(trace.close()).toBe(failure);
      expect(readTrace(path).some(item => item.dir === direction)).toBe(false); // Recording stopped at the failure.
    } finally {
      vi.restoreAllMocks();
      trace.close();
      stop(child);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses to append to an earlier run and to compare traces that cannot stand for a run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'foundry-trace-stale-'));
    const stale = join(root, 'stale.jsonl');
    await writeFile(stale, 'earlier run\n');
    const child = fixtureProcess();
    try {
      expect(() => traceRuntime(child, stale)).toThrow(/EEXIST/);
      expect(await readFile(stale, 'utf8')).toBe('earlier run\n');
      const header = join(root, 'header.jsonl');
      await writeFile(header, `${JSON.stringify({ n: 0, ms: 0, dir: TRACE_META, format: 1, roots: [] })}\n`);
      const compare = spawnSync(process.execPath, [script, 'compare', header, header], { encoding: 'utf8', windowsHide: true });
      expect(compare.status).toBe(3);
      expect(compare.stderr).toContain('holds no records');
    } finally {
      stop(child);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('numbers ids the same whatever order a runtime emits keys in, and still sees ids that move', () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const typescript = normalizeTrace([record({ result: { taskId: a, rootTaskId: b, map: { [a]: 1, [b]: 2 } } })]);
    const csharp = normalizeTrace([record({ result: { rootTaskId: b, taskId: a, map: { [a]: 1, [b]: 2 } } })]);
    expect(csharp).toEqual(typescript);
    const owner = (id: string) => normalizeTrace([record({ id: a }), record({ id: b }), record({ owner: id })]);
    expect(compareTraces(owner(a), owner(b)).map(difference => difference.index)).toEqual([2]);
  });

  it('masks only the persisted millisecond timestamp, so another precision shows as a difference', () => {
    const millisecond = normalizeTrace([record({ at: '2026-10-08T12:00:00.000Z' })]);
    const tick = normalizeTrace([record({ at: '2026-10-08T12:00:00.0000000Z' })]);
    expect(millisecond).toEqual([{ dir: RUNTIME_TO_HOST, frame: { at: '<time>' } }]);
    expect(compareTraces(millisecond, tick)).toHaveLength(1);
  });
});
