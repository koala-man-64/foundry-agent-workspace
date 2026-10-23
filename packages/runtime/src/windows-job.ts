import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandResult } from './command-runner';

export const MAX_WINDOWS_JOB_STDIN_BYTES = 256 * 1024;
const HELPER_GRACE_MS = 10_000;
const HELPER_STARTUP_MS = 60_000;
const MAX_HELPER_ERROR_BYTES = 8 * 1024;

/** Internal supervision only. The caller must own the execution capability and fixed/approved command. */
export interface WindowsJobSpec {
  shell: string; command: string; cwd: string; environment: Record<string, string>; timeoutMs: number;
  nonce: string; resultPath: string; cancelPath: string; stdinBytesBase64?: string;
}
export interface WindowsJobResult extends CommandResult { nonce: string; stdinDelivered?: boolean }

/** Reject permissive/noncanonical base64 before spawning even the supervisor. */
export function validateWindowsJobStdin(value: string | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_WINDOWS_JOB_STDIN_BYTES / 3) * 4) throw new Error('Windows job input exceeds the bounded byte limit or is not base64.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_WINDOWS_JOB_STDIN_BYTES || bytes.toString('base64') !== value) throw new Error('Windows job input must be canonical base64 within the bounded byte limit.');
}

export function resolveWindowsJobHelperPath(): string {
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'job-runner.ps1');
  const marker = `${path.sep}app.asar${path.sep}`;
  return source.toLowerCase().includes(marker.toLowerCase())
    ? source.replace(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${path.sep}app.asar.unpacked${path.sep}`)
    : source;
}

/** Reuses the kill-on-close Windows Job helper; this function grants no execution authority. */
export async function runWindowsJob(helperPath: string, spec: WindowsJobSpec, signal: AbortSignal): Promise<WindowsJobResult> {
  validateWindowsJobStdin(spec.stdinBytesBase64);
  if (signal.aborted) throw abortError(signal);
  const helperSpec = { ...spec, parentPid: process.pid, parentStartedAtMs: Math.floor(Date.now() - process.uptime() * 1000) };
  const child = spawn(spec.shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, env: spec.environment });
  let helperError = '';
  child.stderr.on('data', (chunk: Buffer) => { if (helperError.length < MAX_HELPER_ERROR_BYTES) helperError += chunk.toString('utf8').slice(0, MAX_HELPER_ERROR_BYTES - helperError.length); });
  // An early helper rejection must not turn a broken input pipe into an unhandled process error.
  child.stdin.on('error', () => undefined);
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const cancel = () => fs.writeFile(spec.cancelPath, 'cancelled', { flag: 'w' }).catch(() => undefined);
  const onAbort = () => { void cancel(); };
  signal.addEventListener('abort', onAbort, { once: true });
  let watchdogFired = false;
  const watchdog = setTimeout(() => { watchdogFired = true; child.kill(); }, spec.timeoutMs + HELPER_STARTUP_MS + HELPER_GRACE_MS);
  try {
    // The helper is still waiting for its JSON: a cancellation already observed here
    // is persisted before giving it anything it could launch.
    if (signal.aborted) await cancel();
    child.stdin.end(JSON.stringify(helperSpec));
    const exitCode = await closed;
    const raw = await fs.readFile(spec.resultPath, 'utf8').catch(() => undefined);
    if (!raw) {
      if (signal.aborted) return { nonce: spec.nonce, stdout: '', stderr: boundedText(helperError), exitCode, cancelled: true, timedOut: false, cleanupVerified: false };
      if (watchdogFired) return { nonce: spec.nonce, stdout: '', stderr: boundedText(helperError), exitCode, cancelled: false, timedOut: true, cleanupVerified: false };
      throw new Error(`Command helper exited without a verified result${helperError ? `: ${boundedText(helperError)}` : '.'}`);
    }
    const result = JSON.parse(raw) as WindowsJobResult;
    if (result.nonce !== spec.nonce || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) || typeof result.cancelled !== 'boolean' || typeof result.timedOut !== 'boolean' || typeof result.cleanupVerified !== 'boolean') throw new Error('Command helper returned an untrusted result.');
    if (spec.stdinBytesBase64 !== undefined && !result.cancelled && !result.timedOut && result.stdinDelivered !== true) throw new Error('Windows job input delivery was not confirmed; do not retry the operation blindly.');
    return result;
  } finally {
    clearTimeout(watchdog);
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) await cancel();
  }
}

function boundedText(value: string): string { return value.length <= 64 * 1024 ? value : `${value.slice(0, 64 * 1024)}\n[output truncated]`; }
function abortError(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'); }
