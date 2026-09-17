import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_COMMAND_CHARS = 64 * 1024;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_VALUE_CHARS = 4 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const HELPER_GRACE_MS = 10_000;
const MAX_HELPER_ERROR_BYTES = 8 * 1024;
const MAX_STATE_FILES = 10_000;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_ENVIRONMENT = /(?:credential|secret|token|password|authorization|api[_-]?key|cookie|proxy|node_options)/i;
const RESERVED_ENVIRONMENT = /^(?:path|comspec|systemroot|windir|pathext|psmodulepath)$/i;

export interface PreparedCommand {
  command: string;
  cwd: string;
  shell: string;
  environment: Record<string, string>;
  timeoutMs: number;
  fingerprint: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  cleanupVerified: boolean;
}

interface PreparedRecord { root: string; relativeCwd: string; changes: Record<string, string>; prepared: PreparedCommand; }
interface HelperResult extends CommandResult { nonce: string; }

/** A rejected command before the helper can launch any user command. */
export class CommandPreflightError extends Error {
  public readonly outcome = 'none' as const;
  public constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'CommandPreflightError'; }
}

/** Executes an already-approved Windows PowerShell command in a kill-on-close Job Object. */
export class CommandRunner {
  private readonly prepared = new Map<string, PreparedRecord>();
  private readonly helperPath: string;

  public constructor(helperPath?: string) {
    this.helperPath = path.resolve(helperPath ?? unpackedHelperPath());
  }

  public async prepare(root: string, args: { command: string; cwd: string; environment: Record<string, string>; timeoutMs: number }): Promise<PreparedCommand> {
    return this.prepareInternal(root, args, true);
  }

  public discard(prepared: PreparedCommand): void { this.prepared.delete(prepared.fingerprint); }

  private async prepareInternal(root: string, args: { command: string; cwd: string; environment: Record<string, string>; timeoutMs: number }, retain: boolean): Promise<PreparedCommand> {
    this.validateArgs(args);
    const safeRoot = await this.canonicalDirectory(root, 'Root');
    const { cwd, relativeCwd } = await this.canonicalWorktreeDirectory(safeRoot, args.cwd);
    const shell = await this.resolveWindowsPowerShell(safeRoot);
    const environment = this.minimalEnvironment(args.environment);
    const state = await this.worktreeState(safeRoot);
    const shellHash = await hashFile(shell);
    const prepared: PreparedCommand = {
      command: args.command,
      cwd,
      shell,
      environment,
      timeoutMs: args.timeoutMs,
      fingerprint: fingerprint({ command: args.command, cwd, shell, shellHash, environment, timeoutMs: args.timeoutMs, state }),
    };
    if (retain) this.prepared.set(prepared.fingerprint, { root: safeRoot, relativeCwd, changes: { ...args.environment }, prepared });
    return prepared;
  }

  public async execute(prepared: PreparedCommand, signal: AbortSignal): Promise<CommandResult> {
    let helper: string; let directory: string;
    try {
      const record = this.prepared.get(prepared.fingerprint);
      if (!record || !samePrepared(record.prepared, prepared)) throw new Error('Prepared command is unknown or has changed.');
      // Consume before the first await so a second caller cannot replay this capability.
      this.prepared.delete(prepared.fingerprint);
      const refreshed = await this.prepareInternal(record.root, { command: prepared.command, cwd: record.relativeCwd, environment: record.changes, timeoutMs: prepared.timeoutMs }, false);
      if (refreshed.fingerprint !== prepared.fingerprint) throw new Error('Prepared command fingerprint is stale; request approval again.');
      if (signal.aborted) throw abortError(signal);
      helper = await this.resolveHelper(record.root);
      if (signal.aborted) throw abortError(signal);
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-command-'));
      if (signal.aborted) { await fs.rm(directory, { recursive: true, force: true }); throw abortError(signal); }
    } catch (error) {
      if (error instanceof CommandPreflightError) throw error;
      throw new CommandPreflightError(error instanceof Error ? error.message : 'Command preflight failed.', { cause: error });
    }
    const resultPath = path.join(directory, 'result.json');
    const cancelPath = path.join(directory, 'cancel');
    const nonce = randomUUID();
    try {
      const result = await this.runHelper(helper, { ...prepared, nonce, resultPath, cancelPath }, signal);
      if (result.nonce !== nonce) throw new Error('Command helper returned an untrusted result.');
      return {
        stdout: boundedText(result.stdout),
        stderr: boundedText(result.stderr),
        exitCode: result.exitCode,
        cancelled: result.cancelled,
        timedOut: result.timedOut,
        cleanupVerified: result.cleanupVerified,
      };
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      this.prepared.delete(prepared.fingerprint);
    }
  }

  private validateArgs(args: { command: string; cwd: string; environment: Record<string, string>; timeoutMs: number }): void {
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > MAX_COMMAND_CHARS || args.command.includes('\0')) throw new Error('Command must be non-empty, NUL-free, and within the size limit.');
    if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > MAX_TIMEOUT_MS) throw new Error('Timeout must be an integer from 1 through 600000 milliseconds.');
    const entries = Object.entries(args.environment);
    if (entries.length > MAX_ENV_ENTRIES) throw new Error('Too many environment variables were requested.');
    for (const [key, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || RESERVED_ENVIRONMENT.test(key) || FORBIDDEN_ENVIRONMENT.test(key)) throw new Error(`Environment variable ${key} is not permitted.`);
      if (typeof value !== 'string' || value.length > MAX_ENV_VALUE_CHARS || value.includes('\0')) throw new Error(`Environment variable ${key} has an invalid value.`);
    }
  }

  private async canonicalDirectory(value: string, label: string): Promise<string> {
    if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
    const resolved = await fs.realpath(value);
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error(`${label} must be a directory.`);
    return resolved;
  }

  private async canonicalWorktreeDirectory(root: string, relativePath: string): Promise<{ cwd: string; relativeCwd: string }> {
    if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
      throw new Error('Working directory must be a worktree-relative path.');
    }
    const normalized = relativePath.replaceAll('\\', '/');
    if (normalized.split('/').some((segment) => segment === '..')) throw new Error('Working directory must not traverse outside the worktree.');
    const cwd = await this.canonicalDirectory(path.resolve(root, normalized || '.'), 'Working directory');
    if (!isInside(root, cwd)) throw new Error('Working directory must remain inside the approved root.');
    return { cwd, relativeCwd: path.relative(root, cwd).split(path.sep).join('/') };
  }

  private minimalEnvironment(changes: Record<string, string>): Record<string, string> {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('SystemRoot is unavailable.');
    const temp = process.env.TEMP ?? process.env.TMP ?? path.join(systemRoot, 'Temp');
    const userProfile = process.env.USERPROFILE ?? path.dirname(temp);
    const environment: Record<string, string> = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      PATH: [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
      TEMP: temp,
      TMP: temp,
      USERPROFILE: userProfile,
    };
    return Object.fromEntries(Object.entries({ ...environment, ...changes }).sort(([left], [right]) => left.localeCompare(right)));
  }

  private async resolveWindowsPowerShell(root: string): Promise<string> {
    if (process.platform !== 'win32') throw new Error('Command execution is supported only on Windows.');
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error('SystemRoot is unavailable.');
    const shell = await fs.realpath(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    if (isInside(root, shell)) throw new Error('PowerShell executable must not resolve inside the approved root.');
    if (!(await fs.stat(shell)).isFile()) throw new Error('Windows PowerShell executable is unavailable.');
    return shell;
  }

  private async resolveHelper(root: string): Promise<string> {
    const helper = await fs.realpath(this.helperPath);
    if (!isInside(path.dirname(helper), helper) || isInside(root, helper)) throw new Error('Command helper must be an app-owned file outside the approved root.');
    return helper;
  }

  private async worktreeState(root: string): Promise<string> {
    const git = await resolveExecutable('git.exe', root);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const options = { cwd: root, env, windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 };
    const [head, status] = await Promise.all([
      execFile(git, ['--no-pager', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=', '-c', 'credential.helper=', 'rev-parse', '--verify', 'HEAD^{commit}'], options),
      execFile(git, ['--literal-pathspecs', '--no-pager', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=', '-c', 'credential.helper=', 'status', '--porcelain=v1', '-z'], options),
    ]);
    return `${head.stdout.trim()}\0${status.stdout}\0${await this.contentState(root)}`;
  }

  private async contentState(root: string): Promise<string> {
    const digest = createHash('sha256');
    let files = 0;
    let bytes = 0;
    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const target = path.join(directory, entry.name);
        const relative = path.relative(root, target).split(path.sep).join('/');
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) { digest.update(`L\0${relative}\0${await fs.readlink(target)}\0`); continue; }
        if (stat.isDirectory()) { digest.update(`D\0${relative}\0`); await visit(target); continue; }
        if (!stat.isFile()) continue;
        files += 1;
        bytes += stat.size;
        if (files > MAX_STATE_FILES || bytes > MAX_STATE_BYTES) throw new Error('Worktree is too large to fingerprint safely.');
        digest.update(`F\0${relative}\0${stat.size}\0`);
        digest.update(await fs.readFile(target));
      }
    };
    await visit(root);
    return digest.digest('hex');
  }

  private async runHelper(helper: string, spec: PreparedCommand & { nonce: string; resultPath: string; cancelPath: string }, signal: AbortSignal): Promise<HelperResult> {
    if (signal.aborted) throw abortError(signal);
    const helperSpec = { ...spec, parentPid: process.pid, parentStartedAtMs: Math.floor(Date.now() - process.uptime() * 1000) };
    const child = spawn(spec.shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, env: spec.environment });
    let helperError = '';
    child.stderr?.on('data', (chunk: Buffer) => { if (helperError.length < MAX_HELPER_ERROR_BYTES) helperError += chunk.toString('utf8').slice(0, MAX_HELPER_ERROR_BYTES - helperError.length); });
    const cancel = () => { void fs.writeFile(spec.cancelPath, 'cancelled', { flag: 'w' }).catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); child.kill(); throw abortError(signal); }
    let watchdogFired = false;
    const watchdog = setTimeout(() => { watchdogFired = true; child.kill(); }, spec.timeoutMs + HELPER_GRACE_MS);
    try {
      child.stdin?.end(JSON.stringify(helperSpec));
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const raw = await fs.readFile(spec.resultPath, 'utf8').catch(() => undefined);
      if (!raw) {
        if (signal.aborted) return { nonce: spec.nonce, stdout: '', stderr: boundedText(helperError), exitCode, cancelled: true, timedOut: false, cleanupVerified: false };
        if (watchdogFired) return { nonce: spec.nonce, stdout: '', stderr: boundedText(helperError), exitCode, cancelled: false, timedOut: true, cleanupVerified: false };
        throw new Error(`Command helper exited without a verified result${helperError ? `: ${boundedText(helperError)}` : '.'}`);
      }
      const result = JSON.parse(raw) as HelperResult;
      return result;
    } finally {
      clearTimeout(watchdog);
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) cancel();
    }
  }
}

function samePrepared(left: PreparedCommand, right: PreparedCommand): boolean {
  return left.command === right.command && left.cwd === right.cwd && left.shell === right.shell && left.timeoutMs === right.timeoutMs && left.fingerprint === right.fingerprint && JSON.stringify(left.environment) === JSON.stringify(right.environment);
}

function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function hashFile(value: string): Promise<string> { return createHash('sha256').update(await fs.readFile(value)).digest('hex'); }
function boundedText(value: string): string { return value.length <= 64 * 1024 ? value : `${value.slice(0, 64 * 1024)}\n[output truncated]`; }
function abortError(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'); }
function isInside(root: string, candidate: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function resolveExecutable(name: string, root: string): Promise<string> {
  const entries = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).map((value) => value.trim().replace(/^"|"$/g, '')).filter(path.isAbsolute);
  for (const entry of entries) {
    try {
      const executable = await fs.realpath(path.join(entry, name));
      if (!isInside(root, executable) && (await fs.stat(executable)).isFile()) return executable;
    } catch { /* Skip untrusted or unavailable PATH entries without executing them. */ }
  }
  throw new Error('Git executable was not found outside the approved root.');
}
function unpackedHelperPath(): string {
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'job-runner.ps1');
  const marker = `${path.sep}app.asar${path.sep}`;
  return source.toLowerCase().includes(marker.toLowerCase())
    ? source.replace(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${path.sep}app.asar.unpacked${path.sep}`)
    : source;
}
