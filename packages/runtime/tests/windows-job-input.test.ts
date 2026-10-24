import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { MAX_WINDOWS_JOB_STDIN_BYTES, resolveWindowsJobHelperPath, runWindowsJob, validateWindowsJobStdin, type WindowsJobSpec } from '../src/windows-job';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const quote = (value: string) => value.replace(/'/g, "''");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function fixture(command: string): Promise<WindowsJobSpec> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-job-input-')); directories.push(directory);
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return {
    shell: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    command, cwd: directory, environment: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: directory, TMP: directory },
    timeoutMs: 10_000, nonce: randomUUID(), resultPath: path.join(directory, 'result.json'), cancelPath: path.join(directory, 'cancel')
  };
}
const readHash = "$m = [IO.MemoryStream]::new(); [Console]::OpenStandardInput().CopyTo($m); $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($m.ToArray())).Replace('-', '').ToLowerInvariant(); [Console]::Out.Write($m.Length.ToString() + ':' + $hash)";

describe('Windows job input validation', () => {
  it.each(['!!', 'YQ', 'YQ===', 'YQ==\n', 'Zh=='])('rejects noncanonical base64 before spawning (%s)', async value => {
    expect(() => validateWindowsJobStdin(value)).toThrow(/base64/);
    await expect(runWindowsJob('missing-helper', { shell: 'must-not-spawn', stdinBytesBase64: value } as WindowsJobSpec, new AbortController().signal)).rejects.toThrow(/base64/);
  });
  it('bounds decoded bytes and accepts an empty or maximum-size input', () => {
    expect(() => validateWindowsJobStdin('')).not.toThrow();
    expect(() => validateWindowsJobStdin(Buffer.alloc(MAX_WINDOWS_JOB_STDIN_BYTES).toString('base64'))).not.toThrow();
    expect(() => validateWindowsJobStdin(Buffer.alloc(MAX_WINDOWS_JOB_STDIN_BYTES + 1).toString('base64'))).toThrow(/limit/);
  });
});

describe.runIf(process.platform === 'win32')('supervised Windows job stdin', () => {
  it('delivers exactly binary and Unicode bytes at the size limit, then EOF', async () => {
    const bytes = Buffer.alloc(MAX_WINDOWS_JOB_STDIN_BYTES);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
    Buffer.from('café 東京 😀\0\r\n', 'utf8').copy(bytes, 101);
    const spec = await fixture(readHash); spec.stdinBytesBase64 = bytes.toString('base64');
    const result = await runWindowsJob(resolveWindowsJobHelperPath(), spec, new AbortController().signal);
    expect(result).toMatchObject({ nonce: spec.nonce, exitCode: 0, cancelled: false, timedOut: false, cleanupVerified: true, stdinDelivered: true });
    expect(result.stdout).toBe(`${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`);
  }, 90_000);

  it.each([undefined, ''])('retains immediate EOF for absent or empty input (%s)', async stdinBytesBase64 => {
    const spec = await fixture('[Console]::Out.Write([Console]::OpenStandardInput().ReadByte())');
    spec.stdinBytesBase64 = stdinBytesBase64;
    expect(await runWindowsJob(resolveWindowsJobHelperPath(), spec, new AbortController().signal)).toMatchObject({ stdout: '-1', exitCode: 0, cleanupVerified: true, stdinDelivered: true });
  }, 90_000);

  it('refuses malformed raw helper input before the child launches', async () => {
    const spec = await fixture(''); const marker = path.join(spec.cwd, 'must-not-launch');
    spec.command = `[IO.File]::WriteAllText('${quote(marker)}', 'launched')`;
    const child = spawn(spec.shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolveWindowsJobHelperPath()], { env: spec.environment, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.on('error', () => undefined); child.stderr.resume();
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    child.stdin.end(JSON.stringify({ ...spec, parentPid: process.pid, parentStartedAtMs: Math.floor(Date.now() - process.uptime() * 1000), stdinBytesBase64: 'YQ==\n' }));
    expect(await closed).not.toBe(0);
    await expect(fs.access(marker)).rejects.toThrow();
    await expect(fs.access(spec.resultPath)).rejects.toThrow();
  }, 90_000);

  it('can cancel while its stdin writer is blocked and kills the job before returning', async () => {
    const spec = await fixture(''); const pidPath = path.join(spec.cwd, 'pid');
    spec.command = `[IO.File]::WriteAllText('${quote(pidPath)}', $PID); Start-Sleep -Seconds 30`;
    spec.stdinBytesBase64 = Buffer.alloc(MAX_WINDOWS_JOB_STDIN_BYTES).toString('base64');
    const abort = new AbortController(); const pending = runWindowsJob(resolveWindowsJobHelperPath(), spec, abort.signal);
    let pid = 0;
    try {
      await vi.waitFor(async () => { pid = Number(await fs.readFile(pidPath, 'utf8')); expect(alive(pid)).toBe(true); }, { timeout: 60_000, interval: 50 });
    } finally { abort.abort(); }
    expect(await pending).toMatchObject({ cancelled: true, timedOut: false, cleanupVerified: true });
    expect(alive(pid)).toBe(false);
  }, 90_000);

  it('enforces the deadline while its stdin writer is blocked', async () => {
    const spec = await fixture('Start-Sleep -Seconds 30'); spec.timeoutMs = 250;
    spec.stdinBytesBase64 = Buffer.alloc(MAX_WINDOWS_JOB_STDIN_BYTES).toString('base64');
    expect(await runWindowsJob(resolveWindowsJobHelperPath(), spec, new AbortController().signal)).toMatchObject({ timedOut: true, exitCode: null, cleanupVerified: true });
  }, 90_000);

  it('kills a blocked-input child when its owning Node runtime dies', async () => {
    const spec = await fixture(''); const pidPath = path.join(spec.cwd, 'pid');
    spec.command = `[IO.File]::WriteAllText('${quote(pidPath)}', $PID); Start-Sleep -Seconds 30`;
    spec.stdinBytesBase64 = Buffer.alloc(MAX_WINDOWS_JOB_STDIN_BYTES).toString('base64');
    const source = await fs.readFile(path.join(process.cwd(), 'packages/runtime/src/windows-job.ts'), 'utf8');
    await fs.writeFile(path.join(spec.cwd, 'windows-job.mjs'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
    await fs.writeFile(path.join(spec.cwd, 'host.mjs'), "import { readFile } from 'node:fs/promises'; import { runWindowsJob } from './windows-job.mjs'; await runWindowsJob(process.argv[2], JSON.parse(await readFile(process.argv[3], 'utf8')), new AbortController().signal);");
    const specPath = path.join(spec.cwd, 'host-spec.json'); await fs.writeFile(specPath, JSON.stringify(spec));
    const host = spawn(process.execPath, [path.join(spec.cwd, 'host.mjs'), resolveWindowsJobHelperPath(), specPath], { stdio: 'ignore', windowsHide: true });
    const closed = new Promise<void>((resolve, reject) => { host.once('error', reject); host.once('close', () => resolve()); });
    let pid = 0;
    try {
      await vi.waitFor(async () => { pid = Number(await fs.readFile(pidPath, 'utf8')); expect(alive(pid)).toBe(true); }, { timeout: 60_000, interval: 50 });
    } finally { host.kill(); await closed; }
    // A dead owner cannot receive a result; as in CommandRunner's crash-host test,
    // the contract is that its previously running job cannot survive the owner.
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 15_000, interval: 50 });
  }, 90_000);
});
