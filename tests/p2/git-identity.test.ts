import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveGitAdmission } from '../../packages/runtime/src/repository';
import { regenerating } from './oracle-node.mjs';
import { removeTree } from './scratch';

// Git identity admission outcomes of the shipping TypeScript resolver over disposable fixture trees. The C# conformance
// suite (GitRepositoryLeaseTests) rebuilds every tree and must reproduce each outcome, except where a case names an
// approved native difference. Placeholders: {scratch} {scratch/} {scratch-nodrive} {drive} {other-drive}.
type Step = { dir: string } | { file: string; text: string; pad?: number } | { junction: string; target: string } | { git: string[] };
type Identity = { path: string; root: string; gitDirectory: string; common: string };
type Outcome = { identity: Identity } | { error: string } | { systemError: string };
type Case = { name: string; tree: Step[]; project: string; native?: { outcome: Outcome; difference: string } };

const INVALID = 'Invalid Git project metadata.';
const REPARSE = 'Projects through reparse directories are not supported.';
const worktree = (commondir: string | null): Step[] => [
  { dir: 'main/.git/worktrees/wt' }, { dir: 'wt' },
  ...(commondir === null ? [] : [{ file: 'main/.git/worktrees/wt/commondir', text: commondir }]),
];
const pointer = (text: string, commondir: string | null = '../..\n', pad?: number): Step[] =>
  [...worktree(commondir), pad === undefined ? { file: 'wt/.git', text } : { file: 'wt/.git', text, pad }];
const commondir = (text: string, pad?: number): Step[] =>
  [{ dir: 'main/.git/worktrees/wt' }, { dir: 'wt' }, { file: 'wt/.git', text: 'gitdir: ../main/.git/worktrees/wt' },
    pad === undefined ? { file: 'main/.git/worktrees/wt/commondir', text } : { file: 'main/.git/worktrees/wt/commondir', text, pad }];
const git = (...args: string[]): Step => ({ git: args });
const realWorktree: Step[] = [{ dir: 'main' }, git('-C', 'main', 'init', '-q'), git('-C', 'main', 'commit', '--allow-empty', '-qm', 'fixture'), git('-C', 'main', 'worktree', 'add', '-q', '../wt')];
const alias = (difference: string): Case['native'] => ({ outcome: { error: REPARSE }, difference });

const cases: Case[] = [
  { name: 'plain repository', tree: [{ dir: 'repo/.git' }, { dir: 'repo/src' }], project: 'repo' },
  { name: 'subfolder binds the nearest ancestor', tree: [{ dir: 'repo/.git' }, { dir: 'repo/src/deep' }], project: 'repo/src/deep' },
  { name: 'nested repository binds the inner root', tree: [{ dir: 'repo/.git' }, { dir: 'repo/inner/.git' }], project: 'repo/inner' },
  { name: 'spaces and non-ASCII names', tree: [{ dir: 'space 😀/repo é/.git' }], project: 'space 😀/repo é' },
  { name: 'absolute forward-slash gitdir', tree: pointer('gitdir: {scratch/}/main/.git/worktrees/wt\n'), project: 'wt' },
  { name: 'absolute backslash gitdir with CRLF', tree: pointer('gitdir: {scratch}\\main\\.git\\worktrees\\wt\r\n'), project: 'wt' },
  { name: 'relative gitdir resolves against the root', tree: pointer('gitdir: ../main/.git/worktrees/wt'), project: 'wt' },
  { name: 'root-relative gitdir uses the root drive', tree: pointer('gitdir: {scratch-nodrive}\\main\\.git\\worktrees\\wt'), project: 'wt' },
  { name: 'same-drive drive-relative gitdir resolves against the root', tree: pointer('gitdir: {drive}../main/.git/worktrees/wt'), project: 'wt' },
  { name: 'cross-drive drive-relative gitdir', tree: pointer('gitdir: {other-drive}main'), project: 'wt',
    native: { outcome: { error: INVALID }, difference: 'A drive-relative reference to another drive resolves from per-drive process state, so native refuses it.' } },
  { name: 'dot segments are normalized', tree: pointer('gitdir: ./x/../../main/.git/worktrees/wt'), project: 'wt' },
  { name: 'BOM and surrounding whitespace are trimmed', tree: pointer('\uFEFF  gitdir: ../main/.git/worktrees/wt \n\t'), project: 'wt' },
  { name: 'pointer at the 16384-byte limit', tree: pointer('gitdir: ../main/.git/worktrees/wt', '../..', 16384), project: 'wt' },
  { name: 'pointer one byte over the limit', tree: pointer('gitdir: ../main/.git/worktrees/wt', '../..', 16385), project: 'wt' },
  { name: 'empty .git file', tree: pointer(''), project: 'wt' },
  { name: 'pointer without the separator space', tree: pointer('gitdir:../main/.git/worktrees/wt'), project: 'wt' },
  { name: 'uppercase pointer prefix', tree: pointer('GITDIR: ../main/.git/worktrees/wt'), project: 'wt' },
  { name: 'two pointer lines', tree: pointer('gitdir: ../main/.git/worktrees/wt\ngitdir: ../main/.git'), project: 'wt' },
  { name: 'UNC gitdir', tree: pointer('gitdir: \\\\server\\share\\repo\\.git'), project: 'wt' },
  { name: 'forward-slash UNC gitdir', tree: pointer('gitdir: //server/share/repo/.git'), project: 'wt' },
  { name: 'Win32 device namespace gitdir', tree: pointer('gitdir: \\\\?\\{drive}\\main\\.git'), project: 'wt' },
  { name: 'NT namespace gitdir', tree: pointer('gitdir: \\??\\{drive}\\main\\.git'), project: 'wt' },
  { name: 'gitdir naming a file', tree: [{ dir: 'wt' }, { file: 'target', text: 'x' }, { file: 'wt/.git', text: 'gitdir: ../target' }], project: 'wt' },
  { name: 'missing gitdir target', tree: pointer('gitdir: ../missing/.git'), project: 'wt' },
  { name: 'trailing-dot gitdir', tree: pointer('gitdir: ../main/.git/worktrees/wt.'), project: 'wt' },
  { name: 'stream-suffixed gitdir', tree: pointer('gitdir: ../main/.git/worktrees/wt:stream'), project: 'wt' },
  { name: 'reserved device name gitdir', tree: pointer('gitdir: ../nul'), project: 'wt' },
  { name: 'missing commondir falls back to the Git directory', tree: pointer('gitdir: ../main/.git/worktrees/wt', null), project: 'wt' },
  { name: 'empty commondir falls back', tree: commondir(''), project: 'wt' },
  { name: 'whitespace-only commondir falls back', tree: commondir(' \r\n\t'), project: 'wt' },
  { name: 'absolute commondir', tree: commondir('{scratch/}/main/.git\n'), project: 'wt' },
  { name: 'commondir at the 16384-byte limit', tree: commondir('../..', 16384), project: 'wt' },
  { name: 'commondir one byte over the limit', tree: commondir('../..', 16385), project: 'wt' },
  { name: 'UNC commondir', tree: commondir('\\\\server\\share\\repo\\.git'), project: 'wt' },
  { name: 'missing commondir target', tree: commondir('../../../../missing/.git'), project: 'wt' },
  { name: 'commondir that is a directory', tree: [...pointer('gitdir: ../main/.git/worktrees/wt', null), { dir: 'main/.git/worktrees/wt/commondir' }], project: 'wt' },
  { name: 'commondir naming a file', tree: [...commondir('../../../../target'), { file: 'target', text: 'x' }], project: 'wt',
    native: { outcome: { error: INVALID }, difference: 'TypeScript accepts a common "directory" that is a file; native requires a directory.' } },
  { name: '.git directory junction', tree: [{ dir: 'store/git' }, { dir: 'repo' }, { junction: 'repo/.git', target: 'store/git' }], project: 'repo',
    native: alias('Native refuses local aliases (open decision before handler enablement).') },
  { name: 'gitdir through a junction', tree: [...pointer('gitdir: ../link/.git/worktrees/wt'), { junction: 'link', target: 'main' }], project: 'wt',
    native: alias('Native refuses local aliases (open decision before handler enablement).') },
  { name: 'commondir through a junction', tree: [...commondir('../../../../link/.git'), { junction: 'link', target: 'main' }], project: 'wt',
    native: alias('Native refuses local aliases (open decision before handler enablement).') },
  { name: 'project through a junction', tree: [{ dir: 'repo/.git' }, { dir: 'repo/src' }, { junction: 'alias', target: 'repo' }], project: 'alias/src',
    native: alias('Native refuses local aliases (open decision before handler enablement).') },
  { name: 'real Git main checkout', tree: realWorktree, project: 'main' },
  { name: 'real Git linked worktree', tree: realWorktree, project: 'wt' },
];

function otherDrive(scratch: string): string {
  for (const letter of 'QRSTUVWXYZ') if (letter !== scratch[0]!.toUpperCase() && !fs.existsSync(`${letter}:\\`)) return `${letter}:`;
  throw new Error('No unused drive letter for the cross-drive case.');
}
function expand(text: string, scratch: string): string {
  return text.replaceAll('{scratch/}', scratch.replaceAll('\\', '/')).replaceAll('{scratch-nodrive}', scratch.slice(2))
    .replaceAll('{scratch}', scratch).replaceAll('{other-drive}', otherDrive(scratch)).replaceAll('{drive}', scratch.slice(0, 2));
}
function runGit(scratch: string, args: string[]): void {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
  execFileSync('git', ['-c', `core.hooksPath=${path.join(scratch, 'no-fixture-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: scratch, env, windowsHide: true, stdio: 'pipe' });
}
function build(scratch: string, tree: Step[]): string[] {
  const links: string[] = [];
  for (const step of tree) {
    if ('dir' in step) fs.mkdirSync(path.join(scratch, step.dir), { recursive: true });
    else if ('file' in step) {
      const file = path.join(scratch, step.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(expand(step.text, scratch), 'utf8');
      fs.writeFileSync(file, step.pad === undefined ? bytes : Buffer.concat([bytes, Buffer.alloc(step.pad - bytes.length, 0x20)]));
    } else if ('junction' in step) {
      const link = path.join(scratch, step.junction);
      fs.symlinkSync(path.join(scratch, step.target), link, 'junction'); links.push(link);
    } else runGit(scratch, step.git);
  }
  return links;
}
function relative(value: string, scratch: string): string {
  return value === scratch ? '{scratch}' : value.startsWith(scratch + '\\') ? '{scratch}' + value.slice(scratch.length) : value;
}
function outcome(item: Case): Outcome {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-git-identity-')));
  const links = build(scratch, item.tree);
  try {
    const identity = resolveGitAdmission(path.join(scratch, item.project));
    if (!identity) throw new Error('Fixture tree has no repository.');
    return { identity: { path: relative(identity.path, scratch), root: relative(identity.root, scratch), gitDirectory: relative(identity.gitDirectory, scratch), common: relative(identity.common, scratch) } };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? { systemError: code } : { error: error.message };
  } finally {
    for (const link of links) fs.unlinkSync(link);
    removeTree(scratch);
  }
}
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

it('pins Git identity admission outcomes to the shipping Node authority without ordinary regeneration', () => {
  const corpus = {
    schemaVersion: 1,
    oracle: { sources: ['packages/runtime/src/repository.ts', 'packages/runtime/src/network-path.ts'].map(file => ({ path: file, sha256: sha256(file) })) },
    cases: cases.map(item => ({ ...item, expected: outcome(item) })),
  };
  const file = 'tests/p2/git-identity-vectors.json';
  if (regenerating('P2_WRITE_GIT_IDENTITY')) fs.writeFileSync(file, JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(corpus);
}, 120_000);
