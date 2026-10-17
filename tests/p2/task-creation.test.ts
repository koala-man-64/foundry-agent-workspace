import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ModelProfile } from '../../packages/protocol/src/index';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { profileFingerprint, RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { build, committed, file, git, normalize, runGit, sha256File, withIsolatedGit, type Step } from './repository-fixture';

// task.create outcomes of the shipping TypeScript RuntimeService: returned tasks and refusals, every persisted task,
// intent, project and event, and the repository's refs, worktrees and checkouts. The C# conformance suite
// (TaskCreationTests) rebuilds every tree, seeds the same profiles and intents, dispatches the same calls through
// DevelopmentChat and must reproduce all of it, except where a case names an approved native difference: then native
// must refuse those calls and leave every row and the repository unchanged. Generated identities and stamps are
// normalized in order of appearance. Placeholders: {scratch} {scratch/}.
type Outcome = { result: unknown } | { error: string } | { systemError: string };
type Call = { method: 'task.create' | 'project.add'; params: Record<string, unknown> } | { step: Step };
type Case = {
  name: string; tree: Step[]; calls: Call[]; concurrent?: true; repositories?: string[];
  profiles?: Record<string, unknown>[]; intents?: { id: string; kind: string; data: unknown; state: string }[];
  native?: { outcomes: Record<number, Outcome>; state: 'unchanged'; difference: string };
};

const ALIAS = 'Native refuses local aliases (approved difference until Rudy decides otherwise).';
const COORDINATED = 'Coordinated tasks need the native orchestrator, a later slice; native refuses them before any intent.';
const external = (id: string, probed: boolean): ModelProfile => {
  const profile: ModelProfile = { id, name: 'External', apiKind: 'responses', endpoint: 'https://fixture.openai.azure.com/', deployment: 'fixture', contextLimit: 128000, outputLimit: 4096 };
  return probed ? { ...profile, verificationFingerprint: profileFingerprint(profile), capabilities: { streaming: true, tools: true, continuation: true, cancellation: true, usage: true } } : profile;
};
const UNPROBED = '30303030-0000-4000-8000-000000000001';
const PROBED = '30303030-0000-4000-8000-000000000002';
const create = (projectPath: string, extra: Record<string, unknown> = {}): Call =>
  ({ method: 'task.create', params: { title: 'Fixture task', projectPath, profileId: FAKE_PROFILE_ID, tokenBudget: 100000, mode: 'chat', ...extra } });
const linked: Step[] = [...committed(), git('-C', 'repo', 'worktree', 'add', '-q', '../wt')];
const unchanged = (outcomes: Record<number, Outcome>, difference: string): Case['native'] => ({ outcomes, state: 'unchanged', difference });

const cases: Case[] = [
  { name: 'a chat task gets its own worktree, branch, project and channel binding', tree: committed(), calls: [create('{scratch}\\repo')] },
  { name: 'a coding task with the offline profile', tree: committed(), calls: [create('{scratch}\\repo', { mode: 'coding' })] },
  { name: 'two tasks in one repository reuse its project', tree: committed(), calls: [create('{scratch}\\repo'), create('{scratch}\\REPO', { title: 'Second' })] },
  { name: 'concurrent tasks in one repository are serialized', tree: committed(), calls: [create('{scratch}\\repo'), create('{scratch}\\repo', { title: 'Second' })], concurrent: true },
  { name: 'a repository subfolder', tree: committed(), calls: [create('{scratch}\\repo\\src')] },
  { name: 'a linked worktree shares its common repository', tree: linked, calls: [create('{scratch}\\wt')] },
  { name: 'a saved folder project becomes a Git project', tree: [{ dir: 'later' }, file('later/a.txt', 'a\n')],
    calls: [{ method: 'project.add', params: { path: '{scratch}\\later' } }, { step: git('-C', 'later', 'init', '-q') }, { step: git('-C', 'later', 'add', '-A') },
      { step: git('-C', 'later', 'commit', '-qm', 'later') }, create('{scratch}\\later')], repositories: ['later'] },
  { name: 'a secret-like title is redacted', tree: committed(), calls: [create('{scratch}\\repo', { title: 'Token sk-abcdefghijklmnopqrstuvwx' })] },
  { name: 'an external profile may create a chat task but needs a probe for coding', tree: committed(), profiles: [external(UNPROBED, false), external(PROBED, true)],
    calls: [create('{scratch}\\repo', { profileId: UNPROBED, mode: 'coding' }), create('{scratch}\\repo', { profileId: UNPROBED }), create('{scratch}\\repo', { profileId: PROBED, mode: 'coding', title: 'Probed' })] },
  { name: 'coordination settings on a chat task are refused', tree: committed(), calls: [create('{scratch}\\repo', { coordination: { childProfileIds: [FAKE_PROFILE_ID], requiredValidation: { command: 'pnpm check', cwd: '', timeoutMs: 600000 } } })] },
  { name: 'an unknown profile is refused', tree: committed(), calls: [create('{scratch}\\repo', { profileId: '30303030-0000-4000-8000-000000000009' })] },
  { name: 'a folder that is not a repository is refused before any intent', tree: [{ dir: 'plain' }, file('plain/a.txt', 'a\n')], calls: [create('{scratch}\\plain')], repositories: [] },
  { name: 'missing, relative and network paths are refused before any intent', tree: committed(),
    calls: [create('{scratch}\\absent'), create('repo'), create('\\\\server\\share\\repo'), create('{scratch}\\re\u0000po')] },
  { name: 'an unborn repository fails before any mutation', tree: [{ dir: 'repo' }, git('-C', 'repo', 'init', '-q'), file('repo/a.txt', 'a\n')], calls: [create('{scratch}\\repo')] },
  { name: 'filters at the base revision fail before any mutation', tree: committed([file('repo/.gitattributes', '*.txt filter=lfs\n'), file('repo/data.txt', 'data\n')]), calls: [create('{scratch}\\repo')] },
  { name: 'core.worktree fails before any mutation', tree: [...committed(), git('-C', 'repo', 'config', 'core.worktree', '..')], calls: [create('{scratch}\\repo')] },
  { name: 'an earlier unknown worktree creation blocks every new one', tree: committed(),
    intents: [{ id: '30303030-0000-4000-8000-000000000020', kind: 'worktree.create', data: { taskId: '30303030-0000-4000-8000-000000000021', projectPath: 'C:\\earlier' }, state: 'unknown' }],
    calls: [create('{scratch}\\repo')] },
  { name: 'a junction to a repository', tree: [...committed(), { junction: 'alias', target: 'repo' }], calls: [create('{scratch}\\alias')],
    native: unchanged({ 0: { error: 'Projects through reparse directories are not supported.' } }, ALIAS) },
  { name: 'a coordinated task', tree: committed(),
    calls: [create('{scratch}\\repo', { mode: 'coordinated', coordination: { childProfileIds: [FAKE_PROFILE_ID], requiredValidation: { command: 'pnpm check', cwd: '', timeoutMs: 600000 } } })],
    native: unchanged({ 0: { error: 'Coordinated tasks are not available in this build.' } }, COORDINATED) },
];

/** Generated identities (anywhere in a string) become placeholders in order of appearance; wall-clock stamps become {stamp}. */
function stable(value: unknown, identities: Map<string, string>): unknown {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return '{stamp}';
    return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, match => {
      if (!identities.has(match)) identities.set(match, `{id-${identities.size + 1}}`);
      return identities.get(match)!;
    });
  }
  if (Array.isArray(value)) return value.map(item => stable(item, identities));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stable(item, identities)]));
  return value;
}

/** `worktree list --porcelain` entries, each starting at its "worktree" line, in code-unit order. */
function sortedBlocks(lines: string[]): string[] {
  const blocks: string[][] = [];
  for (const line of lines) { if (line.startsWith('worktree ') || !blocks.length) blocks.push([]); blocks.at(-1)!.push(line); }
  return blocks.map(block => block.join('\n')).sort().flatMap(block => block.split('\n'));
}

export function expandPlaceholders(value: unknown, scratch: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{scratch/}', scratch.replaceAll('\\', '/')).replaceAll('{scratch}', scratch);
  if (Array.isArray(value)) return value.map(item => expandPlaceholders(item, scratch));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandPlaceholders(item, scratch)]));
  return value;
}

async function outcomes(item: Case): Promise<unknown> {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-task-create-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const links = build(scratch, home, item.tree);
  const data = path.join(scratch, 'data'); fs.mkdirSync(data);
  const store = new Store(path.join(data, 'workspace.db'));
  for (const profile of item.profiles ?? []) store.saveProfile(profile as ModelProfile);
  for (const intent of item.intents ?? []) store.db.prepare('INSERT INTO intents VALUES (?, ?, ?, ?)').run(intent.id, intent.kind, JSON.stringify(intent.data), intent.state);
  const service = new RuntimeService(store, new RepositoryService(path.join(data, 'wt')), () => {}, () => { throw new Error('Provider must not start.'); });
  const identities = new Map<string, string>();
  try {
    const first = (store.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM events').get() as { value: number }).value;
    const calls: Outcome[] = [];
    const settle = async (operation: Promise<unknown>): Promise<Outcome> => {
      try { return { result: stable(normalize(await operation, scratch), identities) }; }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        return typeof code === 'string' ? { systemError: code } : { error: stable(normalize(error.message, scratch), identities) as string };
      }
    };
    await withIsolatedGit(home, async () => {
      const dispatches = item.calls.map(call => 'step' in call ? undefined : call);
      if (item.concurrent) calls.push(...await Promise.all(dispatches.map(call => settle(service.dispatch(call!.method, expandPlaceholders(call!.params, scratch))))));
      else for (const call of item.calls) {
        if ('step' in call) build(scratch, home, [call.step]);
        else calls.push(await settle(service.dispatch(call.method, expandPlaceholders(call.params, scratch))));
      }
    });
    const parsed = (rows: unknown[]) => (rows as Record<string, unknown>[]).map(row => ({ ...row, data: JSON.parse(row.data as string) as unknown }));
    const rows = {
      tasks: parsed(store.db.prepare('SELECT data FROM tasks ORDER BY rowid').all()),
      intents: parsed(store.db.prepare('SELECT kind, data, state FROM intents ORDER BY rowid').all()),
      projects: parsed(store.db.prepare('SELECT path_key, data FROM projects ORDER BY rowid').all()),
      events: parsed(store.db.prepare('SELECT sequence - ? AS offset, type, task_id, data FROM events WHERE sequence > ? ORDER BY sequence').all(first, first)),
    };
    const repository = (name: string) => ({
      refs: runGit(scratch, home, ['-C', name, 'for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter(Boolean),
      worktrees: runGit(scratch, home, ['-C', name, 'worktree', 'list', '--porcelain']).split('\n').filter(Boolean),
    });
    const created = (rows.tasks as { data: { worktreePath?: string } }[]).map(task => task.data.worktreePath).filter((value): value is string => typeof value === 'string')
      .map(worktree => ({ status: runGit(scratch, home, ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all']), files: runGit(scratch, home, ['-C', worktree, 'ls-files']).split('\n').filter(Boolean) }));
    const git = Object.fromEntries((item.repositories ?? ['repo']).map(name => [name, repository(name)]));
    const state = stable(normalize({ rows, git, created }, scratch), identities) as { git: Record<string, { refs: string[]; worktrees: string[] }> };
    // Git lists refs and worktrees by their random identities; after normalization they are ordered by placeholder.
    for (const listed of Object.values(state.git)) { listed.refs.sort(); listed.worktrees = sortedBlocks(listed.worktrees); }
    return { calls, ...state };
  } finally {
    await service.shutdown();
    for (const link of links) fs.rmSync(link);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

it('pins task.create outcomes, rows and repository state to the shipping Node authority without ordinary regeneration', async () => {
  const expected: unknown[] = [];
  for (const item of cases) expected.push({ ...item, expected: await outcomes(item) });
  const corpus = {
    schemaVersion: 1,
    oracle: { sources: ['packages/runtime/src/service.ts', 'packages/runtime/src/repository.ts', 'packages/runtime/src/agent-channel.ts', 'packages/runtime/src/store.ts', 'packages/runtime/src/git-environment.ts'].map(source => ({ path: source, sha256: sha256File(source) })) },
    cases: expected,
  };
  const target = 'tests/p2/task-creation-vectors.json';
  if (process.env.P2_WRITE_TASK_CREATION === '1') fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(corpus);
}, 600_000);
