import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner } from '../src/command-runner.js';

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const limitMessage = 'Worktree exceeds command review limits (50,000 files, 10,000 directories or links, 1 GiB of file content).';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-fingerprint-'));
  roots.push(root);
  await execFile('git', ['init', '-q'], { cwd: root, windowsHide: true });
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  await execFile('git', ['add', '.gitignore'], { cwd: root, windowsHide: true });
  await execFile('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root, windowsHide: true });
  const dependencies = path.join(root, 'node_modules');
  await fs.mkdir(dependencies);
  const runner = new CommandRunner();
  const prepare = () => runner.prepare(root, { command: "[IO.File]::WriteAllText('must-not-start.txt', 'started')", cwd: '', environment: {}, timeoutMs: 5000 });
  return { root, dependencies, runner, prepare };
}

async function fill(directory: string, count: number, directories = false) {
  for (let start = 0; start < count; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - start) }, (_, offset) => {
      const target = path.join(directory, `${start + offset}`);
      return directories ? fs.mkdir(target) : fs.writeFile(target, 'x');
    }));
  }
}

afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

// Pause at a real file-handle read, so these races are deterministic rather than scheduled with sleeps.
async function mutateAfterFirstChunk(target: string, mutate: () => Promise<void>) {
  const canonicalTarget = await fs.realpath(target);
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === canonicalTarget && args[1] === 'r') {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs) => {
        const result = await Reflect.apply(read, handle, readArgs) as Awaited<ReturnType<typeof handle.read>>;
        await mutate();
        return result;
      });
    }
    return handle;
  });
}

describe.runIf(process.platform === 'win32')('command review for installed dependencies', () => {
  it('admits more than 10,000 ignored files and 64 MiB, but rejects an altered dependency before launch', async () => {
    const { root, dependencies, runner, prepare } = await fixture();
    await fill(dependencies, 10_001);
    const dependency = path.join(dependencies, 'runtime.bin');
    const handle = await fs.open(dependency, 'w');
    try { await handle.truncate(65 * 1024 * 1024 + 1); } finally { await handle.close(); }
    const prepared = await prepare();
    const stat = await fs.stat(dependency);
    const changed = await fs.open(dependency, 'r+');
    try { await changed.write(Buffer.from('x'), 0, 1, stat.size - 1); } finally { await changed.close(); }
    await fs.utimes(dependency, stat.atime, stat.mtime);
    await expect(runner.execute(prepared, new AbortController().signal)).rejects.toMatchObject({ outcome: 'none', message: expect.stringMatching(/stale/i) });
    await expect(fs.access(path.join(root, 'must-not-start.txt'))).rejects.toThrow();
    await expect(runner.execute(prepared, new AbortController().signal)).rejects.toMatchObject({ outcome: 'none', message: expect.stringMatching(/unknown/i) });
  }, 180_000);

  it('keeps fingerprints independent of chunk boundaries and filesystem timestamps', async () => {
    const { dependencies, prepare } = await fixture();
    const target = path.join(dependencies, 'entry.js');
    await fs.writeFile(target, Buffer.alloc(2 * 64 * 1024 + 1, 97));
    const first = await prepare();
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(target, later, later);
    expect((await prepare()).fingerprint).toBe(first.fingerprint);
    const handle = await fs.open(target, 'r+');
    try { await handle.write(Buffer.from('b'), 0, 1, 64 * 1024); } finally { await handle.close(); }
    expect((await prepare()).fingerprint).not.toBe(first.fingerprint);
    await fs.truncate(target, 64 * 1024);
    expect((await prepare()).fingerprint).not.toBe(first.fingerprint);
  });

  it.each(['grow', 'truncate', 'rewrite', 'replace'] as const)('refuses a dependency that changes during streaming: %s', async (change) => {
    const { root, dependencies, runner, prepare } = await fixture();
    const target = path.join(dependencies, 'entry.js');
    await fs.writeFile(target, Buffer.alloc(3 * 64 * 1024, 97));
    const prepared = await prepare();
    const before = await fs.stat(target);
    let mutations = 0;
    await mutateAfterFirstChunk(target, async () => {
      mutations++;
      if (change === 'grow') await fs.appendFile(target, 'x');
      else if (change === 'truncate') await fs.truncate(target, 16);
      else if (change === 'replace') {
        await fs.rename(target, `${target}.old`);
        await fs.writeFile(target, Buffer.alloc(before.size, 98));
      } else {
        const writer = await fs.open(target, 'r+');
        try { await writer.write(Buffer.from('b'), 0, 1, 2 * 64 * 1024); } finally { await writer.close(); }
      }
      await fs.utimes(target, before.atime, before.mtime);
    });
    const result = await Promise.allSettled([runner.execute(prepared, new AbortController().signal)]);
    expect(mutations).toBe(1);
    expect(result).toMatchObject([{ status: 'rejected', reason: { outcome: 'none', message: expect.stringMatching(/changed while fingerprinting/i) } }]);
    await expect(fs.access(path.join(root, 'must-not-start.txt'))).rejects.toThrow();
  });

  it('injects the streaming mutation when the worktree is reached through a path alias', async () => {
    const { root, dependencies, runner } = await fixture();
    await fs.writeFile(path.join(dependencies, 'entry.js'), Buffer.alloc(3 * 64 * 1024, 97));
    const aliasParent = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-fingerprint-alias-'));
    roots.push(aliasParent);
    const alias = path.join(aliasParent, 'worktree');
    await fs.symlink(root, alias, 'junction');
    const target = path.join(alias, 'node_modules', 'entry.js');
    expect(target).not.toBe(await fs.realpath(target));
    const prepared = await runner.prepare(alias, { command: "[IO.File]::WriteAllText('must-not-start.txt', 'started')", cwd: '', environment: {}, timeoutMs: 5000 });
    let mutations = 0;
    await mutateAfterFirstChunk(target, async () => { mutations++; await fs.appendFile(target, 'x'); });
    const result = await Promise.allSettled([runner.execute(prepared, new AbortController().signal)]);
    expect(mutations).toBe(1);
    expect(result).toMatchObject([{ status: 'rejected', reason: { outcome: 'none', message: expect.stringMatching(/changed while fingerprinting/i) } }]);
    await expect(fs.access(path.join(root, 'must-not-start.txt'))).rejects.toThrow();
  });

  it('refuses a file beyond the aggregate byte limit before reading it', async () => {
    const { dependencies, prepare } = await fixture();
    const handle = await fs.open(path.join(dependencies, 'oversized.bin'), 'w');
    try { await handle.truncate(1024 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await expect(prepare()).rejects.toThrow(limitMessage);
  });

  it('refuses more than 50,000 regular files with the precise limit', async () => {
    const { dependencies, prepare } = await fixture();
    await fill(dependencies, 50_000); // The tracked .gitignore is also a regular file.
    await expect(prepare()).rejects.toThrow(limitMessage);
  }, 180_000);

  it('bounds directories and links even when they contain no regular files', async () => {
    const { dependencies, prepare } = await fixture();
    await fill(dependencies, 10_000, true); // node_modules itself is the 10,001st directory.
    await expect(prepare()).rejects.toThrow(limitMessage);
  }, 90_000);
});
