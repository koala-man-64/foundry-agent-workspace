import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { RepositoryError, RepositoryService } from '../src/repository.js';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile('git', args, { cwd, windowsHide: true });
}

async function fixtureRepository(): Promise<{ root: string; service: RepositoryService }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-repository-'));
  temporaryDirectories.push(base);
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Repository test']);
  await fs.writeFile(path.join(root, 'README.md'), 'initial\n');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '-m', 'initial']);
  return { root, service: new RepositoryService(path.join(base, 'app-worktrees')) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('RepositoryService', () => {
  it('reports preflight failures as having no repository mutation', async () => {
    const { service } = await fixtureRepository();
    const error = await service.createTaskWorktree('not-an-absolute-path', '123e4567-e89b-42d3-a456-426614174000').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RepositoryError);
    expect((error as RepositoryError).outcome).toBe('none');
    expect((error as RepositoryError).mutationStarted).toBe(false);
  });

  it('creates an isolated task branch while preserving dirty files in the selected repository', async () => {
    const { root, service } = await fixtureRepository();
    await fs.writeFile(path.join(root, 'README.md'), 'user dirty edit\n');
    const result = await service.createTaskWorktree(root, '123e4567-e89b-42d3-a456-426614174000');
    expect(result.branch).toBe('codex/task/123e4567-e89b-42d3-a456-426614174000');
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('user dirty edit\n');
    expect(await fs.readFile(path.join(result.worktreePath, 'README.md'), 'utf8')).toBe('initial\n');
  });

  it('does not execute a git.exe shadow placed in the selected repository', async () => {
    const { root, service } = await fixtureRepository();
    const originalPath = process.env.PATH;
    await fs.writeFile(path.join(root, 'git.exe'), 'not an executable');
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ''}`;
    try {
      const result = await service.createTaskWorktree(root, '123e4567-e89b-42d3-a456-426614174003');
      expect(await fs.readFile(path.join(result.worktreePath, 'README.md'), 'utf8')).toBe('initial\n');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('refuses repositories whose checkout would invoke a configured Git filter', async () => {
    const { root, service } = await fixtureRepository();
    await fs.writeFile(path.join(root, '.gitattributes'), 'README.md filter=unsafe\n');
    await git(root, ['config', 'filter.unsafe.smudge', 'unexpected-command']);
    await git(root, ['add', '.gitattributes']);
    await git(root, ['commit', '-m', 'configure filter']);
    const error = await service.createTaskWorktree(root, '123e4567-e89b-42d3-a456-426614174001').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RepositoryError);
    expect((error as RepositoryError).outcome).toBe('none');
    expect(String(error)).toMatch(/filters/i);
  });

  it('rejects core.worktree configuration before it can redirect checkout outside the app worktree', async () => {
    const { root, service } = await fixtureRepository();
    const external = path.join(path.dirname(root), 'external-working-tree');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'keep.txt'), 'preserve me');
    await git(root, ['config', 'core.worktree', external]);
    const error = await service.createTaskWorktree(root, '123e4567-e89b-42d3-a456-426614174002').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RepositoryError);
    expect((error as RepositoryError).outcome).toBe('none');
    expect(String(error)).toMatch(/core\.worktree/i);
    expect(await fs.readFile(path.join(external, 'keep.txt'), 'utf8')).toBe('preserve me');
  });

  it('rejects traversal, secrets, and symlink escapes from read tools', async () => {
    const { root, service } = await fixtureRepository();
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=never-expose');
    await fs.writeFile(path.join(root, '.npmrc'), 'token=never-expose');
    await fs.mkdir(path.join(root, '.ssh'));
    await fs.writeFile(path.join(root, 'safe.txt'), 'safe');
    const outside = path.join(path.dirname(root), 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'escape.txt'), 'outside');
    await fs.symlink(outside, path.join(root, 'linked'), 'junction');
    await expect(service.readFile(root, '../outside/escape.txt')).rejects.toThrow(/forbidden|escapes/i);
    await expect(service.readFile(root, '.env')).rejects.toThrow(/forbidden|available/i);
    await expect(service.readFile(root, '.npmrc')).rejects.toThrow(/forbidden|available/i);
    await expect(service.readFile(root, 'linked/escape.txt')).rejects.toThrow(/symbolic|escapes/i);
    await expect(service.listFiles(root)).resolves.toEqual(expect.arrayContaining([{ path: 'safe.txt', kind: 'file' }]));
    await expect(service.listFiles(root)).resolves.not.toEqual(expect.arrayContaining([{ path: '.env', kind: 'file' }]));
    await expect(service.listFiles(root)).resolves.not.toEqual(expect.arrayContaining([{ path: '.npmrc', kind: 'file' }, { path: '.ssh', kind: 'directory' }]));
  });

  it('redacts secret paths from diffs and marks bounded output as truncated', async () => {
    const { root, service } = await fixtureRepository();
    await fs.writeFile(path.join(root, 'README.md'), `${'x'.repeat(300_000)}\n`);
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=never-expose\n');
    await git(root, ['add', '.env']);
    const result = await service.diff(root);
    expect(result.summary).toContain('README.md');
    expect(result.patch).toContain('README.md');
    expect(result.patch).not.toContain('never-expose');
    expect(result.truncated).toBe(true);
  });

  it('uses literal Git pathspecs so a public bracket path cannot expand to a secret path', async () => {
    const { root, service } = await fixtureRepository();
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=never-expose\n');
    await fs.writeFile(path.join(root, '[.]env'), 'literal public content\n');
    await git(root, ['add', '.env', '[.]env']);
    const result = await service.diff(root);
    expect(result.patch).toContain('literal public content');
    expect(result.patch).not.toContain('never-expose');
  });

  it('taints both sides of a rename when either path is secret', async () => {
    const { root, service } = await fixtureRepository();
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=never-expose\n');
    await git(root, ['add', '.env']);
    await git(root, ['commit', '-m', 'add secret']);
    await git(root, ['mv', '.env', 'public.txt']);
    const result = await service.diff(root);
    expect(result.summary).not.toContain('public.txt');
    expect(result.patch).not.toContain('public.txt');
    expect(result.patch).not.toContain('never-expose');
  });

  it('omits untracked content when a sensitive tracked file was deleted', async () => {
    const { root, service } = await fixtureRepository();
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=never-expose\n');
    await git(root, ['add', '.env']); await git(root, ['commit', '-m', 'add secret']);
    await fs.rm(path.join(root, '.env'));
    await fs.writeFile(path.join(root, 'public.txt'), 'TOKEN=never-expose\n');
    const result = await service.diff(root);
    expect(result.patch).not.toContain('never-expose');
    expect(result.patch).not.toContain('public.txt');
    expect(result.summary).toContain('Untracked content omitted');
    expect(result.truncated).toBe(true);
  });

  it('applies only an existing file edit with a fresh hash', async () => {
    const { root, service } = await fixtureRepository();
    const initial = await service.readFile(root, 'README.md');
    const edit = await service.prepareEdit(root, 'README.md', initial.hash, 'updated\n');
    await fs.writeFile(path.join(root, 'README.md'), 'changed elsewhere\n');
    await expect(service.applyEdit(edit)).rejects.toThrow(/stale/i);
    await expect(fs.readFile(path.join(root, 'README.md'), 'utf8')).resolves.toBe('changed elsewhere\n');
  });

  it('refuses secret paths, hard-linked files, and new-file edits', async () => {
    const { root, service } = await fixtureRepository();
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=never-expose\n');
    const readme = await service.readFile(root, 'README.md');
    await expect(service.prepareEdit(root, '.env', readme.hash, 'changed\n')).rejects.toThrow(/forbidden|available/i);
    await fs.link(path.join(root, 'README.md'), path.join(root, 'README-copy.md'));
    await expect(service.prepareEdit(root, 'README.md', readme.hash, 'changed\n')).rejects.toThrow(/hard-linked/i);
    await expect(service.prepareEdit(root, 'new.txt', null, 'new\n')).rejects.toThrow(/creating new files is unavailable/i);
    await expect(fs.access(path.join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('searches accessible text without changing repository files', async () => {
    const { root, service } = await fixtureRepository();
    await fs.writeFile(path.join(root, 'notes.txt'), 'needle appears here\n');
    await fs.writeFile(path.join(root, '.env'), 'needle secret\n');
    const result = await service.search(root, 'needle');
    expect(result.matches).toEqual([{ path: 'notes.txt', line: 1, text: 'needle appears here' }]);
    await expect(fs.readFile(path.join(root, 'notes.txt'), 'utf8')).resolves.toBe('needle appears here\n');
    await expect(fs.readFile(path.join(root, '.env'), 'utf8')).resolves.toBe('needle secret\n');
  });
});
