import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

export interface HookInvocation { command: string; arguments: string[]; cwd: string; input: unknown; timeoutMs: number; signal: AbortSignal; language: 'powershell' | 'javascript'; }
export interface HookExecution { stdout: string; stderr: string; exitCode: number | null; cancelled: boolean; timedOut: boolean; cleanupVerified: boolean; }
export interface HookExecutor { execute(input: HookInvocation): Promise<HookExecution>; }
const MAX_OUTPUT = 64 * 1024;
const MAX_ERROR = 16 * 1024;
const MAX_INPUT = 64 * 1024;
// This exact launcher version is bound into each PowerShell config pin. User source remains a separate BOM-pinned file.
const POWERSHELL_LAUNCHER_TEMPLATE = '\uFEFF' + String.raw`[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$errorsBefore = $Error.Count
$global:LASTEXITCODE = 0
__PINNED_INVOCATION__
$entrySucceeded = $?
$entryExitCode = $LASTEXITCODE
if ($entryExitCode -ne 0) { exit $entryExitCode }
if (-not $entrySucceeded -or $Error.Count -gt $errorsBefore) { exit 1 }
`;
const POWERSHELL_LAUNCHER_VERSION = 'utf8-bom-literal-arguments-exit-v3';
export const POWERSHELL_LAUNCHER_SHA256 = createHash('sha256').update(`${POWERSHELL_LAUNCHER_VERSION}\n${POWERSHELL_LAUNCHER_TEMPLATE}`).digest('hex');
function powerShellLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function powerShellArgument(value: string): string {
  if (value.startsWith('-')) {
    if (!/^-[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) throw new Error('Unsupported PowerShell named argument syntax; register a new script revision with simple -Name arguments.');
    return value;
  }
  if (value.includes('\0')) throw new Error('PowerShell arguments cannot contain NUL.');
  return powerShellLiteral(value);
}

/** The existing MCP host provides a kill-on-close Windows Job and direct child stdio. */
export class WindowsHookRunner implements HookExecutor {
  constructor(private readonly hostPath = unpackedHostPath()) {}
  async execute(input: HookInvocation): Promise<HookExecution> {
    if (process.platform !== 'win32') throw new Error('Script hooks require Windows Job supervision.');
    const encoded = JSON.stringify(input.input);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_INPUT) throw new Error('Hook input exceeds 64 KiB.');
    if (input.signal.aborted) throw new Error('Hook was cancelled before dispatch.');
    const fileIndex = input.language === 'powershell' ? input.arguments.findIndex(value => value.toLowerCase() === '-file') : -1;
    if (input.language === 'powershell' && (fileIndex < 0 || !input.arguments[fileIndex + 1])) throw new Error('Pinned PowerShell script path is missing.');
    const powerShellArguments = input.language === 'powershell' ? input.arguments.slice(fileIndex + 2).map(powerShellArgument).join(' ') : '';
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-hook-'));
    const nonce = randomUUID();
    const resultPath = path.join(temporary, 'result.json');
    const cancelPath = path.join(temporary, 'cancel');
    const specPath = path.join(temporary, 'spec.json');
    const launcherPath = path.join(temporary, 'hook-launcher.ps1');
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const shell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = { SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'), PATH: `${path.dirname(input.command)};${path.join(systemRoot, 'System32')};${systemRoot}`, TEMP: temporary, TMP: temporary, USERPROFILE: process.env.USERPROFILE ?? temporary, ...(input.language === 'javascript' && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
    const child = await (async () => {
      try {
        let argumentsToRun = input.arguments;
        if (input.language === 'powershell') {
          const invocation = `& ${powerShellLiteral(input.arguments[fileIndex + 1]!)}${powerShellArguments ? ` ${powerShellArguments}` : ''}`;
          const launcher = POWERSHELL_LAUNCHER_TEMPLATE.replace('__PINNED_INVOCATION__', () => invocation);
          await fs.writeFile(launcherPath, launcher, { flag: 'wx', mode: 0o600 });
          if (await sha256File(launcherPath) !== createHash('sha256').update(launcher).digest('hex')) throw new Error('PowerShell launcher changed before dispatch.');
          argumentsToRun = [...input.arguments.slice(0, fileIndex), '-File', launcherPath];
        }
        const spec = { nonce, resultPath, cancelPath, command: input.command, arguments: argumentsToRun, cwd: input.cwd, environment: env, lifetimeMs: input.timeoutMs, parentPid: process.pid, parentStartedAtMs: Math.floor(Date.now() - process.uptime() * 1000) };
        await fs.writeFile(specPath, JSON.stringify(spec), { flag: 'wx', mode: 0o600 });
        return spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.hostPath, specPath], { cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    })();
    const stdoutChunks: Buffer[] = []; const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0; let stderrBytes = 0; let oversized = false;
    let pipeFailure = false;
    const cancel = (): void => {
      void fs.writeFile(cancelPath, 'cancelled').catch(() => undefined);
      if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    };
    input.signal.addEventListener('abort', cancel, { once: true });
    child.stdin?.on('error', () => { pipeFailure = true; cancel(); });
    child.stdout?.on('error', () => { pipeFailure = true; cancel(); });
    child.stderr?.on('error', () => { pipeFailure = true; cancel(); });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (oversized) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT) { oversized = true; cancel(); return; }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (oversized) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_ERROR) { oversized = true; cancel(); return; }
      stderrChunks.push(chunk);
    });
    const closed = new Promise<void>((resolve) => {
      child.once('error', () => { pipeFailure = true; });
      child.once('close', () => resolve());
    });
    // The host normally enforces lifetime in its Job. This watchdog covers a helper that stalls before Job setup.
    const watchdog = setTimeout(cancel, input.timeoutMs + 10_000);
    const hardStop = setTimeout(() => child.kill(), input.timeoutMs + 20_000);
    try {
      try { child.stdin?.end(encoded + '\n'); } catch { pipeFailure = true; cancel(); }
      await closed;
      if (pipeFailure) throw new Error('Hook process pipe failed; outcome is unknown.');
      const raw = await fs.readFile(resultPath, 'utf8').catch(() => '');
      const result = raw ? JSON.parse(raw) as HookExecution & { nonce: string; lifetimeExpired?: boolean } : undefined;
      if (!result || result.nonce !== nonce || oversized) throw new Error(oversized ? 'Hook output exceeded its limit.' : 'Hook helper did not confirm process cleanup.');
      return { stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'), stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'), exitCode: result.exitCode, cancelled: result.cancelled, timedOut: result.lifetimeExpired ?? result.timedOut ?? false, cleanupVerified: result.cleanupVerified };
    } finally {
      clearTimeout(watchdog); clearTimeout(hardStop);
      input.signal.removeEventListener('abort', cancel);
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function sha256File(file: string): Promise<string> { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
function unpackedHostPath(): string {
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-host.ps1');
  const marker = `${path.sep}app.asar${path.sep}`;
  return source.toLowerCase().includes(marker.toLowerCase()) ? source.replace(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${path.sep}app.asar.unpacked${path.sep}`) : source;
}
