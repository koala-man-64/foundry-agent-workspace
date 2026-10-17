import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitTask as Task } from '../../packages/protocol/src/index';
import { isNetworkRemote, isPermittedRemoteForm, RepositoryService, requireSupportedRemotes, unsupportedRemoteMessage, windowsDriveType } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { runGit, withIsolatedGit } from '../p2/repository-fixture';

// Security fixes that landed natively first (review of #36 and Rudy's push allowlist, 17 October 2026), dual-landed in the
// shipping TypeScript runtime with native's semantics and messages: TaskPublicationTests is the native counterpart. Fixture
// and runtime Git share an isolated HOME with no system configuration; every remote is a local folder or a loopback share.
const FOREIGN = "The task worktree no longer belongs to the task's project repository.";
const refused = (shown: string) => `Push refused: the repository's own Git configuration sets ${shown}, which push does not trust. Move it to your global Git configuration or remove it.`;
const LOOPBACK_SHARES = ['\\\\127.0.0.1\\foundry-missing-share\\repo.git', 'file://127.0.0.1/foundry-missing-share/repo.git', 'file:///%2F%2F127.0.0.1/foundry-missing-share/repo.git'];

type Fixture = { scratch: string; home: string; repo: string; git: (...args: string[]) => string; store: Store; repositories: RepositoryService; runtime: RuntimeService };
const open: Fixture[] = [];

afterEach(async () => {
  for (const fixture of open.splice(0)) {
    await fixture.runtime.shutdown();
    fs.rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

/** A committed project with a local bare `origin`, and the shipping runtime over a fresh store. */
function project(options: { objectFormat?: 'sha256'; files?: Record<string, string> } = {}): Fixture {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-publication-guards-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const git = (...args: string[]) => runGit(scratch, home, args).trim();
  const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
  const format = options.objectFormat ? ['--object-format', options.objectFormat] : [];
  git('-C', 'repo', 'init', '-q', ...format);
  git('-C', 'repo', 'config', 'user.name', 'Runtime'); git('-C', 'repo', 'config', 'user.email', 'runtime@example.invalid');
  for (const [name, text] of Object.entries({ 'README.md': 'hello\n', ...options.files })) fs.writeFileSync(path.join(repo, name), text);
  git('-C', 'repo', 'add', '-A'); git('-C', 'repo', 'commit', '-qm', 'fixture');
  git('init', '-q', '--bare', ...format, 'remote.git'); git('-C', 'repo', 'remote', 'add', 'origin', path.join(scratch, 'remote.git'));
  const store = new Store(path.join(scratch, 'data', 'workspace.db'));
  const repositories = new RepositoryService(path.join(scratch, 'data', 'wt'));
  const runtime = new RuntimeService(store, repositories, () => {}, () => { throw new Error('Provider must not start.'); });
  const fixture = { scratch, home, repo, git, store, repositories, runtime };
  open.push(fixture);
  return fixture;
}

/** Runs body with the fixture's isolated Git environment applied to the runtime's Git as well. */
const isolated = <T>(fixture: Fixture, body: () => Promise<T>): Promise<T> => withIsolatedGit(fixture.home, body);

async function createTask(fixture: Fixture): Promise<Task> {
  return await fixture.runtime.dispatch('task.create', { title: 'Publication', projectPath: fixture.repo, profileId: FAKE_PROFILE_ID, tokenBudget: 100000 }) as Task;
}

const states = (fixture: Fixture, kind: string) => (fixture.store.db.prepare('SELECT state FROM intents WHERE kind = ? ORDER BY rowid').all(kind) as { state: string }[]).map(row => row.state);
const push = (fixture: Fixture, task: Task) => fixture.runtime.dispatch('task.push', { taskId: task.id, remote: 'origin', confirm: 'push' });
const commit = (fixture: Fixture, task: Task, message = 'Change') => fixture.runtime.dispatch('task.commit', { taskId: task.id, message });

describe('publication guards dual-landed from the native runtime', () => {
  it('refuses a push, before Git connects, when the repository configuration could run a program or redirect it', async () => {
    const fixture = project(); const { git, scratch } = fixture;
    await isolated(fixture, async () => {
      const marker = path.join(scratch, 'program-ran');
      const program = `!echo ran > "${marker.replaceAll('\\', '/')}"`;
      fs.writeFileSync(path.join(scratch, 'included.cfg'), '[core]\n\tsshCommand = evil\n');
      const task = await createTask(fixture);
      fs.writeFileSync(path.join(task.worktreePath, 'README.md'), 'changed\n');
      await commit(fixture, task);
      const cases: [key: string, shown: string, value: string][] = [
        ['credential.helper', 'credential.helper', program],
        ['credential.https://example.invalid.helper', 'credential.*.helper', program],
        ['core.sshCommand', 'core.sshcommand', program],
        ['remote.origin.receivepack', 'remote.*.receivepack', program],
        ['protocol.ext.allow', 'protocol.*.allow', 'always'],
        ['url.https://token@example.invalid/.insteadOf', 'url.*.insteadof', 'origin'],
        ['include.path', 'include.path', path.join(scratch, 'included.cfg')],
      ];
      for (const [key, shown, value] of cases) {
        git('-C', 'repo', 'config', key, value);
        await expect(push(fixture, task)).rejects.toThrow(refused(shown));
        await expect(fixture.repositories.verifyPushOutcome(fixture.repo, task.worktreePath, undefined, 'origin', task.branch)).resolves.toBeUndefined();
        git('-C', 'repo', 'config', '--unset-all', key);
      }
      // The worktree's own scope is screened too.
      git('-C', 'repo', 'config', 'extensions.worktreeConfig', 'true');
      git('-C', task.worktreePath, 'config', '--worktree', 'core.sshCommand', program);
      await expect(push(fixture, task)).rejects.toThrow(refused('core.sshcommand'));
      git('-C', task.worktreePath, 'config', '--worktree', '--unset-all', 'core.sshCommand');
      expect(states(fixture, 'git.push')).toEqual(Array(cases.length + 1).fill('complete'));
      expect(git('--git-dir', path.join(scratch, 'remote.git'), 'for-each-ref')).toBe('');
      // Inert keys stay usable, and the push then goes through.
      git('-C', 'repo', 'config', 'core.autocrlf', 'false'); git('-C', 'repo', 'config', 'pull.rebase', 'true');
      git('-C', 'repo', 'config', `branch.${task.branch}.remote`, 'origin');
      await push(fixture, task);
      await expect(fixture.repositories.verifyPushOutcome(fixture.repo, task.worktreePath, undefined, 'origin', task.branch)).resolves.toBe(true);
      expect(git('--git-dir', path.join(scratch, 'remote.git'), 'for-each-ref')).toContain(`refs/heads/${task.branch}`);
      expect(fs.existsSync(marker)).toBe(false);
    });
  }, 180_000);

  it('limits a push and a remote check to https, ssh and local paths, even when global configuration allows more', async () => {
    const fixture = project(); const { git, scratch } = fixture;
    await isolated(fixture, async () => {
      const marker = path.join(scratch, 'ext-ran.git');
      // The user's global configuration is not screened. There, a protocol-specific key beats the generic one, and a
      // remote.*.vcs sends a URL that passes the remote check through the ext helper, which runs the URL as a command.
      git('config', '--global', 'protocol.allow', 'always'); git('config', '--global', 'protocol.ext.allow', 'always');
      git('config', '--global', 'remote.origin.vcs', 'ext');
      git('-C', 'repo', 'remote', 'set-url', 'origin', `git init -q --bare ${marker.replaceAll('\\', '/').replaceAll(' ', '% ')}`);
      // Control: under that configuration, Git itself runs the helper's command.
      expect(() => git('-C', 'repo', 'ls-remote', 'origin')).toThrow();
      expect(fs.existsSync(marker)).toBe(true);
      fs.rmSync(marker, { recursive: true, force: true });
      const head = git('-C', 'repo', 'rev-parse', 'HEAD');
      await expect(fixture.repositories.verifyPushOutcome(fixture.repo, fixture.repo, undefined, 'origin', 'main', head)).resolves.toBeUndefined();
      await expect(fixture.repositories.push(fixture.repo, fixture.repo, undefined, 'origin', 'main')).rejects.toThrow("transport 'ext' not allowed");
      expect(fs.existsSync(marker)).toBe(false);
    });
  }, 120_000);

  it('recognizes network-share remotes in every spelling Git accepts', async () => {
    const fixed = async () => 3;
    const cases: [string, boolean][] = [
      ['https://example.invalid/owner/repo.git', false], ['ssh://git@example.invalid/owner/repo.git', false],
      ['git@example.invalid:owner/repo.git', false], ['example.invalid:repo.git', false],
      ['C:/Users/someone/repo.git', false], ['C:\\Users\\someone\\repo.git', false], ['../dest.git', false],
      ['file:///C:/Users/someone/repo.git', false], ['file://localhost/C:/repo.git', true],
      ['\\\\host\\share\\repo.git', true], ['//host/share/repo.git', true], ['\\\\?\\UNC\\host\\share\\repo.git', true],
      ['file://host/share/repo.git', true], ['file:////host/share/repo.git', true], ['\\\\.\\pipe\\repo', true],
      // Git percent-decodes file:// URLs, so any file:// URL holding a percent sign is refused rather than decoded.
      ['file:///%2F%2Fhost/share/repo.git', true], ['FILE:///%2f%2fhost/share/repo.git', true], ['file://localhost/%2F%2Fhost/share', true], ['file:///C:/re%70o.git', true],
    ];
    for (const [url, network] of cases) expect([url, await isNetworkRemote(url, fixed)]).toEqual([url, network]);
    // A drive letter mapped to a share (Network) or not present (NoRootDirectory) is refused; other drive types are not.
    for (const [type, network] of [[1, true], [4, true], [0, false], [2, false], [3, false], [5, false], [6, false]] as const) {
      expect(await isNetworkRemote('Z:/repo.git', async letter => { expect(letter).toBe('Z'); return type; })).toBe(network);
      expect(await isNetworkRemote('file:///Z:/repo.git', async () => type)).toBe(network);
    }
    await expect(isNetworkRemote('Z:/repo.git', () => Promise.reject(new Error('unavailable')))).rejects.toThrow('unavailable');
    // The real query: the system drive is a fixed disk.
    expect(await windowsDriveType((process.env.SystemDrive ?? 'C:')[0]!)).toBe(3);
  }, 60_000);

  it('refuses a push to a network-share remote, and leaves its remote check unknown', async () => {
    const fixture = project(); const { git } = fixture;
    await isolated(fixture, async () => {
      const task = await createTask(fixture);
      fs.writeFileSync(path.join(task.worktreePath, 'README.md'), 'changed\n');
      await commit(fixture, task);
      // A letter with no drive behind it stands in for a mapped or disconnected one; the query itself reads no share.
      let missing: string | undefined;
      for (const letter of 'ZYXWVUTSRQPONMLKJIH') if (await windowsDriveType(letter) === 1) { missing = letter; break; }
      expect(missing).toBeDefined();
      for (const url of [...LOOPBACK_SHARES, `${missing}:/foundry-missing/repo.git`]) {
        git('-C', 'repo', 'remote', 'set-url', 'origin', url);
        await expect(push(fixture, task)).rejects.toThrow(unsupportedRemoteMessage('origin'));
        await expect(fixture.repositories.verifyPushOutcome(fixture.repo, task.worktreePath, undefined, 'origin', task.branch)).resolves.toBeUndefined();
      }
      expect(states(fixture, 'git.push')).toEqual(['complete', 'complete', 'complete', 'complete']);
    });
  }, 180_000);

  it('refuses a local remote reached through a link, then pushes through its real path', async () => {
    const fixture = project(); const { git, scratch } = fixture;
    await isolated(fixture, async () => {
      git('init', '-q', '--bare', 'remotes/dest.git');
      // A junction stands in for a directory symbolic link, which could lead to a share; it needs no elevation.
      fs.symlinkSync(path.join(scratch, 'remotes'), path.join(scratch, 'linked'), 'junction');
      git('-C', 'repo', 'remote', 'set-url', 'origin', path.join(scratch, 'linked', 'dest.git'));
      const task = await createTask(fixture);
      fs.writeFileSync(path.join(task.worktreePath, 'README.md'), 'changed\n');
      await commit(fixture, task);
      await expect(push(fixture, task)).rejects.toThrow(unsupportedRemoteMessage('origin'));
      await expect(fixture.repositories.verifyPushOutcome(fixture.repo, task.worktreePath, undefined, 'origin', task.branch)).resolves.toBeUndefined();
      expect(git('--git-dir', path.join(scratch, 'remotes', 'dest.git'), 'for-each-ref')).toBe('');
      git('-C', 'repo', 'remote', 'set-url', 'origin', path.join(scratch, 'remotes', 'dest.git'));
      await push(fixture, task);
      expect(git('--git-dir', path.join(scratch, 'remotes', 'dest.git'), 'for-each-ref')).toContain(`refs/heads/${task.branch}`);
      expect(states(fixture, 'git.push')).toEqual(['complete', 'complete']);
    });
  }, 120_000);

  it('refuses, with no outcome, a remote Git would refuse only once running, then pushes to the real one', async () => {
    const fixture = project(); const { git, scratch } = fixture;
    await isolated(fixture, async () => {
      const real = path.join(scratch, 'remote.git').replaceAll('\\', '/');
      // Transports the protocol restriction denies, and spellings Git resolves elsewhere than the check would.
      const urls = ['http://127.0.0.1:9/x.git', 'git://127.0.0.1:9/x.git', 'ext::git --version', 'foo::bar', 'https::https://127.0.0.1:9/x.git',
        'HTTPS://127.0.0.1:9/x.git', 'SSH://127.0.0.1:9/x.git', `FILE:///${real}`, `file://localhost/${real}`, '~/remote.git', `${real.slice(0, 2)}remote.git`,
        ' ssh://127.0.0.1/x.git', 'rsync:127.0.0.1/x', 'ssh://-oProxyCommand=x/y'];
      const task = await createTask(fixture);
      fs.writeFileSync(path.join(task.worktreePath, 'README.md'), 'changed\n');
      await commit(fixture, task);
      for (const url of urls) {
        git('-C', 'repo', 'remote', 'set-url', 'origin', url);
        await expect([url, await push(fixture, task).then(() => 'pushed', (error: Error) => error.message)]).toEqual([url, unsupportedRemoteMessage('origin')]);
        await expect(fixture.repositories.verifyPushOutcome(fixture.repo, task.worktreePath, undefined, 'origin', task.branch)).resolves.toBeUndefined();
      }
      expect(states(fixture, 'git.push')).toEqual(Array(urls.length).fill('complete'));
      git('-C', 'repo', 'remote', 'set-url', 'origin', path.join(scratch, 'remote.git'));
      await push(fixture, task);
      expect(git('--git-dir', path.join(scratch, 'remote.git'), 'for-each-ref')).toContain(`refs/heads/${task.branch}`);
    });
  }, 180_000);

  it('admits only the URL forms Git uses under the protocol restriction', () => {
    // The same cases as native PermittedRemoteFormsAreThoseGitUses.
    const cases: [string, boolean][] = [
      ['https://example.invalid/r.git', true], ['ssh://git@example.invalid/r.git', true], ['git+ssh://example.invalid/r.git', true],
      ['ssh+git://example.invalid/r.git', true], ['file:///C:/r.git', true], ['git@example.invalid:r.git', true], ['C:/r.git', true],
      ['../r.git', true], ['ssh://user@-host/r.git', true], ['ssh://example.invalid:-p/r.git', true],
      ['http://example.invalid/r.git', false], ['git://example.invalid/r.git', false], ['ext::git --version', false], ['foo::bar', false],
      ['https::https://example.invalid/r.git', false], ['HTTPS://example.invalid/r.git', false], ['FILE:///C:/r.git', false], ['foo bar://x', false],
      ['://x', false], [' ssh://example.invalid/r.git', false], ['\thttps://example.invalid/r.git', false], ['-oProxyCommand=x:y', false],
      ['rsync:example.invalid/r', false], ['ssh://-oProxyCommand=x/y', false], ['git+ssh://-oProxyCommand=x/y', false],
    ];
    for (const [url, permitted] of cases) expect([url, isPermittedRemoteForm(url)]).toEqual([url, permitted]);
  });

  it('accepts only a link-free local folder on a fixed drive as a local remote', async () => {
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-supported-remotes-')));
    try {
      fs.mkdirSync(path.join(scratch, 'remotes', 'dest.git'), { recursive: true });
      fs.writeFileSync(path.join(scratch, 'remotes', 'bundle'), 'not a folder');
      fs.symlinkSync(path.join(scratch, 'remotes'), path.join(scratch, 'linked'), 'junction');
      const types: Record<string, number> = { [scratch[0]!.toUpperCase()]: 3, R: 2, Z: 4, Q: 1 };
      const driveType = async (letter: string) => types[letter.toUpperCase()] ?? 0;
      const check = (url: string, cwd = path.join(scratch, 'repo')) => requireSupportedRemotes(cwd, 'origin', [url], driveType);
      const unsupported = unsupportedRemoteMessage('origin');
      for (const url of ['https://example.invalid/owner/repo.git', 'git@example.invalid:owner/repo.git', 'ssh://git@example.invalid/owner/repo.git',
        'git+ssh://git@example.invalid/owner/repo.git', 'ssh+git://git@example.invalid/owner/repo.git', path.join(scratch, 'remotes', 'dest.git'),
        path.join(scratch, 'remotes', 'missing', 'deeper.git'), '../remotes/dest.git', `file:///${path.join(scratch, 'remotes', 'dest.git').replaceAll('\\', '/')}`]) {
        await expect(check(url)).resolves.toBeUndefined();
      }
      for (const url of [path.join(scratch, 'linked', 'dest.git'), '../linked/dest.git', path.join(scratch, 'remotes', 'bundle'), path.join(scratch, 'remotes', 'bundle', 'inside.git'),
        'R:/repo.git', 'Z:/repo.git', 'Q:/repo.git', `${scratch[0]}:relative.git`, path.join(scratch, 'remotes', 'dest.git.'), path.join(scratch, 'remotes ', 'dest.git'),
        '', 'file://', 'file:///C:/re%70o.git', '\\\\127.0.0.1\\share\\repo.git', `${path.join(scratch, 'remotes')}\0x`,
        // Forms Git would refuse only once running, and spellings it resolves elsewhere than the check would.
        'http://example.invalid/r.git', 'git://example.invalid/r.git', 'ext::git --version', 'foo::bar', 'https::https://example.invalid/r.git',
        'HTTPS://example.invalid/r.git', 'SSH://example.invalid/r.git', `FILE:///${path.join(scratch, 'remotes', 'dest.git').replaceAll('\\', '/')}`,
        `file://localhost/${path.join(scratch, 'remotes', 'dest.git').replaceAll('\\', '/')}`, '~/dest.git', '~user/dest.git', 'foo bar://x', '://x']) {
        await expect([url, await check(url).then(() => 'accepted', (error: Error) => error.message)]).toEqual([url, unsupported]);
      }
      // Every URL is checked: one unsupported push URL refuses the remote.
      await expect(requireSupportedRemotes(scratch, 'origin', ['https://example.invalid/r.git', path.join(scratch, 'linked', 'dest.git')], driveType)).rejects.toThrow(unsupported);
      // A drive type that cannot be established refuses; push turns any such failure into "none".
      await expect(requireSupportedRemotes(scratch, 'origin', ['Z:/repo.git'], () => Promise.reject(new Error('unavailable')))).rejects.toThrow('unavailable');
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }, 60_000);

  it('screens both endpoints of a rename, and the staged paths without rename detection, before committing', async () => {
    const fixture = project({ files: { '.env': 'TOKEN=secret\n' } }); const { git } = fixture;
    await isolated(fixture, async () => {
      const task = await createTask(fixture);
      const head = git('-C', task.worktreePath, 'rev-parse', 'HEAD');
      // A staged rename: porcelain writes the secret-named source after the destination.
      git('-C', task.worktreePath, 'mv', '.env', 'safe.txt');
      await expect(commit(fixture, task)).rejects.toThrow('Refusing to commit secret-named paths: .env. Remove or ignore them first.');
      expect(states(fixture, 'git.commit')).toEqual(['complete']);
      git('-C', task.worktreePath, 'mv', 'safe.txt', '.env');
      expect(git('-C', task.worktreePath, 'status', '--porcelain')).toBe('');
      // A worktree rename of an intent-to-add path, which status reports in its second column, is screened the same way.
      fs.renameSync(path.join(task.worktreePath, '.env'), path.join(task.worktreePath, 'safe.txt'));
      git('-C', task.worktreePath, 'add', '-N', 'safe.txt');
      await expect(commit(fixture, task)).rejects.toThrow('Refusing to commit secret-named paths: .env. Remove or ignore them first.');
      expect(states(fixture, 'git.commit')).toEqual(['complete', 'complete']);
      expect(git('-C', task.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    });
  }, 120_000);

  it('screens the staged paths without rename detection when a secret file is renamed while the commit runs', async () => {
    const fixture = project({ files: { '.env': 'TOKEN=secret\n' } }); const { git } = fixture;
    await isolated(fixture, async () => {
      const task = await createTask(fixture);
      const head = git('-C', task.worktreePath, 'rev-parse', 'HEAD');
      fs.writeFileSync(path.join(task.worktreePath, 'README.md'), 'changed\n');
      // After the status screen and before `git add`, a same-user process renames the tracked secret. The staged listing
      // with rename detection names only safe.txt, so the listing without it is what refuses, after staging.
      const service = fixture.repositories as unknown as { rejectFilters: (...args: unknown[]) => Promise<void> };
      const rejectFilters = service.rejectFilters.bind(fixture.repositories); let renamed = false;
      service.rejectFilters = async (...args: unknown[]) => {
        await rejectFilters(...args);
        if (!renamed) { renamed = true; fs.renameSync(path.join(task.worktreePath, '.env'), path.join(task.worktreePath, 'safe.txt')); }
      };
      await expect(commit(fixture, task)).rejects.toThrow('A secret-named path was staged; the index was reset and nothing was committed.');
      expect(renamed).toBe(true);
      expect(states(fixture, 'git.commit')).toEqual(['unknown']);
      expect(git('-C', task.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
      expect(git('-C', task.worktreePath, 'diff', '--cached', '--name-only')).toBe('');
      await expect(fixture.runtime.dispatch('task.reconcilePublication', { taskId: task.id })).resolves.toMatchObject({ reconciled: true });
      expect(states(fixture, 'git.commit')).toEqual(['failed']);
    });
  }, 120_000);

  it('keeps the worktree identity pinned through a push, so a folder replaced during it is never pushed from', async () => {
    const fixture = project(); const { git, scratch } = fixture;
    await isolated(fixture, async () => {
      const task = await createTask(fixture);
      fs.writeFileSync(path.join(task.worktreePath, 'README.md'), 'changed\n');
      await commit(fixture, task);
      git('init', '-q', '--bare', 'evil.git');
      // Once the configuration screen has passed, the worktree folder is replaced by a clone on the task branch whose
      // origin is another repository. Every later Git call of the push revalidates the admitted identity.
      const service = fixture.repositories as unknown as { requireTrustedPushConfiguration: (...args: unknown[]) => Promise<void> };
      const screen = service.requireTrustedPushConfiguration.bind(fixture.repositories);
      service.requireTrustedPushConfiguration = async (...args: unknown[]) => {
        await screen(...args);
        fs.renameSync(task.worktreePath, `${task.worktreePath}-moved`);
        git('clone', '-q', fixture.repo, task.worktreePath);
        git('-C', task.worktreePath, 'checkout', '-q', '-b', task.branch);
        git('-C', task.worktreePath, 'remote', 'set-url', 'origin', path.join(scratch, 'evil.git'));
      };
      await expect(push(fixture, task)).rejects.toThrow('Project channel identity changed during admission.');
      expect(git('--git-dir', path.join(scratch, 'evil.git'), 'for-each-ref')).toBe('');
      expect(git('--git-dir', path.join(scratch, 'remote.git'), 'for-each-ref')).toBe('');
    });
  }, 120_000);

  it('refuses to commit or push from a worktree that no longer belongs to the task project or its bound identity', async () => {
    const fixture = project(); const { git, scratch, store } = fixture;
    await isolated(fixture, async () => {
      const task = await createTask(fixture);
      fs.writeFileSync(path.join(task.worktreePath, 'README.md'), 'changed\n');
      const binding = store.db.prepare("SELECT id, data FROM intents WHERE kind = 'channel.identity'").get() as { id: string; data: string };
      const bound = JSON.parse(binding.data) as { identity: Record<string, unknown> };
      expect(store.boundCommon(task.id)).toBe(path.join(fixture.repo, '.git'));
      // A tampered binding.
      store.db.prepare('UPDATE intents SET data = ? WHERE id = ?').run(JSON.stringify({ ...bound, identity: { ...bound.identity, common: path.join(scratch, 'elsewhere', '.git') } }), binding.id);
      await expect(commit(fixture, task)).rejects.toThrow(FOREIGN);
      await expect(push(fixture, task)).rejects.toThrow(FOREIGN);
      store.db.prepare('UPDATE intents SET data = ? WHERE id = ?').run(binding.data, binding.id);
      // The worktree folder replaced by a clone on the task branch, with its own remote and a crafted change on the base:
      // a parent, message and clean tree that would otherwise reconcile an unknown commit as complete.
      fs.renameSync(task.worktreePath, `${task.worktreePath}-moved`);
      git('init', '-q', '--bare', 'evil.git');
      git('clone', '-q', fixture.repo, task.worktreePath);
      git('-C', task.worktreePath, 'checkout', '-q', '-b', task.branch, task.baseCommit);
      fs.writeFileSync(path.join(task.worktreePath, 'README.md'), 'replaced\n');
      git('-C', task.worktreePath, 'commit', '-qam', 'Change');
      git('-C', task.worktreePath, 'remote', 'set-url', 'origin', path.join(scratch, 'evil.git'));
      await expect(fixture.repositories.verifyCommitOutcome(task.worktreePath, fixture.repo, store.boundCommon(task.id), task.baseCommit, 'Change')).resolves.toBeUndefined();
      await expect(fixture.repositories.verifyPushOutcome(fixture.repo, task.worktreePath, store.boundCommon(task.id), 'origin', task.branch)).resolves.toBeUndefined();
      await expect(push(fixture, task)).rejects.toThrow(FOREIGN);
      fs.writeFileSync(path.join(task.worktreePath, 'README.md'), 'replaced again\n');
      await expect(commit(fixture, task)).rejects.toThrow(FOREIGN);
      expect(states(fixture, 'git.commit')).toEqual(['complete', 'complete']);
      expect(states(fixture, 'git.push')).toEqual(['complete', 'complete']);
      expect(git('--git-dir', path.join(scratch, 'evil.git'), 'for-each-ref')).toBe('');
      // A task saved before bindings existed still needs the worktree to share the project's common directory.
      store.db.prepare('DELETE FROM intents WHERE id = ?').run(binding.id);
      expect(store.boundCommon(task.id)).toBeUndefined();
      await expect(fixture.repositories.verifyCommitOutcome(task.worktreePath, fixture.repo, undefined, task.baseCommit, 'Change')).resolves.toBeUndefined();
      await expect(push(fixture, task)).rejects.toThrow(FOREIGN);
      await expect(commit(fixture, task)).rejects.toThrow(FOREIGN);
      expect(git('--git-dir', path.join(scratch, 'evil.git'), 'for-each-ref')).toBe('');
      expect(git('-C', task.worktreePath, 'log', '-1', '--format=%s')).toBe('Change');
    });
  }, 180_000);

  it('leaves a push unknown when its push and fetch URLs differ, and verifies SHA-256 remote tips', async () => {
    const fixture = project(); const { git, scratch } = fixture;
    await isolated(fixture, async () => {
      const head = git('-C', 'repo', 'rev-parse', 'HEAD');
      git('init', '-q', '--bare', 'pushed.git');
      git('-C', 'repo', 'remote', 'set-url', '--push', 'origin', path.join(scratch, 'pushed.git'));
      git('-C', 'repo', 'push', '-q', 'origin', 'main');
      expect(git('--git-dir', path.join(scratch, 'pushed.git'), 'rev-parse', 'main')).toBe(head);
      await expect(fixture.repositories.verifyPushOutcome(fixture.repo, fixture.repo, undefined, 'origin', 'main', head)).resolves.toBeUndefined();
      // Control: with one URL, the same check judges the remote.
      git('-C', 'repo', 'config', '--unset', 'remote.origin.pushurl');
      await expect(fixture.repositories.verifyPushOutcome(fixture.repo, fixture.repo, undefined, 'origin', 'main', head)).resolves.toBe(false);
    });
    const sha256 = project({ objectFormat: 'sha256' });
    await isolated(sha256, async () => {
      const tip = sha256.git('-C', 'repo', 'rev-parse', 'HEAD');
      expect(tip).toMatch(/^[0-9a-f]{64}$/);
      sha256.git('-C', 'repo', 'push', '-q', 'origin', 'main');
      await expect(sha256.repositories.verifyPushOutcome(sha256.repo, sha256.repo, undefined, 'origin', 'main', tip)).resolves.toBe(true);
    });
  }, 120_000);
});
