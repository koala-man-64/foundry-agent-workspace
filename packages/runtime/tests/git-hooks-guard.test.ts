import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoGitHooks } from '../src/git-environment.js';
import { GitOperationError, GitOperations } from '../src/git-operations.js';
import { RepositoryError, RepositoryService } from '../src/repository.js';

const execFile = promisify(execFileCallback);
const NOT_EMPTY = 'The app-owned Git hooks folder is not empty; refusing to run Git.';
const CHANGED = 'The app-owned Git hooks folder changed while Git ran; a hook may have run.';
const scratches: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFile('git', args, { cwd, windowsHide: true })).stdout.trim();
}

async function fixture(): Promise<{ base: string; root: string; worktreeBase: string; hooks: string; marker: string }> {
  const base = fsSync.realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-git-hooks-')));
  scratches.push(base);
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Hooks test']);
  await fs.writeFile(path.join(root, 'README.md'), 'initial\n');
  await git(root, ['add', 'README.md']);
  await git(root, ['-c', 'core.hooksPath=', 'commit', '-q', '-m', 'initial']);
  const worktreeBase = path.join(base, 'app-worktrees');
  return { base, root, worktreeBase, hooks: path.join(worktreeBase, '.empty-git-hooks'), marker: path.join(base, 'hook-ran.txt') };
}

/** A real hook Git would run, recording that it did. */
async function plant(hooks: string, name: string, marker: string): Promise<void> {
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, name), `#!/bin/sh\necho ${name} >> "${marker.replaceAll('\\', '/')}"\n`);
}

afterEach(async () => {
  for (const directory of scratches.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('app-owned Git hooks folder', () => {
  it('accepts only an absent or empty real directory', async () => {
    const { base } = await fixture();
    const hooks = path.join(base, 'hooks');
    await expect(assertNoGitHooks(hooks, 'before')).resolves.toBeUndefined();
    await fs.mkdir(hooks);
    await expect(assertNoGitHooks(hooks, 'before')).resolves.toBeUndefined();
    await fs.writeFile(path.join(hooks, 'post-commit'), '#!/bin/sh\n');
    await expect(assertNoGitHooks(hooks, 'before')).rejects.toThrow(NOT_EMPTY);
    await expect(assertNoGitHooks(hooks, 'after')).rejects.toThrow(CHANGED);
    await fs.rm(hooks, { recursive: true });
    await fs.writeFile(hooks, 'not a directory');
    await expect(assertNoGitHooks(hooks, 'before')).rejects.toThrow(NOT_EMPTY);
    await fs.rm(hooks);
    // A link, even to an empty directory, can be redirected between the check and Git's lookup.
    const empty = path.join(base, 'empty-target');
    await fs.mkdir(empty);
    await fs.symlink(empty, hooks, 'junction');
    await expect(assertNoGitHooks(hooks, 'before')).rejects.toThrow(NOT_EMPTY);
    await fs.rm(hooks);
  });

  it('refuses a commit before Git runs a planted post-commit hook', async () => {
    const { root, worktreeBase, hooks, marker } = await fixture();
    const service = new RepositoryService(worktreeBase);
    const id = randomUUID();
    const { worktreePath, branch } = await service.createTaskWorktree(root, id);
    await fs.writeFile(path.join(worktreePath, 'README.md'), 'changed\n');
    const head = await git(worktreePath, ['rev-parse', 'HEAD']);
    await plant(hooks, 'post-commit', marker);
    const error = await service.commitAll(worktreePath, root, undefined, branch, 'planted hook must not run').catch((caught: unknown) => caught);
    // Refused at commitAll's first preflight Git call (repository admission), before any mutation.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(NOT_EMPTY);
    expect(error instanceof RepositoryError ? error.outcome : 'none').toBe('none');
    expect(fsSync.existsSync(marker)).toBe(false);
    expect(await git(worktreePath, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('refuses task worktree creation with no Git mutation while a hook is planted', async () => {
    const { root, worktreeBase, hooks, marker } = await fixture();
    await plant(hooks, 'post-checkout', marker);
    const id = randomUUID();
    const error = await new RepositoryService(worktreeBase).createTaskWorktree(root, id).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ outcome: 'none', mutationStarted: false });
    expect((error as Error).message).toContain(NOT_EMPTY);
    expect(fsSync.existsSync(marker)).toBe(false);
    expect(await git(root, ['branch', '--list', `*${id}*`])).toBe('');
  });

  it('fails a Git call whose hooks folder changed while it ran, even after Git succeeded', async () => {
    const { root, worktreeBase, hooks, marker } = await fixture();
    const service = new RepositoryService(worktreeBase) as unknown as {
      git(cwd: string, args: string[], permitTruncation: boolean, allowNonZero: boolean, options: { beforeMutation?: () => void }): Promise<unknown>;
    };
    await fs.mkdir(hooks, { recursive: true });
    const planting = () => { fsSync.writeFileSync(path.join(hooks, 'reference-transaction'), `#!/bin/sh\necho planted >> "${marker.replaceAll('\\', '/')}"\n`); };
    await expect(service.git(root, ['rev-parse', 'HEAD'], false, false, { beforeMutation: planting })).rejects.toThrow(CHANGED);
  });

  it('points pre-approval worktree-state Git below a regular file, where no hook can exist', async () => {
    const source = await fs.readFile(new URL('../src/command-runner.ts', import.meta.url), 'utf8');
    // An empty core.hooksPath resolves hooks at the drive root, which `git status` (post-index-change) would run.
    expect(source).not.toMatch(/'core\.hooksPath='/);
    expect(source.match(/`core\.hooksPath=\$\{git\}`/g)).toHaveLength(2);
    // The Git behaviour that relies on: a hook below a directory runs, a hook path below a file names nothing. post-commit
    // is the deterministic control; status only fires post-index-change when it happens to rewrite the index.
    const { base, root, marker } = await fixture();
    const executable = (await execFile('where.exe', ['git'], { windowsHide: true })).stdout.split(/\r?\n/)[0]!.trim();
    const directory = path.join(base, 'control-hooks');
    await plant(directory, 'post-commit', marker);
    await git(root, ['-c', `core.hooksPath=${directory}`, 'commit', '--allow-empty', '--no-verify', '-qm', 'control']);
    expect(fsSync.existsSync(marker)).toBe(true);
    await fs.rm(marker);
    expect(await git(root, ['-c', `core.hooksPath=${executable}`, 'rev-parse', '--git-path', 'hooks/post-index-change'])).toBe(`${executable}/post-index-change`);
    await git(root, ['-c', `core.hooksPath=${executable}`, 'commit', '--allow-empty', '--no-verify', '-qm', 'below a file']);
    await git(root, ['-c', `core.hooksPath=${executable}`, 'status', '--porcelain']);
    expect(fsSync.existsSync(marker)).toBe(false);
  });

  it('refuses a child worktree before Git runs a planted post-checkout hook', async () => {
    const { root, worktreeBase, marker } = await fixture();
    await fs.mkdir(worktreeBase, { recursive: true });
    const hooks = path.join(fsSync.realpathSync.native(worktreeBase), '.empty-git-hooks');
    await plant(hooks, 'post-checkout', marker);
    const ops = new GitOperations(worktreeBase);
    const head = await git(root, ['rev-parse', 'HEAD']);
    const id = randomUUID();
    const error = await ops.createChildWorktree(root, id, head).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
    expect((error as Error).message).toContain(NOT_EMPTY);
    expect(fsSync.existsSync(marker)).toBe(false);
    expect(await git(root, ['branch', '--list', `codex/child/${id}`])).toBe('');
  });
});
