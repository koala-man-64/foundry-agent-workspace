import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandRunner } from '../src/command-runner.js';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> { await execFile('git', args, { cwd, windowsHide: true }); }
async function fixture(): Promise<{ root: string; runner: CommandRunner }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-command-'));
  directories.push(base);
  const root = path.join(base, 'worktree');
  await fs.mkdir(root);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Command runner test']);
  await fs.writeFile(path.join(root, 'README.md'), 'initial\n');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '-m', 'initial']);
  return { root, runner: new CommandRunner() };
}
async function prepare(runner: CommandRunner, root: string, command: string, timeoutMs = 5_000) {
  return runner.prepare(root, { command, cwd: '', environment: { TEST_APPROVED: 'yes' }, timeoutMs });
}
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for fixture state.');
}
function processExited(pid: number): boolean { try { process.kill(pid, 0); return false; } catch { return true; } }

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe.runIf(process.platform === 'win32')('CommandRunner', () => {
  it('does not run the command while preparing, then returns bounded separated output', async () => {
    const { root, runner } = await fixture();
    const marker = path.join(root, 'marker.txt').replace(/'/g, "''");
    const command = `[IO.File]::WriteAllText('${marker}', $env:TEST_APPROVED); Write-Output 'stdout café 東京'; [Console]::Error.WriteLine('stderr')`;
    const prepared = await prepare(runner, root, command);
    await expect(fs.access(path.join(root, 'marker.txt'))).rejects.toThrow();
    const result = await runner.execute(prepared, new AbortController().signal);
    expect(await fs.readFile(path.join(root, 'marker.txt'), 'utf8')).toBe('yes');
    expect(result).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false, cleanupVerified: true });
    expect(result.stdout).toContain('stdout café 東京');
    expect(result.stderr).toContain('stderr');
  });

  it('returns nonzero exits without claiming cancellation', async () => {
    const { root, runner } = await fixture();
    const result = await runner.execute(await prepare(runner, root, "Write-Output 'no'; exit 7"), new AbortController().signal);
    expect(result).toMatchObject({ exitCode: 7, cancelled: false, timedOut: false, cleanupVerified: true });
  });

  it('terminates timed out commands through the Job Object', async () => {
    const { root, runner } = await fixture();
    const result = await runner.execute(await prepare(runner, root, 'Start-Sleep -Seconds 20', 100), new AbortController().signal);
    expect(result).toMatchObject({ exitCode: null, cancelled: false, timedOut: true, cleanupVerified: true });
  });

  it('cancels commands through the Job Object', async () => {
    const { root, runner } = await fixture();
    const controller = new AbortController();
    const marker = path.join(root, 'started.txt');
    const prepared = await prepare(runner, root, `[IO.File]::WriteAllText('${marker.replace(/'/g, "''")}', 'started'); Start-Sleep -Seconds 20`, 20000);
    const executing = runner.execute(prepared, controller.signal);
    try {
      await waitFor(async () => { try { await fs.access(marker); return true; } catch { return false; } });
      controller.abort();
      const result = await executing;
      expect(result).toMatchObject({ exitCode: null, cancelled: true, timedOut: false, cleanupVerified: true });
    } finally { controller.abort(); await executing.catch(() => undefined); }
  });

  it('never starts a command whose signal was already cancelled', async () => {
    const { root, runner } = await fixture(); const controller = new AbortController();
    const prepared = await prepare(runner, root, "[IO.File]::WriteAllText('should-not-exist.txt', 'bad')");
    controller.abort();
    await expect(runner.execute(prepared, controller.signal)).rejects.toMatchObject({ outcome: 'none' });
    await expect(fs.access(path.join(root, 'should-not-exist.txt'))).rejects.toThrow();
  });

  it('does not leave a nested child alive after timeout', async () => {
    const { root, runner } = await fixture();
    const marker = path.join(root, 'orphan.txt').replace(/'/g, "''");
    const child = `Start-Sleep -Seconds 2; [IO.File]::WriteAllText('${marker}', 'orphan')`;
    const command = `Start-Process -WindowStyle Hidden -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-Command', '${child.replace(/'/g, "''")}'; Start-Sleep -Seconds 20`;
    const result = await runner.execute(await prepare(runner, root, command, 150), new AbortController().signal);
    expect(result).toMatchObject({ timedOut: true, cleanupVerified: true });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await expect(fs.access(path.join(root, 'orphan.txt'))).rejects.toThrow();
  });

  it('kills a background descendant that retains output handles after the root exits', async () => {
    const { root, runner } = await fixture();
    const marker = path.join(root, 'background-orphan.txt').replace(/'/g, "''");
    const child = `Start-Sleep -Seconds 2; [IO.File]::WriteAllText('${marker}', 'orphan')`;
    const command = `Start-Process -WindowStyle Hidden -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-Command', '${child.replace(/'/g, "''")}'`;
    const result = await runner.execute(await prepare(runner, root, command), new AbortController().signal);
    expect(result).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false, cleanupVerified: true });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await expect(fs.access(path.join(root, 'background-orphan.txt'))).rejects.toThrow();
  });

  it('rejects stale fingerprints and tampered shell or cwd values before execution', async () => {
    const { root, runner } = await fixture();
    const stale = await prepare(runner, root, "Write-Output 'never'");
    await fs.writeFile(path.join(root, 'changed.txt'), 'changed');
    await expect(runner.execute(stale, new AbortController().signal)).rejects.toThrow(/stale/i);
    const current = await prepare(runner, root, "Write-Output 'never'");
    await expect(runner.execute({ ...current, shell: path.join(root, 'powershell.exe') }, new AbortController().signal)).rejects.toThrow(/unknown|changed/i);
    await expect(runner.execute({ ...current, cwd: path.dirname(root) }, new AbortController().signal)).rejects.toThrow(/unknown|changed/i);
    await expect(runner.prepare(root, { command: "Write-Output 'never'", cwd: '..', environment: {}, timeoutMs: 1000 })).rejects.toThrow(/traverse/i);
    await expect(runner.prepare(root, { command: "Write-Output 'never'", cwd: path.dirname(root), environment: {}, timeoutMs: 1000 })).rejects.toThrow(/relative/i);
  });

  it('consumes a prepared command before execution so concurrent callers cannot replay it', async () => {
    const { root, runner } = await fixture();
    const prepared = await prepare(runner, root, 'Start-Sleep -Milliseconds 300; Write-Output once');
    const signal = new AbortController().signal;
    const [first, second] = await Promise.allSettled([runner.execute(prepared, signal), runner.execute(prepared, signal)]);
    expect([first, second].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect([first, second].filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('kills command descendants after the runtime-host process crashes', async () => {
    const { root } = await fixture();
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-crash-host-'));
    directories.push(base);
    const source = await fs.readFile(path.join(process.cwd(), 'packages', 'runtime', 'src', 'command-runner.ts'), 'utf8');
    const runnerPath = path.join(base, 'runner.mjs');
    await fs.writeFile(runnerPath, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
    const rootPid = path.join(root, 'root.pid').replace(/'/g, "''");
    const childPid = path.join(root, 'child.pid').replace(/'/g, "''");
    const child = `[IO.File]::WriteAllText('${childPid}', $PID); Start-Sleep -Seconds 20`;
    const command = `[IO.File]::WriteAllText('${rootPid}', $PID); Start-Process -WindowStyle Hidden -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-Command', '${child.replace(/'/g, "''")}'; Start-Sleep -Seconds 20`;
    const helper = path.join(process.cwd(), 'packages', 'runtime', 'src', 'job-runner.ps1');
    const hostPath = path.join(base, 'host.mjs');
    await fs.writeFile(hostPath, "import { CommandRunner } from './runner.mjs';\nconst runner = new CommandRunner(process.argv[2]);\nconst prepared = await runner.prepare(process.argv[3], { command: process.argv[4], cwd: '', environment: {}, timeoutMs: 600000 });\nawait runner.execute(prepared, new AbortController().signal);");
    const host = spawn(process.execPath, [hostPath, helper, root, command], { stdio: 'ignore', windowsHide: true });
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.once('spawn', resolve); });
    try {
      await waitFor(async () => {
        try { await Promise.all([fs.access(path.join(root, 'root.pid')), fs.access(path.join(root, 'child.pid'))]); return true; } catch { return false; }
      });
      const pids = [Number(await fs.readFile(path.join(root, 'root.pid'), 'utf8')), Number(await fs.readFile(path.join(root, 'child.pid'), 'utf8'))];
      host.kill();
      await new Promise<void>((resolve, reject) => { host.once('error', reject); host.once('close', () => resolve()); });
      await waitFor(async () => pids.every(processExited));
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      if (host.exitCode === null && !host.killed) host.kill();
    }
  });
});
