import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { Store } from '../../packages/runtime/src/store';
import { build, committed, file, git, normalize, sha256File, withIsolatedGit, type Step } from './repository-fixture';
import { regenerating } from './oracle-node.mjs';
import { removeTree } from './scratch';

// project.add outcomes of the shipping TypeScript RuntimeService over disposable folders. The C# conformance suite
// (ProjectAdmissionTests) rebuilds every tree, dispatches the same calls through DevelopmentChat and must reproduce each
// returned project, refusal, saved project row and event, except where a call names an approved native difference.
// Generated project identities and timestamps are normalized by order of appearance. Placeholders: {scratch}
// {scratch/} {scratch-nodrive}. A case marked sameDrive resolves a root-relative path, which names the scratch folder only
// when the working directory and the temporary folder share a drive; elsewhere (a CI runner whose workspace and TEMP are
// on different drives) it cannot be reproduced, so the committed entry stands and the C# suite skips it.
type Outcome = { result: unknown } | { error: string } | { systemError: string };
type Case = { name: string; tree: Step[]; paths: string[]; concurrent?: true; sameDrive?: true; native?: Record<number, { outcome: Outcome; difference: string }> };

const ALIAS = 'Native refuses local aliases (approved difference until Rudy decides otherwise).';
const linked: Step[] = [...committed(), git('-C', 'repo', 'worktree', 'add', '-q', '../wt')];
const plain: Step[] = [{ dir: 'plain/sub' }, file('plain/a.txt', 'a\n'), file('plain/file.txt', 'not a folder\n')];

const cases: Case[] = [
  { name: 'a repository root is a Git project, added once under every spelling', tree: committed(),
    paths: ['{scratch}\\repo', '{scratch}\\repo', '{scratch}\\REPO', '{scratch}\\repo\\', '{scratch/}/repo', '{scratch}\\repo\\src\\..'] },
  { name: 'concurrent additions of one folder save one project and notify for each', tree: committed(), paths: ['{scratch}\\repo', '{scratch}\\REPO'], concurrent: true },
  { name: 'a repository subfolder is a folder project', tree: committed(), paths: ['{scratch}\\repo\\src'] },
  { name: 'a plain folder is a folder project', tree: plain, paths: ['{scratch}\\plain', '{scratch}\\plain\\sub'] },
  { name: 'a linked worktree is a Git project', tree: linked, paths: ['{scratch}\\wt', '{scratch}\\repo'] },
  { name: 'a nested repository binds its own root', tree: [...committed(), { dir: 'repo/inner' }, git('-C', 'repo/inner', 'init', '-q'), file('repo/inner/x.txt', 'x\n'),
    git('-C', 'repo/inner', 'add', '-A'), git('-C', 'repo/inner', 'commit', '-qm', 'inner')], paths: ['{scratch}\\repo\\inner'] },
  { name: 'a repository that configures core.worktree is a folder project', tree: [...committed(), git('-C', 'repo', 'config', 'core.worktree', '..')], paths: ['{scratch}\\repo'] },
  { name: 'a root-relative path resolves on the current drive', tree: committed(), paths: ['{scratch-nodrive}\\repo'], sameDrive: true },
  { name: 'relative and drive-relative paths are refused', tree: committed(), paths: ['repo', 'C:repo'] },
  { name: 'network and device paths are refused before any probe', tree: [], paths: ['\\\\server\\share\\repo', '//server/share/repo', '\\\\?\\C:\\repo', '\\\\.\\C:\\repo', '\\??\\C:\\repo'] },
  { name: 'a path containing NUL', tree: committed(), paths: ['{scratch}\\re\u0000po', '{scratch}\\repo\u0000', '{scratch}\\repo'] },
  { name: 'a file is not a folder', tree: plain, paths: ['{scratch}\\plain\\file.txt'] },
  { name: 'a missing folder', tree: [{ dir: 'present' }], paths: ['{scratch}\\absent', '{scratch}\\absent\\child'] },
  { name: 'a folder whose Git pointer is broken', tree: [{ dir: 'broken' }, file('broken/.git', 'gitdir: ../missing')], paths: ['{scratch}\\broken'] },
  { name: 'a junction to a repository', tree: [...committed(), { junction: 'alias', target: 'repo' }], paths: ['{scratch}\\alias', '{scratch}\\repo'],
    native: { 0: { outcome: { error: 'Projects through reparse directories are not supported.' }, difference: ALIAS } } },
];

/** Projects and events with generated identities and wall-clock stamps replaced in order of appearance. */
function stable(value: unknown, identities: Map<string, string>): unknown {
  if (typeof value === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
      if (!identities.has(value)) identities.set(value, `{project-${identities.size + 1}}`);
      return identities.get(value);
    }
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ? '{stamp}' : value;
  }
  if (Array.isArray(value)) return value.map(item => stable(item, identities));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stable(item, identities)]));
  return value;
}

async function outcomes(item: Case): Promise<{ calls: Outcome[]; projects: unknown; events: unknown }> {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-project-add-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const links = build(scratch, home, item.tree);
  const data = path.join(scratch, 'data'); fs.mkdirSync(data);
  const store = new Store(path.join(data, 'workspace.db'));
  const service = new RuntimeService(store, new RepositoryService(path.join(data, 'wt')), () => {}, () => { throw new Error('Provider must not start.'); });
  const identities = new Map<string, string>();
  const expand = (raw: string) => raw.replaceAll('{scratch-nodrive}', scratch.slice(2)).replaceAll('{scratch/}', scratch.replaceAll('\\', '/')).replaceAll('{scratch}', scratch);
  try {
    const first = (store.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM events').get() as { value: number }).value;
    const calls: Outcome[] = [];
    const settle = async (operation: Promise<unknown>): Promise<Outcome> => {
      try { return { result: stable(normalize(await operation, scratch), identities) }; }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        return typeof code === 'string' ? { systemError: code } : { error: normalize(error.message, scratch) as string };
      }
    };
    await withIsolatedGit(home, async () => {
      if (item.concurrent) calls.push(...await Promise.all(item.paths.map(raw => settle(service.dispatch('project.add', { path: expand(raw) })))));
      else for (const raw of item.paths) calls.push(await settle(service.dispatch('project.add', { path: expand(raw) })));
    });
    const parsed = (rows: unknown[]) => (rows as Record<string, unknown>[]).map(row => ({ ...row, data: JSON.parse(row.data as string) as unknown }));
    const projects = stable(normalize(parsed(store.db.prepare('SELECT path_key, data FROM projects ORDER BY rowid').all()), scratch), identities);
    const events = stable(normalize(parsed(store.db.prepare('SELECT sequence - ? AS offset, type, task_id, data FROM events WHERE sequence > ? ORDER BY sequence').all(first, first)), scratch), identities);
    return { calls, projects, events };
  } finally {
    await service.shutdown();
    for (const link of links) fs.unlinkSync(link);
    removeTree(scratch);
  }
}

it('pins project.add outcomes to the shipping Node authority without ordinary regeneration', async () => {
  const target = 'tests/p2/project-admission-vectors.json';
  const committedCases = (JSON.parse(fs.readFileSync(target, 'utf8')) as { cases: { name: string }[] }).cases;
  const sameDrive = path.parse(process.cwd()).root.toLowerCase() === path.parse(fs.realpathSync.native(tmpdir())).root.toLowerCase();
  const expected: (Case & { expected: Awaited<ReturnType<typeof outcomes>> })[] = [];
  for (const item of cases) {
    const kept = item.sameDrive && !sameDrive ? committedCases.find(entry => entry.name === item.name) : undefined;
    if (kept) console.warn(`Not recomputed (working directory and temporary folder on different drives): ${item.name}`);
    expected.push(kept ? kept as Case & { expected: Awaited<ReturnType<typeof outcomes>> } : { ...item, expected: await outcomes(item) });
  }
  const corpus = {
    schemaVersion: 1,
    oracle: { sources: ['packages/runtime/src/service.ts', 'packages/runtime/src/repository.ts', 'packages/runtime/src/store.ts', 'packages/runtime/src/network-path.ts'].map(source => ({ path: source, sha256: sha256File(source) })) },
    cases: expected,
  };
  if (regenerating('P2_WRITE_PROJECT_ADMISSION')) fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(corpus);
}, 300_000);
