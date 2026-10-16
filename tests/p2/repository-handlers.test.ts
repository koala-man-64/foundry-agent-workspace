import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { RpcMethod } from '../../packages/protocol/src/index';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { build, committed, expand, file, normalize, sha256File, withIsolatedGit, type Step } from './repository-fixture';

// RPC outcomes of the shipping TypeScript RuntimeService for the Git/files handlers over seeded tasks and disposable
// trees. The C# conformance suite (RepositoryHandlerTests) seeds the same tasks into a fresh Store, rebuilds every tree,
// dispatches the same calls through DevelopmentChat and must reproduce each outcome or its named native difference, and
// both runtimes must leave every persisted row unchanged. Placeholders: {scratch} {scratch/}.
type Call = { method: RpcMethod; params: Record<string, unknown> };
type Outcome = { result: unknown } | { error: string } | { systemError: string };
type Case = { name: string; tree: Step[]; tasks: Record<string, unknown>[]; calls: Call[]; native?: Record<number, { outcome: Outcome; difference: string }> };

const ALIAS = 'Native refuses local aliases (approved difference until Rudy decides otherwise).';
const STAMP = '2026-01-02T03:04:05.678Z';
const SECRET = 'sk-abcdefghijklmnopqrstuvwx';
const id = (n: number) => `20202020-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = (n: number) => ({ id: id(n), title: 'Seeded', profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: STAMP, updatedAt: STAMP, tokenBudget: 100000, usedTokens: 0, mode: 'chat' });
const folder = (n: number, projectPath: string) => ({ ...base(n), workspaceKind: 'folder', projectPath });
const gitTask = (n: number, worktree: string, legacy = false) => ({ ...base(n), ...(legacy ? {} : { workspaceKind: 'git' }), projectPath: worktree, worktreePath: worktree, branch: 'main', baseCommit: '0'.repeat(40) });
const none = (n: number) => ({ ...base(n), workspaceKind: 'none' });
const list = (n: number, relative = ''): Call => ({ method: 'files.list', params: { taskId: id(n), path: relative } });
const read = (n: number, relative: string): Call => ({ method: 'files.read', params: { taskId: id(n), path: relative } });
const diff = (n: number): Call => ({ method: 'task.diff', params: { taskId: id(n) } });

const plain: Step[] = [{ dir: 'plain/sub' }, file('plain/a.txt', 'a\n'), file('plain/notes.txt', `token ${SECRET}\n`), file('plain/secret.txt', 'never shown\n'), file('plain/.env', 'TOKEN=1\n'), file('plain/sub/b.txt', 'b\n')];
const changed: Step[] = [...committed(), file('repo/README.md', `hello\nchanged ${SECRET}\n`), file('repo/untracked.txt', `untracked ${SECRET}\n`)];

const cases: Case[] = [
  { name: 'folder task listing, reading, redaction and Git refusal', tree: plain, tasks: [folder(1, '{scratch}\\plain')],
    calls: [list(1), list(1, 'sub'), list(1, '..'), list(1, 'missing'), read(1, 'a.txt'), read(1, 'notes.txt'), read(1, 'secret.txt'), read(1, '.env'), read(1, 'missing.txt'), diff(1)] },
  { name: 'folder task saved with different case', tree: plain, tasks: [folder(2, '{scratch}\\PLAIN')], calls: [list(2), read(2, 'A.TXT')] },
  { name: 'folder task saved with a trailing separator', tree: plain, tasks: [folder(3, '{scratch}\\plain\\')], calls: [list(3), read(3, 'a.txt')] },
  { name: 'folder task whose folder disappeared', tree: [{ dir: 'present' }], tasks: [folder(4, '{scratch}\\plain')], calls: [list(4), read(4, 'a.txt')] },
  { name: 'folder task saved on a network share', tree: [], tasks: [folder(5, '\\\\server\\share\\plain')], calls: [list(5), read(5, 'a.txt')] },
  { name: 'folder task saved through a junction', tree: [...plain, { junction: 'alias', target: 'plain' }], tasks: [folder(6, '{scratch}\\alias')], calls: [list(6)],
    native: { 0: { outcome: { error: 'Projects through reparse directories are not supported.' }, difference: ALIAS } } },
  { name: 'projectless task has no folder access', tree: [], tasks: [none(7)], calls: [list(7), read(7, 'a.txt'), diff(7)] },
  { name: 'missing task', tree: [], tasks: [], calls: [list(8), read(8, 'a.txt'), diff(8)] },
  { name: 'Git task listing, reading and redacted diff', tree: changed, tasks: [gitTask(9, '{scratch}\\repo')], calls: [list(9), list(9, 'src'), read(9, 'README.md'), diff(9)] },
  { name: 'legacy task without a workspace kind is a Git task', tree: changed, tasks: [gitTask(10, '{scratch}\\repo', true)], calls: [list(10), read(10, 'untracked.txt'), diff(10)] },
  { name: 'Git task whose worktree is on a network share', tree: [], tasks: [gitTask(11, '\\\\server\\share\\repo')], calls: [list(11), read(11, 'README.md'), diff(11)] },
  { name: 'Git task whose worktree disappeared', tree: [{ dir: 'present' }], tasks: [gitTask(12, '{scratch}\\repo')], calls: [list(12), diff(12)] },
  { name: 'Git task whose worktree is not a repository', tree: plain, tasks: [gitTask(13, '{scratch}\\plain')], calls: [list(13), diff(13)] },
  { name: 'Git task through a junction', tree: [...changed, { junction: 'alias', target: 'repo' }], tasks: [gitTask(14, '{scratch}\\alias')], calls: [list(14), diff(14)],
    native: {
      0: { outcome: { error: 'Projects through reparse directories are not supported.' }, difference: ALIAS },
      1: { outcome: { error: 'Projects through reparse directories are not supported.' }, difference: ALIAS },
    } },
];

const snapshot = (store: Store) => JSON.stringify(['tasks', 'task_starts', 'intents', 'projects', 'events', 'messages'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all()));

async function outcomes(item: Case): Promise<Outcome[]> {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-handlers-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const links = build(scratch, home, item.tree);
  const data = path.join(scratch, 'data'); fs.mkdirSync(data);
  const store = new Store(path.join(data, 'workspace.db'));
  for (const task of item.tasks) store.saveTask(expand(task, scratch) as Parameters<Store['saveTask']>[0]);
  const service = new RuntimeService(store, new RepositoryService(path.join(data, 'wt')), () => {}, () => { throw new Error('Provider must not start.'); });
  try {
    const before = snapshot(store); const results: Outcome[] = [];
    await withIsolatedGit(home, async () => {
      for (const call of item.calls) {
        try { results.push({ result: normalize(await service.dispatch(call.method, call.params), scratch) }); }
        catch (error) {
          if (!(error instanceof Error)) throw error;
          const code = (error as NodeJS.ErrnoException).code;
          results.push(typeof code === 'string' ? { systemError: code } : { error: normalize(error.message, scratch) as string });
        }
      }
    });
    expect(snapshot(store)).toBe(before);
    return results;
  } finally {
    await service.shutdown();
    for (const link of links) fs.rmSync(link);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

it('pins Git/files handler outcomes to the shipping Node authority without ordinary regeneration', async () => {
  const expected: (Case & { expected: Outcome[] })[] = [];
  for (const item of cases) expected.push({ ...item, expected: await outcomes(item) });
  const corpus = {
    schemaVersion: 1,
    oracle: { sources: ['packages/runtime/src/service.ts', 'packages/runtime/src/repository.ts', 'packages/runtime/src/redaction.ts', 'packages/runtime/src/store.ts'].map(source => ({ path: source, sha256: sha256File(source) })) },
    cases: expected,
  };
  const target = 'tests/p2/repository-handler-vectors.json';
  if (process.env.P2_WRITE_REPOSITORY_HANDLERS === '1') fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(corpus);
}, 300_000);
