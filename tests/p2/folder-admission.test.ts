import fs from 'node:fs';
import { promises as asyncFs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { assertNoReparseDirectories, resolveLocalPath, RepositoryService } from '../../packages/runtime/src/repository';
import { createHash } from 'node:crypto';
import { RpcMethods } from '../../packages/protocol/src/index';
import { AgentChannel } from '../../packages/runtime/src/agent-channel';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { execFileSync } from 'node:child_process';

// Saved project paths are canonical (project.add stores the real path), so fixtures use canonical scratch folders even
// where TEMP is an 8.3 spelling, as on hosted Windows runners.
const canonicalScratch = (prefix: string): string => fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), prefix)));

function fixtureGit(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', `core.hooksPath=${path.join(root, 'no-fixture-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { windowsHide: true, encoding: 'utf8' }).trim();
}
function gitRoots(scratch: string): { root: string; other: string; alias: string } {
  const root = path.join(scratch, 'root'); const other = path.join(scratch, 'other'); const alias = path.join(scratch, 'alias');
  fs.mkdirSync(root); fs.mkdirSync(other); fs.symlinkSync(root, alias, 'junction');
  fixtureGit(root, 'init', '-q', '-b', 'main'); fixtureGit(root, 'commit', '--allow-empty', '-qm', 'fixture');
  fixtureGit(scratch, 'clone', '-q', '--no-hardlinks', root, other);
  return { root, other, alias };
}
const repositoryState = (root: string) => JSON.stringify([fixtureGit(root, 'for-each-ref', '--format=%(refname) %(objectname)'), fixtureGit(root, 'worktree', 'list', '--porcelain'), fixtureGit(root, 'status', '--porcelain=v1')]);

it('retains admission for both queued worktree requests and refuses alias replacement before Git mutation', async () => {
  const scratch = canonicalScratch('foundry-p2-queued-identity-');
  const { root, other, alias } = gitRoots(scratch);
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const internal = repositories as unknown as { prepareWorktreeBase(): Promise<string> };
  const prepare = internal.prepareWorktreeBase.bind(repositories);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(internal, 'prepareWorktreeBase').mockImplementationOnce(async () => { entered(); await gate; return prepare(); });
  const before = [repositoryState(root), repositoryState(other)];
  const first = repositories.createTaskWorktree(alias, '18181818-0000-4000-8000-000000000011').catch((error: unknown) => error);
  let second: Promise<unknown> | undefined;
  try {
    await started;
    second = repositories.createTaskWorktree(alias, '18181818-0000-4000-8000-000000000012').catch((error: unknown) => error);
    fs.rmSync(alias); fs.symlinkSync(other, alias, 'junction'); release();
    for (const outcome of await Promise.all([first, second])) expect(outcome).toMatchObject({ outcome: 'none', mutationStarted: false });
    expect([repositoryState(root), repositoryState(other)]).toEqual(before);
  } finally { release(); await Promise.all([first, second]); vi.restoreAllMocks(); fs.rmSync(alias); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('refuses alias rebinding during final Git executable lookup as a known pre-mutation failure', async () => {
  const scratch = canonicalScratch('foundry-p2-final-boundary-');
  const { root, other, alias } = gitRoots(scratch);
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const internal = repositories as unknown as { prepareWorktreeBase(): Promise<string>; getGitExecutable(root: string): Promise<string> };
  const prepare = internal.prepareWorktreeBase.bind(repositories); const executable = internal.getGitExecutable.bind(repositories);
  let armed = false;
  vi.spyOn(internal, 'prepareWorktreeBase').mockImplementation(async () => { const base = await prepare(); armed = true; return base; });
  vi.spyOn(internal, 'getGitExecutable').mockImplementation(async folder => {
    const value = await executable(folder);
    if (armed) { armed = false; fs.rmSync(alias); fs.symlinkSync(other, alias, 'junction'); }
    return value;
  });
  const before = [repositoryState(root), repositoryState(other)];
  try {
    await expect(repositories.createTaskWorktree(alias, '18181818-0000-4000-8000-000000000013')).rejects.toMatchObject({ outcome: 'none', mutationStarted: false });
    expect([repositoryState(root), repositoryState(other)]).toEqual(before);
  } finally { vi.restoreAllMocks(); fs.rmSync(alias); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('retains an unknown outcome when checkout fails after worktree add has actually run', async () => {
  const scratch = canonicalScratch('foundry-p2-post-mutation-');
  const { root, alias } = gitRoots(scratch);
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const internal = repositories as unknown as { git(root: string, args: string[], ...options: unknown[]): Promise<unknown> };
  const git = internal.git.bind(repositories);
  vi.spyOn(internal, 'git').mockImplementation((folder, args, ...options) => args[0] === 'checkout' ? Promise.reject(new Error('Injected failure after worktree add.')) : git(folder, args, ...options));
  const id = '18181818-0000-4000-8000-000000000014';
  try {
    await expect(repositories.createTaskWorktree(alias, id)).rejects.toMatchObject({ outcome: 'unknown', mutationStarted: true });
    expect(fixtureGit(root, 'for-each-ref', '--format=%(refname)')).toContain(`refs/heads/codex/task/${id}`);
    expect(fixtureGit(root, 'worktree', 'list', '--porcelain')).toContain(id);
  } finally { vi.restoreAllMocks(); fs.rmSync(alias); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it.each(['task.create', 'task.start'] as const)('carries trusted %s admission through repository invocation instead of admitting replacement metadata afresh', async method => {
  const scratch = canonicalScratch('foundry-p2-caller-identity-');
  const { root, other, alias } = gitRoots(scratch);
  const store = new Store(path.join(scratch, 'workspace.db'));
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const create = repositories.createTaskWorktree.bind(repositories);
  const pointer = path.join(root, '.git', 'commondir');
  vi.spyOn(repositories, 'createTaskWorktree').mockImplementation((...args) => { fs.writeFileSync(pointer, path.join(other, '.git')); return create(...args); });
  const provider = vi.fn(() => { throw new Error('Provider must not start.'); });
  const service = new RuntimeService(store, repositories, () => {}, provider);
  const project = method === 'task.start' ? store.insertProject(root, 'git') : undefined;
  const before = [repositoryState(root), repositoryState(other)];
  try {
    const input = method === 'task.create'
      ? { title: 'Bound admission', projectPath: alias, profileId: FAKE_PROFILE_ID, tokenBudget: 100000, mode: 'chat' }
      : { requestId: '18181818-0000-4000-8000-000000000003', projectId: project!.id, profileId: FAKE_PROFILE_ID, tokenBudget: 100000, mode: 'chat', content: 'denied' };
    await expect(service.dispatch(method, input)).rejects.toThrow('identity changed');
    fs.rmSync(pointer);
    expect([repositoryState(root), repositoryState(other)]).toEqual(before);
    expect(provider).not.toHaveBeenCalled();
    expect(store.db.prepare('SELECT * FROM tasks').all()).toEqual([]);
    expect(store.db.prepare('SELECT * FROM task_starts').all()).toEqual([]);
    expect(store.unknownIntents()).toBe(0);
  } finally { vi.restoreAllMocks(); await service.shutdown(); fs.rmSync(alias); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it.each(['chat', 'coordinated'] as const)('refuses same-common Git-directory rebinding on %s retry without ledger or execution effects', async mode => {
  const scratch = canonicalScratch('foundry-p2-gitdir-retry-');
  const root = path.join(scratch, 'root'); const first = path.join(scratch, 'first'); const second = path.join(scratch, 'second'); const common = path.join(scratch, 'common');
  for (const folder of [root, first, second, common]) fs.mkdirSync(folder);
  for (const folder of [first, second]) fs.writeFileSync(path.join(folder, 'commondir'), common);
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${first}\n`);
  const store = new Store(path.join(scratch, 'workspace.db'));
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const provider = vi.fn(() => { throw new Error('Provider must not start.'); });
  const service = new RuntimeService(store, repositories, () => {}, provider);
  const channel = new AgentChannel(store, service.redactor, () => {});
  const project = store.insertProject(root, 'git'); const stamp = '2026-01-02T03:04:05.678Z';
  const task = store.saveTask({ id: '18181818-0000-4000-8000-000000000002', title: 'saved', workspaceKind: 'git', worktreePath: root, branch: 'fixture', baseCommit: 'a'.repeat(40), projectPath: root, projectId: project.id, profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0, mode });
  channel.admit(task, channel.prepareAdmission(root));
  const input = { requestId: '18181818-0000-4000-8000-000000000003', projectId: project.id, profileId: FAKE_PROFILE_ID, mode, tokenBudget: 100000, content: 'denied' };
  store.reserveTaskStart(input.requestId, createHash('sha256').update(JSON.stringify(RpcMethods['task.start'].parse(input))).digest('hex'), task.id); store.finishTaskStart(input.requestId, 'failed');
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${second}\n`);
  const pending = vi.spyOn(store, 'finishTaskStart'); const resume = vi.spyOn(service.orchestrator, 'resume');
  const snapshot = () => JSON.stringify(['tasks', 'task_starts', 'intents', 'projects', 'events', 'messages'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  try {
    await expect(service.dispatch('task.start', input)).rejects.toThrow('Project channel identity changed.');
    expect(pending).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled(); expect(snapshot()).toBe(before);
  } finally { vi.restoreAllMocks(); await service.shutdown(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('rechecks metadata after executable resolution before the first Git command', async () => {
  const scratch = canonicalScratch('foundry-p2-git-await-');
  const root = path.join(scratch, 'root'); const metadata = path.join(scratch, 'metadata'); const other = path.join(scratch, 'other');
  fs.mkdirSync(root); fs.mkdirSync(metadata); fs.mkdirSync(other);
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${metadata}\n`);
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const git = vi.spyOn(repositories as unknown as { git(root: string, args: string[]): Promise<unknown> }, 'git').mockRejectedValue(new Error('Git must not start.'));
  vi.spyOn(repositories as unknown as { getGitExecutable(root: string): Promise<string> }, 'getGitExecutable').mockImplementation(async () => {
    await Promise.resolve(); fs.writeFileSync(path.join(metadata, 'commondir'), other); return process.execPath;
  });
  try {
    await expect(repositories.isGitWorkingTree(root)).rejects.toThrow('Project channel identity changed during admission.');
    expect(git).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('rejects a replaced approved alias after project classification without saving it', async () => {
  const scratch = canonicalScratch('foundry-p2-alias-await-');
  const root = path.join(scratch, 'root'); const other = path.join(scratch, 'other'); const alias = path.join(scratch, 'alias');
  fs.mkdirSync(root); fs.mkdirSync(other); fs.symlinkSync(root, alias, 'junction');
  const store = new Store(path.join(scratch, 'workspace.db'));
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const service = new RuntimeService(store, repositories, () => {});
  vi.spyOn(repositories, 'isGitWorkingTree').mockImplementation(async () => { await Promise.resolve(); fs.rmSync(alias); fs.symlinkSync(other, alias, 'junction'); return false; });
  const before = store.db.prepare('SELECT * FROM projects').all();
  try {
    await expect(service.dispatch('project.add', { path: alias })).rejects.toThrow('The saved folder now resolves to a different location.');
    expect(store.db.prepare('SELECT * FROM projects').all()).toEqual(before);
  } finally { vi.restoreAllMocks(); await service.shutdown(); fs.rmSync(alias); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it.each(['gitdir', 'commondir'] as const)('rejects network/device %s before classification can launch Git or mutate admission', async pointer => {
  const scratch = canonicalScratch('foundry-p2-git-preflight-');
  const root = path.join(scratch, 'root'); const metadata = path.join(scratch, 'metadata');
  fs.mkdirSync(root); fs.mkdirSync(metadata);
  const store = new Store(path.join(scratch, 'workspace.db'));
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const provider = vi.fn(() => { throw new Error('Provider must not start.'); });
  const service = new RuntimeService(store, repositories, () => {}, provider);
  const project = store.insertProject(root, 'git');
  // Stop at the process boundary even on the vulnerable path; no remote Git probe is allowed in this test.
  const executable = vi.spyOn(repositories as unknown as { getGitExecutable(root: string): Promise<string> }, 'getGitExecutable')
    .mockRejectedValue(new Error('Unexpected Git process lookup.'));
  const snapshot = () => JSON.stringify(['tasks', 'task_starts', 'intents', 'projects', 'events', 'messages'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  try {
    for (const target of ['\\\\server\\share\\git', '//server/share/git', '\\\\?\\C:\\git', '\\??\\C:\\git']) {
      fs.writeFileSync(path.join(root, '.git'), `gitdir: ${pointer === 'gitdir' ? target : metadata}\n`);
      if (pointer === 'commondir') fs.writeFileSync(path.join(metadata, 'commondir'), target);
      await expect(repositories.isGitWorkingTree(root)).rejects.toThrow('Projects on network shares are not supported.');
      // Use a second root for project.add so its existing-project fast path cannot mask classification.
      const added = path.join(scratch, `added-${target.length}`); fs.mkdirSync(added, { recursive: true });
      fs.copyFileSync(path.join(root, '.git'), path.join(added, '.git'));
      await expect(service.dispatch('project.add', { path: added })).rejects.toThrow('Projects on network shares are not supported.');
      await expect(service.dispatch('task.start', { requestId: '18181818-0000-4000-8000-000000000003', projectId: project.id, profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000, content: 'denied' })).rejects.toThrow('Projects on network shares are not supported.');
      expect(executable).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled(); expect(snapshot()).toBe(before);
    }
  } finally { vi.restoreAllMocks(); await service.shutdown(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it.each(['project.add', 'task.start'] as const)('rejects local metadata rebinding across %s classification without persisted changes', async method => {
  const scratch = canonicalScratch('foundry-p2-classification-rebind-');
  const root = path.join(scratch, 'root'); const metadata = path.join(scratch, 'metadata'); const other = path.join(scratch, 'other');
  fs.mkdirSync(root); fs.mkdirSync(metadata); fs.mkdirSync(other);
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${metadata}\n`);
  const store = new Store(path.join(scratch, 'workspace.db'));
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const provider = vi.fn(() => { throw new Error('Provider must not start.'); });
  const service = new RuntimeService(store, repositories, () => {}, provider);
  const project = method === 'task.start' ? store.insertProject(root, 'git') : undefined;
  vi.spyOn(repositories, 'isGitWorkingTree').mockImplementation(async () => { await Promise.resolve(); fs.writeFileSync(path.join(metadata, 'commondir'), other); return true; });
  const create = vi.spyOn(repositories, 'createTaskWorktree').mockRejectedValue(new Error('Worktree must not start.'));
  const snapshot = () => JSON.stringify(['tasks', 'task_starts', 'intents', 'projects', 'events', 'messages'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  try {
    const input = method === 'project.add' ? { path: root } : { requestId: '18181818-0000-4000-8000-000000000003', projectId: project!.id, profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000, content: 'denied' };
    await expect(service.dispatch(method, input)).rejects.toThrow('Project channel identity changed during admission.');
    expect(create).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled(); expect(snapshot()).toBe(before);
  } finally { vi.restoreAllMocks(); await service.shutdown(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('rejects raw network/device namespaces before any ancestor probe', () => {
  const probes = vi.spyOn(fs, 'lstatSync');
  try {
    for (const value of ['\\\\server\\share\\folder', '//server/share/folder', '\\\\?\\C:\\folder', '\\??\\C:\\folder'])
      expect(() => assertNoReparseDirectories(value)).toThrow('Projects on network shares are not supported.');
    expect(probes).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});

it('checks network alias metadata before missing descendants and canonicalization', async () => {
  const scratch = canonicalScratch('foundry-p2-folder-');
  const target = path.join(scratch, 'target'); const alias = path.join(scratch, 'alias');
  fs.mkdirSync(target); fs.symlinkSync(target, alias, 'junction');
  const probes = vi.spyOn(fs, 'lstatSync'); const canonical = vi.spyOn(fs.realpathSync, 'native');
  const asyncCanonical = vi.spyOn(asyncFs, 'realpath');
  vi.spyOn(fs, 'readlinkSync').mockReturnValue('\\\\host\\share');
  try {
    expect(() => resolveLocalPath(path.join(alias, 'missing', 'child'))).toThrow('Projects on network shares are not supported.');
    const repositories = new RepositoryService(path.join(scratch, 'wt'));
    await expect(repositories.listFiles(path.join(alias, 'missing'), '')).rejects.toThrow('Projects on network shares are not supported.');
    expect(probes.mock.calls.some(([value]) => String(value).startsWith(alias + path.sep))).toBe(false);
    expect(canonical).not.toHaveBeenCalled(); expect(asyncCanonical).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); fs.rmSync(alias); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('denies network alias projects before task/worktree admission or file probes', async () => {
  const scratch = canonicalScratch('foundry-p2-folder-service-');
  const target = path.join(scratch, 'target'); const alias = path.join(scratch, 'alias');
  fs.mkdirSync(target); fs.symlinkSync(target, alias, 'junction');
  const store = new Store(path.join(scratch, 'workspace.db'));
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const service = new RuntimeService(store, repositories, () => {});
  const projectId = '18181818-0000-4000-8000-000000000001'; const taskId = '18181818-0000-4000-8000-000000000002'; const stamp = '2026-01-02T03:04:05.678Z';
  store.db.prepare('INSERT INTO projects(id,path_key,data) VALUES(?,?,?)').run(projectId, 'stable-never-resolve', JSON.stringify({ id: projectId, path: alias, name: 'saved', hidden: false, kind: 'folder', createdAt: stamp, updatedAt: stamp }));
  store.saveTask({ id: taskId, title: 'saved', workspaceKind: 'folder', projectPath: alias, projectId, profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0, mode: 'chat' });
  const probes = vi.spyOn(fs, 'lstatSync'); const canonical = vi.spyOn(fs.realpathSync, 'native');
  const asyncCanonical = vi.spyOn(asyncFs, 'realpath'); const create = vi.spyOn(repositories, 'createTaskWorktree');
  vi.spyOn(fs, 'readlinkSync').mockReturnValue('\\\\host\\share');
  const before = JSON.stringify({ tasks: store.db.prepare('SELECT * FROM tasks').all(), starts: store.db.prepare('SELECT * FROM task_starts').all(), intents: store.db.prepare('SELECT * FROM intents').all(), projects: store.db.prepare('SELECT * FROM projects').all(), events: store.db.prepare('SELECT * FROM events').all() });
  try {
    await expect(service.dispatch('project.add', { path: alias })).rejects.toThrow('Projects on network shares are not supported.');
    await expect(service.dispatch('task.create', { title: 'denied', projectPath: alias, profileId: FAKE_PROFILE_ID, tokenBudget: 100000, mode: 'chat' })).rejects.toThrow('Projects on network shares are not supported.');
    await expect(service.dispatch('task.start', { requestId: '18181818-0000-4000-8000-000000000003', projectId, profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000, content: 'denied' })).rejects.toThrow('Project folder is unavailable or resolves to a different location.');
    await expect(service.dispatch('files.list', { taskId, path: '' })).rejects.toThrow('Projects on network shares are not supported.');
    await expect(service.dispatch('files.read', { taskId, path: 'missing.txt' })).rejects.toThrow('Projects on network shares are not supported.');
    const projects = await service.dispatch('workspace.projects', {}) as { projects: Array<{ kind: string; unavailableReason: string }> };
    expect(projects.projects[0]).toMatchObject({ kind: 'unavailable', unavailableReason: 'Folder is unavailable.' });
    await service.dispatch('workspace.summary', {});
    expect(canonical).not.toHaveBeenCalled(); expect(asyncCanonical).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(probes.mock.calls.some(([value]) => String(value).startsWith(alias + path.sep))).toBe(false);
    expect(JSON.stringify({ tasks: store.db.prepare('SELECT * FROM tasks').all(), starts: store.db.prepare('SELECT * FROM task_starts').all(), intents: store.db.prepare('SELECT * FROM intents').all(), projects: store.db.prepare('SELECT * FROM projects').all(), events: store.db.prepare('SELECT * FROM events').all() })).toBe(before);
  } finally { vi.restoreAllMocks(); await service.shutdown(); fs.rmSync(alias); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('retains normal local folder and file-path classification', () => {
  const scratch = canonicalScratch('foundry-p2-folder-local-');
  try {
    const folder = path.join(scratch, 'space 😀'); fs.mkdirSync(folder);
    expect(() => assertNoReparseDirectories(folder)).not.toThrow();
    const file = path.join(folder, 'ordinary.txt'); fs.writeFileSync(file, 'fixture');
    expect(() => assertNoReparseDirectories(file)).not.toThrow();
    expect(() => assertNoReparseDirectories('relative-folder')).toThrow('Repository root must be an absolute path.');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('preserves a local alias at admission and stores its canonical project identity', async () => {
  const scratch = canonicalScratch('foundry-p2-alias-positive-');
  const target = path.join(scratch, 'space 😀'); const alias = path.join(scratch, 'alias');
  fs.mkdirSync(target); fs.symlinkSync(target, alias, 'junction');
  const store = new Store(path.join(scratch, 'workspace.db'));
  const service = new RuntimeService(store, new RepositoryService(path.join(scratch, 'wt')), () => {});
  try {
    expect(resolveLocalPath(alias, target)).toBe(fs.realpathSync.native(target));
    const project = await service.dispatch('project.add', { path: alias }) as { id: string; path: string };
    expect(project.path).toBe(fs.realpathSync.native(target));
    const row = store.db.prepare('SELECT path_key FROM projects WHERE id = ?').get(project.id);
    await service.dispatch('workspace.projects', {});
    expect(store.db.prepare('SELECT path_key FROM projects WHERE id = ?').get(project.id)).toEqual(row);
  } finally { await service.shutdown(); fs.rmSync(alias); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it('rejects a failed-start retry after root replacement without ledger or Git activity', async () => {
  const scratch = canonicalScratch('foundry-p2-alias-retry-');
  const approved = path.join(scratch, 'approved'); const original = path.join(scratch, 'original'); const other = path.join(scratch, 'other');
  fs.mkdirSync(approved); fs.mkdirSync(other);
  const store = new Store(path.join(scratch, 'workspace.db'));
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const service = new RuntimeService(store, repositories, () => {});
  const project = store.insertProject(approved); const stamp = '2026-01-02T03:04:05.678Z';
  const taskId = '18181818-0000-4000-8000-000000000002';
  store.saveTask({ id: taskId, title: 'saved', workspaceKind: 'folder', projectPath: approved, projectId: project.id, profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0, mode: 'chat' });
  const input = { requestId: '18181818-0000-4000-8000-000000000003', projectId: project.id, profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000, content: 'denied' };
  store.reserveTaskStart(input.requestId, createHash('sha256').update(JSON.stringify(RpcMethods['task.start'].parse(input))).digest('hex'), taskId); store.finishTaskStart(input.requestId, 'failed');
  fs.renameSync(approved, original); fs.symlinkSync(other, approved, 'junction');
  const git = vi.spyOn(repositories, 'isGitWorkingTree'); const create = vi.spyOn(repositories, 'createTaskWorktree');
  const snapshot = () => JSON.stringify(['tasks', 'task_starts', 'intents', 'projects', 'events', 'messages'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  try {
    await expect(service.dispatch('task.start', input)).rejects.toThrow('Project folder is unavailable or resolves to a different location.');
    expect(git).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(snapshot()).toBe(before);
  } finally { vi.restoreAllMocks(); await service.shutdown(); fs.rmSync(approved); fs.rmSync(scratch, { recursive: true, force: true }); }
});

it.each(['chat', 'coordinated'] as const)('rejects %s retry metadata rebinding before pending, orchestration or provider work', async mode => {
  const scratch = canonicalScratch('foundry-p2-git-retry-');
  const root = path.join(scratch, 'root'); const metadata = path.join(scratch, 'metadata'); const other = path.join(scratch, 'other');
  fs.mkdirSync(root); fs.mkdirSync(metadata); fs.mkdirSync(other);
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${metadata}\n`);
  const store = new Store(path.join(scratch, 'workspace.db'));
  const repositories = new RepositoryService(path.join(scratch, 'wt'));
  const provider = vi.fn(() => { throw new Error('Provider must not start.'); });
  const service = new RuntimeService(store, repositories, () => {}, provider);
  const channel = new AgentChannel(store, service.redactor, () => {});
  const project = store.insertProject(root, 'git'); const stamp = '2026-01-02T03:04:05.678Z';
  const taskId = '18181818-0000-4000-8000-000000000002';
  const task = store.saveTask({ id: taskId, title: 'saved', workspaceKind: 'git', worktreePath: root, branch: 'fixture', baseCommit: 'a'.repeat(40), projectPath: root, projectId: project.id, profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0, mode });
  channel.admit(task, channel.prepareAdmission(root));
  const input = { requestId: '18181818-0000-4000-8000-000000000003', projectId: project.id, profileId: FAKE_PROFILE_ID, mode, tokenBudget: 100000, content: 'denied' };
  store.reserveTaskStart(input.requestId, createHash('sha256').update(JSON.stringify(RpcMethods['task.start'].parse(input))).digest('hex'), taskId); store.finishTaskStart(input.requestId, 'failed');
  fs.writeFileSync(path.join(metadata, 'commondir'), other);
  const pending = vi.spyOn(store, 'finishTaskStart'); const resume = vi.spyOn(service.orchestrator, 'resume');
  const git = vi.spyOn(repositories, 'isGitWorkingTree');
  const snapshot = () => JSON.stringify(['tasks', 'task_starts', 'intents', 'projects', 'events', 'messages'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  try {
    await expect(service.dispatch('task.start', input)).rejects.toThrow('Project channel identity changed.');
    expect(pending).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled(); expect(git).not.toHaveBeenCalled(); expect(snapshot()).toBe(before);
  } finally { vi.restoreAllMocks(); await service.shutdown(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
