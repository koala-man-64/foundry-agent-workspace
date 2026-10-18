import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { RpcMethod } from '../../packages/protocol/src/index';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { build, committed, git, normalize, runGit, sha256File, withIsolatedGit, type Step } from './repository-fixture';
import { regenerating } from './oracle-node.mjs';
import { removeTree } from './scratch';

// task.commit, task.push, task.reconcilePublication and task.retire outcomes of the shipping TypeScript RuntimeService:
// results and refusals, every persisted task, intent and event, and the state of the project, its task branches and a
// local bare remote. The C# conformance suite (TaskPublicationTests) replays every case through DevelopmentChat and must
// reproduce all of it. Generated identities, commit object ids and stamps are normalized in order of appearance.
// Placeholders in calls: {scratch}, {task0} (the first created task's worktree) and {id0} (its id).
type Dispatch = { method: RpcMethod; params: Record<string, unknown> };
type Call = Dispatch | { write: string; text: string } | { delete: string } | { git: string[] } | { concurrent: Dispatch[] };
type Case = { name: string; tree: Step[]; calls: Call[]; repositories: string[] };

const identity: Step[] = [git('-C', 'repo', 'config', 'user.name', 'Runtime'), git('-C', 'repo', 'config', 'user.email', 'runtime@example.invalid')];
const remote: Step[] = [git('init', '-q', '--bare', 'remote.git'), git('-C', 'repo', 'remote', 'add', 'origin', '{scratch}\\remote.git')];
const create: Dispatch = { method: 'task.create', params: { title: 'Publication', projectPath: '{scratch}\\repo', profileId: FAKE_PROFILE_ID, tokenBudget: 100000, mode: 'chat' } };
const commit = (message = 'Change'): Dispatch => ({ method: 'task.commit', params: { taskId: '{id0}', message } });
const push = (name = 'origin'): Dispatch => ({ method: 'task.push', params: { taskId: '{id0}', remote: name, confirm: 'push' } });
const reconcile: Dispatch = { method: 'task.reconcilePublication', params: { taskId: '{id0}' } };
const retire: Dispatch = { method: 'task.retire', params: { taskId: '{id0}', confirm: 'retire' } };
const write = (name: string, text: string): Call => ({ write: `{task0}\\${name}`, text });
const remove = (name: string): Call => ({ delete: `{task0}\\${name}` });

const cases: Case[] = [
  { name: 'commit, push, reconcile and retire a chat task', tree: [...[...committed(), ...identity], ...remote], repositories: ['repo', 'remote.git'],
    calls: [create, write('README.md', 'hello\nchanged\n'), write('new.txt', 'new\n'), commit(), push(), reconcile, retire, retire, push(), commit()] },
  { name: 'commit refusals before staging', tree: [...committed(), ...identity], repositories: ['repo'],
    calls: [create, commit(), commit('Leaks sk-abcdefghijklmnopqrstuvwx'), write('.env', 'TOKEN=1\n'), commit(), remove('.env'),
      write('.gitattributes', '*.txt filter=lfs\n'), write('a.txt', 'a\n'), commit(), remove('.gitattributes'), remove('a.txt'),
      { git: ['-C', '{task0}', 'checkout', '-q', '-b', 'other'] }, write('x.txt', 'x\n'), commit()] },
  { name: 'a commit that fails after staging is unknown until reconciled', tree: [...committed(), git('-C', 'repo', 'config', 'user.useConfigOnly', 'true')], repositories: ['repo'],
    calls: [create, write('README.md', 'changed\n'), commit(), commit(), push(), retire, reconcile, reconcile] },
  { name: 'a push that fails is unknown until the remote proves it absent', tree: [...committed(), ...identity], repositories: ['repo', 'later.git'],
    calls: [create, write('README.md', 'changed\n'), commit(), push(), { git: ['-C', 'repo', 'remote', 'add', 'origin', '{scratch}\\later.git'] }, push(), commit(),
      reconcile, { git: ['init', '-q', '--bare', 'later.git'] }, reconcile, push()] },
  { name: 'retirement refuses a dirty worktree and keeps the branch', tree: [...committed(), ...identity], repositories: ['repo'],
    calls: [create, write('untracked.txt', 'u\n'), retire, remove('untracked.txt'), retire] },
  { name: 'concurrent Git operations on one task are refused', tree: [...[...committed(), ...identity], ...remote], repositories: ['repo', 'remote.git'],
    calls: [create, write('README.md', 'changed\n'), { concurrent: [commit(), push()] }] },
  { name: 'every publication operation needs an existing Git task', tree: [...committed(), ...identity], repositories: ['repo'],
    calls: [{ method: 'task.commit', params: { taskId: '30303030-0000-4000-8000-000000000099', message: 'x' } },
      { method: 'task.retire', params: { taskId: '30303030-0000-4000-8000-000000000099', confirm: 'retire' } }] },
];

/** Generated identities, commit object ids and stamps become placeholders in order of appearance. */
function stable(value: unknown, identities: Map<string, string>): unknown {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return '{stamp}';
    return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\b[0-9a-f]{40}\b/g, match => {
      if (!identities.has(match)) identities.set(match, `{${match.length === 40 ? 'sha' : 'id'}-${identities.size + 1}}`);
      return identities.get(match)!;
    });
  }
  if (Array.isArray(value)) return value.map(item => stable(item, identities));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stable(item, identities)]));
  return value;
}

async function outcomes(item: Case): Promise<unknown> {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-publication-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const created: { id: string; worktreePath: string }[] = [];
  const expand = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll('{scratch}', scratch).replaceAll('{task0}', created[0]?.worktreePath ?? '{task0}').replaceAll('{id0}', created[0]?.id ?? '{id0}');
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
    return value;
  };
  build(scratch, home, item.tree.map(step => expand(step) as Step));
  const data = path.join(scratch, 'data'); fs.mkdirSync(data);
  const store = new Store(path.join(data, 'workspace.db'));
  const service = new RuntimeService(store, new RepositoryService(path.join(data, 'wt')), () => {}, () => { throw new Error('Provider must not start.'); });
  const identities = new Map<string, string>();
  try {
    const first = (store.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM events').get() as { value: number }).value;
    const calls: Outcome[] = [];
    const settle = async (operation: Promise<unknown>): Promise<Outcome> => {
      try {
        const value = await operation;
        const task = value as { id?: unknown; worktreePath?: unknown } | null;
        if (task && typeof task.worktreePath === 'string' && typeof task.id === 'string' && !created.some(entry => entry.id === task.id)) created.push({ id: task.id, worktreePath: task.worktreePath });
        return { result: stable(normalize(value, scratch), identities) };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        return typeof code === 'string' ? { systemError: code } : { error: stable(normalize(error.message, scratch), identities) as string };
      }
    };
    await withIsolatedGit(home, async () => {
      for (const call of item.calls) {
        if ('write' in call) fs.writeFileSync(expand(call.write) as string, call.text);
        else if ('delete' in call) fs.rmSync(expand(call.delete) as string);
        else if ('git' in call) runGit(scratch, home, expand(call.git) as string[]);
        else if ('concurrent' in call) calls.push(...await Promise.all(call.concurrent.map(entry => settle(service.dispatch(entry.method, expand(entry.params))))));
        else calls.push(await settle(service.dispatch(call.method, expand(call.params))));
      }
    });
    const parsed = (rows: unknown[]) => (rows as Record<string, unknown>[]).map(row => ({ ...row, data: JSON.parse(row.data as string) as unknown }));
    const rows = {
      tasks: parsed(store.db.prepare('SELECT data FROM tasks ORDER BY rowid').all()),
      intents: parsed(store.db.prepare('SELECT kind, data, state FROM intents ORDER BY rowid').all()),
      events: parsed(store.db.prepare('SELECT sequence - ? AS offset, type, task_id, data FROM events WHERE sequence > ? ORDER BY sequence').all(first, first)),
    };
    const repositories = Object.fromEntries(item.repositories.filter(name => fs.existsSync(path.join(scratch, name))).map(name => [name, {
      refs: runGit(scratch, home, ['-C', name, 'for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter(Boolean),
      ...(name.endsWith('.git') ? {} : { worktrees: runGit(scratch, home, ['-C', name, 'worktree', 'list', '--porcelain']).split('\n').filter(Boolean) }),
    }]));
    const worktree = created[0] && fs.existsSync(created[0].worktreePath)
      ? { status: runGit(scratch, home, ['-C', created[0].worktreePath, 'status', '--porcelain=v1', '--untracked-files=all']), log: runGit(scratch, home, ['-C', created[0].worktreePath, 'log', '--format=%s', '-3']) }
      : null;
    return { calls, ...(stable(normalize({ rows, git: repositories, worktree }, scratch), identities) as object) };
  } finally {
    await service.shutdown();
    removeTree(scratch);
  }
}

type Outcome = { result: unknown } | { error: string } | { systemError: string };

it('pins Git publication and retirement outcomes to the shipping Node authority without ordinary regeneration', async () => {
  const expected: unknown[] = [];
  for (const item of cases) expected.push({ ...item, expected: await outcomes(item) });
  const corpus = {
    schemaVersion: 1,
    oracle: { sources: ['packages/runtime/src/workspace-operations.ts', 'packages/runtime/src/repository.ts', 'packages/runtime/src/service.ts', 'packages/runtime/src/store.ts', 'packages/runtime/src/git-environment.ts'].map(source => ({ path: source, sha256: sha256File(source) })) },
    cases: expected,
  };
  const target = 'tests/p2/task-publication-vectors.json';
  if (regenerating('P2_WRITE_TASK_PUBLICATION')) fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(corpus);
}, 600_000);
