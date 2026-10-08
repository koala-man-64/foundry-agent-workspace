// Records the stdio JSON-RPC conversation between a driver and a runtime child process, for the WPF migration's
// differential tests (docs/wpf-webview2-migration.md, "Verification strategy"): the same scenario recorded against the
// TypeScript and the C# runtime must normalize to the same trace. The tap runs inside the driver rather than as a
// proxy process: the transport bytes stay untouched, and killing the child still kills the runtime itself, so crash
// tests keep their meaning (on Windows, killing a proxy would orphan the runtime behind it). It observes what the
// driver writes and what the driver reads, without changing when the driver reads, and it never throws into the driver:
// the first failure stops recording and close() returns it.
//
// Record only isolated fixture runs, for example under test-results/ (git-ignored). Credential values never reach the
// file: runtime.credential frames are redacted, host lines that do not parse are recorded by size only, and any later
// appearance of a value a credential frame carried is scrubbed.
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

/** packages/protocol/src/index.ts MAX_RPC_BYTES: neither side accepts a longer line, so neither does the tap. */
const MAX_LINE_BYTES = 1024 * 1024;
const REDACTED = '[REDACTED]';

/** Directions as the desktop host sees them, plus the trace's own header. */
export const TRACE_META = 'trace-meta';
export const HOST_TO_RUNTIME = 'host->runtime';
export const RUNTIME_TO_HOST = 'runtime->host';
export const RUNTIME_STDERR = 'runtime-stderr';
export const RUNTIME_EXIT = 'runtime-exit';

/** Splits one direction into lines; an over-long line becomes a length-only marker. */
class LineSplitter {
  #decoder = new StringDecoder('utf8');
  #buffer = '';
  #bytes = 0;
  #discarding = false;

  constructor(onLine) { this.onLine = onLine; }

  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    let start = 0;
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
      this.#append(text.slice(start, end));
      this.#emit(false);
      start = end + 1;
    }
    this.#append(text.slice(start));
  }

  /** Whatever never ended with a newline, when the tap closes. */
  flush() {
    this.#append(this.#decoder.end());
    if (this.#discarding || this.#buffer.length > 0) this.#emit(true);
  }

  #emit(partial) {
    if (this.#discarding) this.onLine({ oversized: this.#bytes }, partial);
    else this.onLine({ line: this.#buffer.endsWith('\r') ? this.#buffer.slice(0, -1) : this.#buffer }, partial);
    this.#buffer = '';
    this.#bytes = 0;
    this.#discarding = false;
  }

  #append(text) {
    if (text.length === 0) return;
    this.#bytes += Buffer.byteLength(text);
    if (this.#discarding) return;
    if (this.#bytes > MAX_LINE_BYTES) { this.#discarding = true; this.#buffer = ''; return; }
    this.#buffer += text;
  }
}

/** Bytes a write call hands to the stream, decoded as the stream will send them; anything else is not data. */
function writtenBytes(chunk, encoding) {
  if (typeof chunk === 'string') return encoding && !/^utf-?8$/i.test(encoding) ? Buffer.from(chunk, encoding) : chunk;
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return undefined;
}

/**
 * Tap an already spawned runtime child: the frames the driver writes to its stdin while the stream is live, the stdout
 * frames and stderr lines the driver receives, and the exit, appended in observed order to a new file at `path` after a
 * header naming the run's scratch `roots` (for normalization). Returns `close()`, which detaches the tap, records any
 * unterminated line as partial, and returns the error that stopped recording, if any. Attach it before the first write.
 */
export function traceRuntime(child, path, { roots = [] } = {}) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const file = fs.openSync(path, 'wx'); // Never append to an earlier run's trace.
  const started = performance.now();
  const secrets = []; // JSON-escaped credential values, longest first so no shorter one leaves a tail behind.
  let count = 0;
  let failure;
  let open = true;

  const recording = () => open && failure === undefined;
  const serialize = record => {
    const header = { n: count, ms: Math.round(performance.now() - started) };
    let line;
    try { line = JSON.stringify({ ...header, ...record }); }
    catch { line = JSON.stringify({ ...header, dir: record.dir, unserializable: true }); }
    for (const secret of secrets) line = line.replaceAll(secret, REDACTED);
    return line;
  };
  const append = record => {
    if (!recording()) return;
    try {
      fs.writeSync(file, `${serialize(record)}\n`);
      count++;
    } catch (error) {
      failure = error;
    }
  };
  const guard = action => {
    if (!recording()) return;
    try { action(); } catch (error) { failure ??= error; }
  };

  const remember = value => {
    if (typeof value !== 'string' || value.length < 4) return; // Short values stay redacted in the frame only.
    secrets.push(JSON.stringify(value).slice(1, -1));
    secrets.sort((left, right) => right.length - left.length);
  };
  /** The credential frame the host sends by design: the value never reaches the file, and the binding (provider
   * configuration, whose endpoint could embed userinfo or a query) is recorded as a digest. Batches are redacted
   * element by element. */
  const redact = frame => {
    if (Array.isArray(frame)) return frame.map(redact);
    if (frame?.method !== 'runtime.credential' || typeof frame.params !== 'object' || frame.params === null) return frame;
    remember(frame.params.value);
    const binding = typeof frame.params.binding === 'string' ? `sha256:${createHash('sha256').update(frame.params.binding).digest('hex')}` : REDACTED;
    return { ...frame, params: { ...frame.params, value: REDACTED, binding } };
  };
  const splitter = direction => new LineSplitter((piece, partial) => {
    const extra = partial ? { partial: true } : {};
    if ('oversized' in piece) { append({ dir: direction, oversized: piece.oversized, ...extra }); return; }
    if (direction === RUNTIME_STDERR) { append({ dir: direction, text: piece.line, ...extra }); return; }
    let frame;
    try {
      frame = JSON.parse(piece.line);
    } catch {
      // A host line that does not parse could be a malformed credential frame: record its size, never its text.
      append(direction === HOST_TO_RUNTIME ? { dir: direction, unparsed: Buffer.byteLength(piece.line), ...extra } : { dir: direction, text: piece.line, ...extra });
      return;
    }
    append({ dir: direction, frame: direction === HOST_TO_RUNTIME ? redact(frame) : frame, ...extra });
  });
  const input = splitter(HOST_TO_RUNTIME);
  const output = splitter(RUNTIME_TO_HOST);
  const errors = splitter(RUNTIME_STDERR);
  append({ dir: TRACE_META, format: 1, roots });

  const write = child.stdin.write;
  const end = child.stdin.end;
  const observe = (chunk, encoding) => guard(() => {
    const bytes = writtenBytes(chunk, encoding);
    if (bytes !== undefined) input.push(bytes);
  });
  // Record only what a live stream accepted; the original call always runs first and its result passes through.
  child.stdin.write = function tracedWrite(chunk, ...rest) {
    const live = !this.destroyed && !this.writableEnded;
    const result = write.call(this, chunk, ...rest);
    if (live) observe(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
    return result;
  };
  child.stdin.end = function tracedEnd(chunk, ...rest) {
    const live = !this.destroyed && !this.writableEnded;
    const result = end.call(this, chunk, ...rest);
    if (live && typeof chunk !== 'function') observe(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
    return result;
  };
  // Wrapping emit sees each chunk as it is delivered to the driver, in the driver's form, without a listener of its own
  // that would switch the stream to flowing mode and consume output the driver has not asked for yet.
  const tapEmit = (stream, lines) => {
    const emit = stream.emit;
    stream.emit = function tracedEmit(event, ...args) {
      if (event === 'data') guard(() => lines.push(args[0]));
      return emit.call(this, event, ...args);
    };
    return () => { stream.emit = emit; };
  };
  const untapOutput = tapEmit(child.stdout, output);
  const untapErrors = tapEmit(child.stderr, errors);
  // 'close' follows the end of stdio, so the exit record comes after the last output line.
  const onClose = (code, signal) => guard(() => append({ dir: RUNTIME_EXIT, code, signal }));
  child.once('close', onClose);

  return {
    close() {
      if (!open) return failure;
      try {
        child.stdin.write = write;
        child.stdin.end = end;
        untapOutput();
        untapErrors();
        child.off('close', onClose);
        for (const pending of [input, output, errors]) guard(() => pending.flush());
      } finally {
        open = false;
        try { fs.closeSync(file); } catch (error) { failure ??= error; }
      }
      return failure;
    },
  };
}

/** The records of a trace file, in order. */
export function readTrace(path) {
  return fs.readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DIGEST = /\b[0-9a-f]{64}\b/g;
const GIT_OBJECT = /\b[0-9a-f]{40}\b/g;
// Exactly the persisted form (Clock.Iso): any other precision is a difference worth seeing.
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A comparable form of a trace. The header, record numbers and timings are dropped. Values the runtime derives from
 * randomness or the clock are numbered by first appearance, so equality structure is still compared: UUIDs, SHA-256
 * digests (many cover ids) and git object ids (fixture commits embed the time). Timestamps in the persisted
 * millisecond form are masked; the run's scratch roots (from the header unless given) are replaced case-insensitively
 * with either separator; object keys are sorted, because only the JSON values are contract. Keys are visited in sorted
 * order with their UUIDs masked, ties in emission order, so ids number the same whichever runtime emitted the object.
 * Record order is kept, so traces compare equal only for deterministic scenarios: sequential steps that wait on events
 * rather than polling, and fixed fixture names and tokens. Hash values themselves are pinned by tests/golden, not here.
 */
export function normalizeTrace(records, { roots = records.find(record => record.dir === TRACE_META)?.roots ?? [] } = {}) {
  const uuids = new Map();
  const digests = new Map();
  const objects = new Map();
  const numbered = (map, prefix) => match => {
    if (!map.has(match)) map.set(match, `<${prefix}:${map.size}>`);
    return map.get(match);
  };
  const rootPatterns = roots.map((root, index) => ({
    pattern: new RegExp(escapeRegExp(root).replace(/\\\\|\//g, '[\\\\/]'), 'gi'),
    replacement: `<root:${index}>`,
  }));
  const uuid = numbered(uuids, 'uuid');
  const text = value => {
    let result = value;
    for (const { pattern, replacement } of rootPatterns) result = result.replace(pattern, replacement);
    result = result.replace(UUID, match => uuid(match.toLowerCase()));
    result = result.replace(DIGEST, numbered(digests, 'digest')).replace(GIT_OBJECT, numbered(objects, 'git'));
    return result.replace(ISO_TIME, '<time>');
  };
  const shape = key => key.replace(UUID, '<uuid>').replace(DIGEST, '<digest>').replace(GIT_OBJECT, '<git>').replace(ISO_TIME, '<time>');
  const normalize = item => {
    if (typeof item === 'string') return text(item);
    if (Array.isArray(item)) return item.map(normalize);
    if (item === null || typeof item !== 'object') return item;
    const keys = Object.keys(item).map((key, index) => ({ key, index, shape: shape(key) }))
      .sort((left, right) => (left.shape < right.shape ? -1 : left.shape > right.shape ? 1 : left.index - right.index));
    return Object.fromEntries(keys.map(({ key }) => [text(key), normalize(item[key])]));
  };
  return records
    .filter(record => record.dir !== TRACE_META)
    .map(record => normalize(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'n' && key !== 'ms'))));
}

/** Indexes at which two normalized traces differ, with both sides (absent past the shorter end). */
export function compareTraces(left, right) {
  const differences = [];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const [a, b] = [JSON.stringify(left[index]), JSON.stringify(right[index])];
    if (a !== b) differences.push({ index, left: left[index], right: right[index] });
  }
  return differences;
}

/** Why a trace cannot stand for a run: nothing was recorded, or the runtime's exit never was. */
export function incompleteTrace(records) {
  if (!records.some(record => record.dir !== TRACE_META)) return 'it holds no records';
  if (!records.some(record => record.dir === RUNTIME_EXIT)) return 'it has no runtime exit';
  return undefined;
}

// As a command: node scripts/runtime-trace.mjs compare <a.jsonl> <b.jsonl> prints the first differences between the
// normalized traces. Exit code 0: equal; 1: different; 2: usage; 3: a trace is incomplete, so equality would mislead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, first, second] = process.argv.slice(2);
  if (command !== 'compare' || !first || !second) {
    console.error('Usage: node scripts/runtime-trace.mjs compare <a.jsonl> <b.jsonl>');
    process.exit(2);
  }
  const traces = [readTrace(first), readTrace(second)];
  for (const [index, records] of traces.entries()) {
    const reason = incompleteTrace(records);
    if (reason) { console.error(`${index === 0 ? first : second} is incomplete: ${reason}.`); process.exit(3); }
  }
  const [left, right] = traces.map(records => normalizeTrace(records));
  const differences = compareTraces(left, right);
  for (const { index, left: a, right: b } of differences.slice(0, 10)) {
    console.log(`#${index}\n  ${JSON.stringify(a)?.slice(0, 400)}\n  ${JSON.stringify(b)?.slice(0, 400)}`);
  }
  console.log(differences.length === 0 ? `Equal: ${left.length} normalized records.` : `${differences.length} of ${Math.max(left.length, right.length)} records differ.`);
  process.exit(differences.length === 0 ? 0 : 1);
}
