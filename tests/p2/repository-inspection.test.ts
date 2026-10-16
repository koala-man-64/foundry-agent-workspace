import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { gitEnvironment } from '../../packages/runtime/src/git-environment';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { build, committed, file, git, isolatedGitEnvironment, normalize, sha256File, withIsolatedGit, type Step } from './repository-fixture';

// Read-only repository inspection outcomes of the shipping TypeScript RepositoryService over disposable fixture trees.
// The C# conformance suite (RepositoryInspectionTests) rebuilds every tree and must reproduce each outcome, except where a
// case names an approved native difference. Node's raw filesystem errors are recorded as { systemError }; native must
// refuse those with its own fixed message. Git runs with an isolated HOME, no system configuration and the C locale,
// so the vectors do not depend on the machine's Git configuration. Placeholders: {scratch} {scratch/}.
type Op = { op: 'list' | 'read'; root: string; path: string } | { op: 'status' | 'diff' | 'isGit' | 'repository' | 'trackedFilters'; root: string }
  | { op: 'filters'; root: string; paths: string[] } | { op: 'revisionFilters'; root: string; revision: string };
type Outcome = { result: unknown } | { error: string } | { systemError: string };
type Case = { name: string; tree: Step[]; operation: Op; native?: { outcome: Outcome; difference: string } };

const ALIAS = 'Native refuses local aliases (approved difference until Rudy decides otherwise).';
const linked: Step[] = [...committed(), git('-C', 'repo', 'worktree', 'add', '-q', '../wt')];
const list = (relative: string, root = 'repo'): Op => ({ op: 'list', root, path: relative });
const read = (relative: string, root = 'repo'): Op => ({ op: 'read', root, path: relative });
const diff = (root = 'repo'): Op => ({ op: 'diff', root });
const listing: Step[] = [
  ...committed(), file('repo/src/nested/x.txt', 'x\n'), file('repo/.env', 'TOKEN=1\n'), file('repo/id_rsa', 'k\n'), file('repo/cert.pem', 'p\n'),
  file('repo/credentials.json', '{}\n'), file('repo/secrets', 's\n'), file('repo/.npmrc', 'r\n'), file('repo/a ', 'space\n'), file('repo/b.', 'dot\n'),
  { dir: 'repo/.ssh' }, { junction: 'repo/link', target: 'repo/src' }, file('repo/_x', ''), file('repo/-y', ''), file('repo/Z.txt', ''),
  file('repo/é.txt', ''), file('repo/e.txt', ''), file('repo/E2.txt', ''), file('repo/10.txt', ''), file('repo/9.txt', ''), file('repo/~t', ''),
  file('repo/x\u2028.pem', 'separator\n'), file('repo/.doc\u212Aer', 'kelvin\n'), file('repo/KEY.PEM', 'k\n'), file('repo/nul.txt', 'n\n'),
];
const reading: Step[] = [
  ...committed(), file('repo/bom.txt', '\uFEFFwith bom\n'), file('repo/crlf.txt', 'one\r\ntwo\r\n'), { file: 'repo/zero.bin', base64: 'YQBi' },
  { file: 'repo/invalid.txt', base64: 'gICA' }, { file: 'repo/limit.txt', repeat: ['a', 65536] }, { file: 'repo/over.txt', repeat: ['a', 65537] },
  file('repo/.env', 'TOKEN=1\n'), file('repo/config/.npmrc', 'r\n'), file('repo/x\u2028.pem', 'separator\n'), file('repo/.doc\u212Aer', 'kelvin\n'),
  { junction: 'repo/link', target: 'repo/src' }, { hardlink: 'repo/linked.txt', target: 'repo/README.md' }, file('repo/é/ü.txt', 'unicode\n'),
];
const changed: Step[] = [
  ...committed([file('repo/old.txt', 'old\n')]), file('repo/README.md', 'hello\nchanged\n'), { remove: 'repo/docs/b.md' },
  file('repo/new.txt', 'new file\nsecond line\n'), file('repo/dir/new2.txt', 'nested\n'), git('-C', 'repo', 'mv', 'old.txt', 'renamed.txt'),
];
const secretTracked: Step[] = [
  ...committed([file('repo/secrets.txt', 'value\n'), file('repo/credentials.txt', 'value\n')]),
];
const filtered = (attributes: string, committedAttributes: boolean): Step[] => committedAttributes
  ? committed([file('repo/.gitattributes', attributes), file('repo/data.txt', 'data\n'), file('repo/a.bin', 'bin\n')])
  : [...committed([file('repo/data.txt', 'data\n'), file('repo/a.bin', 'bin\n')]), file('repo/.gitattributes', attributes)];
const many = Array.from({ length: 101 }, (_, index) => file(`repo/many/f${String(index).padStart(3, '0')}.txt`, `${index}\n`));

const cases: Case[] = [
  { name: 'list the repository root', tree: listing, operation: list('') },
  { name: 'list a subdirectory', tree: listing, operation: list('src') },
  { name: 'list with a backslash separator', tree: listing, operation: list('src\\nested') },
  { name: 'list parent traversal', tree: listing, operation: list('..') },
  { name: 'list a dot segment', tree: listing, operation: list('./src') },
  { name: 'list an empty segment', tree: listing, operation: list('src//nested') },
  { name: 'list an absolute path', tree: listing, operation: list('C:\\') },
  { name: 'list a drive-relative path', tree: listing, operation: list('C:src') },
  { name: 'list a root-relative path', tree: listing, operation: list('/src') },
  { name: 'list a secret directory', tree: listing, operation: list('.ssh') },
  { name: 'list the Git directory', tree: listing, operation: list('.git') },
  { name: 'list a missing directory', tree: listing, operation: list('missing') },
  { name: 'list a file', tree: listing, operation: list('README.md') },
  { name: 'list through a junction', tree: listing, operation: list('link') },
  { name: 'list beneath a junction', tree: listing, operation: list('link/nested') },
  { name: 'list a folder that is not a repository', tree: [{ dir: 'plain/sub' }, file('plain/a.txt', 'a\n')], operation: list('', 'plain') },
  { name: 'list a root that is a junction', tree: [...committed(), { junction: 'alias', target: 'repo' }], operation: list('', 'alias'),
    native: { outcome: { error: 'Projects through reparse directories are not supported.' }, difference: ALIAS } },
  { name: 'list a missing root', tree: [{ dir: 'present' }], operation: list('', 'absent') },
  { name: 'list a Git directory root', tree: committed(), operation: list('', 'repo/.git') },
  { name: 'list a file root', tree: committed(), operation: list('', 'repo/README.md') },
  { name: 'read a tracked file', tree: reading, operation: read('README.md') },
  { name: 'read with different case', tree: reading, operation: read('readme.MD') },
  { name: 'read with a backslash separator', tree: reading, operation: read('docs\\b.md') },
  { name: 'read a byte order mark', tree: reading, operation: read('bom.txt') },
  { name: 'read CRLF line endings', tree: reading, operation: read('crlf.txt') },
  { name: 'read a NUL byte', tree: reading, operation: read('zero.bin') },
  { name: 'read invalid UTF-8', tree: reading, operation: read('invalid.txt') },
  { name: 'read exactly the size limit', tree: reading, operation: read('limit.txt') },
  { name: 'read one byte over the size limit', tree: reading, operation: read('over.txt') },
  { name: 'read a directory', tree: reading, operation: read('src') },
  { name: 'read a missing file', tree: reading, operation: read('missing.txt') },
  { name: 'read an empty path', tree: reading, operation: read('') },
  { name: 'read an environment file', tree: reading, operation: read('.env') },
  { name: 'read a nested package credential', tree: reading, operation: read('config/.npmrc') },
  { name: 'read an uppercase key name', tree: reading, operation: read('ID_RSA') },
  { name: 'read an uppercase key extension', tree: reading, operation: read('server.KEY') },
  { name: 'read a reserved device name', tree: reading, operation: read('nul.txt') },
  { name: 'read a reserved port name', tree: reading, operation: read('COM1') },
  { name: 'read a stream name', tree: reading, operation: read('README.md:stream') },
  { name: 'read inside an uppercase Git directory', tree: reading, operation: read('.GIT/config') },
  { name: 'read parent traversal', tree: reading, operation: read('src/../README.md') },
  { name: 'read a trailing-dot name', tree: reading, operation: read('README.md.') },
  { name: 'read through a junction', tree: reading, operation: read('link/a.ts') },
  { name: 'read a line-separator name that JavaScript does not treat as secret', tree: reading, operation: read('x\u2028.pem') },
  { name: 'read a Kelvin-sign name that JavaScript case folding does not match', tree: reading, operation: read('.doc\u212Aer') },
  { name: 'read a hard-linked file', tree: reading, operation: read('linked.txt') },
  { name: 'read a non-ASCII path', tree: reading, operation: read('é/ü.txt') },
  { name: 'read from a folder that is not a repository', tree: [file('plain/a.txt', 'a\n')], operation: read('a.txt', 'plain') },
  { name: 'status of a clean repository', tree: committed(), operation: { op: 'status', root: 'repo' } },
  { name: 'status with every change kind', tree: changed, operation: { op: 'status', root: 'repo' } },
  { name: 'diff of a clean repository', tree: committed(), operation: diff() },
  { name: 'diff with every change kind', tree: changed, operation: diff() },
  { name: 'diff skips secret-named untracked files', tree: [...committed(), file('repo/.env', 'TOKEN=1\n'), file('repo/visible.txt', 'shown\n')], operation: diff() },
  { name: 'diff omits untracked content after a secret tracked deletion',
    tree: [...secretTracked, { remove: 'repo/secrets.txt' }, file('repo/visible.txt', 'hidden\n')], operation: diff() },
  { name: 'diff excludes a rename from a secret name', tree: [...secretTracked, git('-C', 'repo', 'mv', 'credentials.txt', 'notes.txt')], operation: diff() },
  { name: 'diff of a binary modification', tree: [...committed([{ file: 'repo/image.bin', base64: 'AAECAwQF' }]), { file: 'repo/image.bin', base64: 'BQQDAgEA' }], operation: diff() },
  { name: 'diff skips an untracked binary file', tree: [...committed(), { file: 'repo/blob.bin', base64: 'AAEC' }, file('repo/text.txt', 'text\n')], operation: diff() },
  { name: 'diff truncates after one hundred untracked files', tree: [...committed(), ...many], operation: diff() },
  { name: 'diff truncates a large patch', tree: [...committed([file('repo/large.txt', 'seed\n')]), { file: 'repo/large.txt', repeat: ['0123456789abcdef\n', 18000] }], operation: diff() },
  { name: 'diff of a non-ASCII name', tree: [...committed([file('repo/café.txt', 'one\n')]), file('repo/café.txt', 'two\n')], operation: diff() },
  { name: 'diff of a linked worktree', tree: [...linked, file('wt/README.md', 'worktree change\n')], operation: diff('wt') },
  { name: 'diff of a folder that is not a repository', tree: [file('plain/a.txt', 'a\n')], operation: diff('plain') },
  { name: 'diff refuses core.worktree', tree: [...committed(), git('-C', 'repo', 'config', 'core.worktree', '..')], operation: diff() },
  { name: 'diff refuses an unusable core.worktree', tree: [...committed(), git('-C', 'repo', 'config', 'core.worktree', '../missing')], operation: diff() },
  { name: 'diff of an unborn branch', tree: [{ dir: 'repo' }, git('-C', 'repo', 'init', '-q'), file('repo/a.txt', 'a\n')], operation: diff() },
  { name: 'diff of a bare repository', tree: [{ dir: 'bare.git' }, git('-C', 'bare.git', 'init', '-q', '--bare')], operation: diff('bare.git') },
  { name: 'repository of a subfolder', tree: committed(), operation: { op: 'repository', root: 'repo/src' } },
  { name: 'repository of a Git directory', tree: committed(), operation: { op: 'repository', root: 'repo/.git' } },
  { name: 'repository through a junction', tree: [...committed(), { junction: 'alias', target: 'repo' }], operation: { op: 'repository', root: 'alias' },
    native: { outcome: { error: 'Projects through reparse directories are not supported.' }, difference: ALIAS } },
  { name: 'classify a repository root', tree: committed(), operation: { op: 'isGit', root: 'repo' } },
  { name: 'classify a repository subfolder', tree: committed(), operation: { op: 'isGit', root: 'repo/src' } },
  { name: 'classify a folder that is not a repository', tree: [file('plain/a.txt', 'a\n')], operation: { op: 'isGit', root: 'plain' } },
  { name: 'classify a linked worktree', tree: linked, operation: { op: 'isGit', root: 'wt' } },
  { name: 'classify a pointer to a missing Git directory', tree: [{ dir: 'broken' }, file('broken/.git', 'gitdir: ../missing')], operation: { op: 'isGit', root: 'broken' } },
  { name: 'classify a repository that configures core.worktree', tree: [...committed(), git('-C', 'repo', 'config', 'core.worktree', '../elsewhere')], operation: { op: 'isGit', root: 'repo' } },
  { name: 'tracked filters are refused', tree: filtered('*.txt filter=lfs\n', true), operation: { op: 'trackedFilters', root: 'repo' } },
  { name: 'tracked paths without filters pass', tree: filtered('*.txt text\n', true), operation: { op: 'trackedFilters', root: 'repo' } },
  { name: 'a filter on a candidate path is refused', tree: filtered('*.bin filter=custom\n', false), operation: { op: 'filters', root: 'repo', paths: ['a.bin'] } },
  { name: 'unfiltered candidate paths pass', tree: filtered('*.bin filter=custom\n', false), operation: { op: 'filters', root: 'repo', paths: ['data.txt', 'missing.txt'] } },
  { name: 'filters at the selected revision are refused', tree: filtered('*.txt filter=lfs\n', true), operation: { op: 'revisionFilters', root: 'repo', revision: 'HEAD' } },
  { name: 'working-tree attributes do not affect the selected revision', tree: filtered('*.txt filter=lfs\n', false), operation: { op: 'revisionFilters', root: 'repo', revision: 'HEAD' } },
];

async function perform(service: RepositoryService, operation: Op, scratch: string): Promise<unknown> {
  const root = path.join(scratch, operation.root);
  const internal = service as unknown as { requireRepository(root: string): Promise<string>; rejectTrackedFilters(root: string): Promise<void>; rejectFilters(root: string, paths: string[]): Promise<void>; rejectTrackedFiltersAtRevision(root: string, commit: string): Promise<void> };
  switch (operation.op) {
    case 'list': return service.listFiles(root, operation.path);
    case 'read': return service.readFile(root, operation.path);
    case 'status': return service.uncommittedPaths(root);
    case 'diff': return service.diff(root);
    case 'isGit': return service.isGitWorkingTree(root);
    case 'repository': return internal.requireRepository(root);
    case 'trackedFilters': { const selected = await internal.requireRepository(root); await internal.rejectTrackedFilters(selected); return null; }
    case 'filters': { const selected = await internal.requireRepository(root); await internal.rejectFilters(selected, operation.paths); return null; }
    case 'revisionFilters': { const selected = await internal.requireRepository(root); await internal.rejectTrackedFiltersAtRevision(selected, operation.revision); return null; }
  }
}
async function outcome(item: Case): Promise<Outcome> {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-inspection-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const links = build(scratch, home, item.tree);
  try {
    return await withIsolatedGit(home, async () => {
      try {
        const service = new RepositoryService(path.join(scratch, 'wt-base'));
        return { result: normalize(await perform(service, item.operation, scratch), scratch) };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        return typeof code === 'string' ? { systemError: code } : { error: normalize(error.message, scratch) as string };
      }
    });
  } finally {
    for (const link of links) fs.rmSync(link);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
/** Which inherited variable names gitEnvironment() keeps; JavaScript upper-cases the dotless i, and full mappings can expand. */
const SANITIZED_NAMES = ['FOUNDRY_P2_KEPT', 'GIT_DIR', 'git_work_tree', 'Git_Config_Parameters', 'gıt_index_file', 'GITX', 'MY_GIT_DIR', 'GIẗ_X', 'ǧit_x', 'gIt_'];
function sanitization(): { names: string[]; kept: string[] } {
  const saved = { ...process.env };
  try {
    for (const name of SANITIZED_NAMES) process.env[name] = 'value';
    const environment = gitEnvironment();
    return { names: SANITIZED_NAMES, kept: SANITIZED_NAMES.filter(name => environment[name] === 'value') };
  } finally { for (const name of SANITIZED_NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
}

it('pins read-only repository inspection outcomes to the shipping Node authority without ordinary regeneration', async () => {
  const expected: (Case & { expected: Outcome })[] = [];
  for (const item of cases) expected.push({ ...item, expected: await outcome(item) });
  const corpus = {
    schemaVersion: 1,
    oracle: { sources: ['packages/runtime/src/repository.ts', 'packages/runtime/src/git-environment.ts', 'packages/runtime/src/network-path.ts'].map(source => ({ path: source, sha256: sha256File(source) })) },
    environment: isolatedGitEnvironment('{home}'),
    sanitization: sanitization(),
    cases: expected,
  };
  const target = 'tests/p2/repository-inspection-vectors.json';
  if (process.env.P2_WRITE_REPOSITORY_INSPECTION === '1') fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(corpus);
}, 300_000);
