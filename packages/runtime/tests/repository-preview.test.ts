import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitTask } from '../../protocol/src/index';
import { RepositoryError, RepositoryService } from '../src/repository';

const execFile = promisify(execFileCallback);
const temporary: string[] = [];
async function git(cwd: string, args: string[]): Promise<string> { return (await execFile('git', args, { cwd, windowsHide: true })).stdout.trim(); }
async function fixture(): Promise<{ root: string; service: RepositoryService; task: GitTask; initial: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-preview-')); temporary.push(base);
  const root = path.join(base, 'project'); await fs.mkdir(root);
  await git(root, ['init']); await git(root, ['config', 'user.email', 'test@example.invalid']); await git(root, ['config', 'user.name', 'Preview test']);
  await fs.writeFile(path.join(root, 'README.md'), '# safe\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
  const initial = await git(root, ['rev-parse', 'HEAD']);
  const task: GitTask = { id: randomUUID(), title: 'Preview', workspaceKind: 'git', projectPath: root, worktreePath: root, branch: await git(root, ['branch', '--show-current']),
    baseCommit: initial, profileId: randomUUID(), status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tokenBudget: 1000, usedTokens: 0 };
  return { root, service: new RepositoryService(path.join(base, 'worktrees')), task, initial };
}
afterEach(async () => { for (const target of temporary.splice(0)) await fs.rm(target, { recursive: true, force: true }); });

describe('continuation and artifact repository boundaries', () => {
  it('uses only a clean source HEAD or an explicit retained local SHA', async () => {
    const { root, service, task, initial } = await fixture();
    expect((await service.continuationSource(task)).commit).toBe(initial);
    await fs.writeFile(path.join(root, 'README.md'), '# dirty\n');
    await expect(service.continuationSource(task)).rejects.toThrow('clean source');
    await fs.writeFile(path.join(root, 'README.md'), '# safe\n');
    await expect(service.continuationSource({ ...task, status: 'retired' })).rejects.toThrow('explicit retained');
    expect((await service.continuationSource({ ...task, status: 'retired' }, initial)).commit).toBe(initial);
    await expect(service.continuationSource({ ...task, status: 'retired' }, 'a'.repeat(40))).rejects.toThrow();
  });

  it('checks filters from the selected revision before checkout', async () => {
    const { root, service, initial } = await fixture();
    await fs.writeFile(path.join(root, '.gitattributes'), '*.md filter=malicious\n');
    await git(root, ['add', '.gitattributes']); await git(root, ['commit', '-m', 'filter']);
    const filtered = await git(root, ['rev-parse', 'HEAD']);
    const created = await service.createTaskWorktree(root, randomUUID(), initial);
    expect(created.baseCommit).toBe(initial);
    await expect(service.createTaskWorktree(root, randomUUID(), filtered)).rejects.toThrow('filters');
    await expect(service.createTaskWorktree(root, randomUUID(), 'not-a-sha')).rejects.toBeInstanceOf(RepositoryError);
  });

  it('allows bounded text and rejects traversal, sensitive names, symlinks and oversized text', async () => {
    const { root, service, task } = await fixture();
    expect((await service.readArtifact(task, 'README.md')).mimeType).toBe('text/markdown');
    await expect(service.readArtifact(task, '../outside.md')).rejects.toThrow();
    await fs.writeFile(path.join(root, '.env'), 'secret');
    await expect(service.readArtifact(task, '.env')).rejects.toThrow();
    await fs.writeFile(path.join(root, 'huge.txt'), 'x'.repeat(256 * 1024 + 1));
    await expect(service.readArtifact(task, 'huge.txt')).rejects.toThrow('preview limit');
    try {
      await fs.symlink(path.join(root, 'README.md'), path.join(root, 'linked.md'));
      await expect(service.readArtifact(task, 'linked.md')).rejects.toThrow('Symbolic');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await fs.symlink(root, path.join(root, 'linked'), 'junction');
      await expect(service.readArtifact(task, 'linked/README.md')).rejects.toThrow('Symbolic');
    }
  });

  it('rejects disguised and overdimensioned images', async () => {
    const { root, service, task } = await fixture();
    await fs.writeFile(path.join(root, 'fake.png'), Buffer.from('<html>unsafe</html>'));
    await expect(service.readArtifact(task, 'fake.png')).rejects.toThrow('signature');
    const png = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(4001, 16); png.writeUInt32BE(4000, 20);
    await fs.writeFile(path.join(root, 'huge.png'), png);
    await expect(service.readArtifact(task, 'huge.png')).rejects.toThrow('dimensions');
    png.writeUInt32BE(100, 16); png.writeUInt32BE(100, 20);
    await fs.writeFile(path.join(root, 'small.png'), png);
    expect(await service.readArtifact(task, 'small.png')).toMatchObject({ mimeType: 'image/png', width: 100, height: 100 });
  });
});
