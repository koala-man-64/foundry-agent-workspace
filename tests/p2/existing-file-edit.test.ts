import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { type PreparedEdit, RepositoryError, RepositoryService } from '../../packages/runtime/src/repository';
import { build, committed, file, normalize, sha256File, type Step, withIsolatedGit } from './repository-fixture';

// The one-shot existing-file edit primitive of the shipping TypeScript RepositoryService (prepareEdit and applyEdit),
// driven directly over disposable trees. The C# suite (ExistingFileEditTests) rebuilds every tree, replays every step
// through the native primitive and must reproduce each outcome, the prepared edit's fields and the final bytes of every
// file. Node's raw filesystem errors are recorded as { systemError } with their outcome; native must refuse those with
// its own fixed message and the same outcome. A prepared fingerprint is recorded as its preimage, the JSON array the
// hash covers, and checked here against the hash. Placeholders: {scratch} {scratch-json}.
type Reviewed = { hashOf: string } | null | string;
type After = string | { repeat: [string, number] };
type PrepareStep = { op: 'prepare'; root: string; path: string; reviewed: Reviewed; after: After; as?: string };
type EditStep =
  | PrepareStep
  | { op: 'apply'; edit: string; tamper?: { after?: string; fingerprint?: string } }
  | { op: 'write'; file: string; text: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'remove'; file: string }
  | { op: 'hardlink'; link: string; target: string }
  | { op: 'readonly'; file: string };
type Outcome = { result: unknown } | { error: string; outcome: string | null } | { systemError: string; outcome: string | null };
type Case = { name: string; tree: Step[]; steps: EditStep[] };

const ZERO = '0'.repeat(64);
const plain = (extra: Step[] = []): Step[] => [file('plain/README.md', 'hello\n'), file('plain/src/a.ts', 'export const a = 1;\n'), file('plain/docs/b.md', '# b\n'), ...extra];
/** An edit of a file in the plain tree, reviewed at its current content and kept as 'edit'. */
const prepare = (pathName: string, after: After): PrepareStep => ({ op: 'prepare', root: 'plain', path: pathName, reviewed: { hashOf: `plain/${pathName}` }, after, as: 'edit' });
/** A preflight whose expected hash is never current, so it reports the first refusal that applies. */
const refused = (root: string, pathName: string): PrepareStep => ({ op: 'prepare', root, path: pathName, reviewed: ZERO, after: 'x' });
const apply = (tamper?: { after?: string; fingerprint?: string }): EditStep => ({ op: 'apply', edit: 'edit', ...(tamper ? { tamper } : {}) });

const cases: Case[] = [
  { name: 'edits an existing file and verifies it', tree: plain(), steps: [prepare('README.md', 'changed\n'), apply()] },
  { name: 'replaces the content with nothing', tree: plain(), steps: [prepare('README.md', ''), apply()] },
  { name: 'keeps carriage returns and drops a leading byte order mark from before', tree: plain([{ file: 'plain/bom.txt', base64: Buffer.from('\ufeffx\r\ny\r\n', 'utf8').toString('base64') }]),
    steps: [prepare('bom.txt', '\ufeffx\r\nz\r\n'), apply()] },
  { name: 'writes non-ASCII text as UTF-8', tree: plain(), steps: [prepare('docs/b.md', '# \u00e9 \u2713 \ud834\udd1e\n'), apply()] },
  { name: 'keeps a backslash and case-variant path as requested and reports the real one', tree: plain(), steps: [
    { op: 'prepare', root: 'plain', path: 'SRC\\A.TS', reviewed: { hashOf: 'plain/src/a.ts' }, after: 'export const a = 2;\n', as: 'edit' }, apply()] },
  { name: 'admits a case-variant root as its real path', tree: plain(), steps: [
    { op: 'prepare', root: 'PLAIN', path: 'README.md', reviewed: { hashOf: 'plain/README.md' }, after: 'root\n', as: 'edit' }, apply()] },
  { name: 'accepts exactly 64 KiB and refuses more, counted in UTF-8 bytes', tree: plain(), steps: [
    prepare('README.md', { repeat: ['a', 65537] }), prepare('README.md', { repeat: ['\u00e9', 32769] }), prepare('README.md', 'a\0b'),
    prepare('README.md', { repeat: ['\u00e9', 32768] }), apply()] },
  { name: 'refuses creating a file before anything else', tree: plain(), steps: [
    { op: 'prepare', root: 'plain', path: 'new.txt', reviewed: null, after: 'x' }, { op: 'prepare', root: 'missing', path: '../escape.txt', reviewed: null, after: 'x' }] },
  { name: 'refuses a stale expected hash', tree: plain(), steps: [refused('plain', 'README.md')] },
  { name: 'refuses forbidden, absolute and escaping paths', tree: plain([file('plain/.env', 'SECRET=1\n')]),
    steps: ['', '.env', 'docs/../README.md', 'C:\\x.txt', '/x.txt', 'README.md.', 'docs//b.md', 'nul', 'docs/b.md ', 'a:b.txt', 'id_rsa', 'cert.pem'].map(name => refused('plain', name)) },
  { name: 'refuses roots that are not working directories', tree: committed([], 'repo'),
    steps: [refused('', 'README.md'), refused('relative', 'README.md'), refused('repo/README.md', 'x'), refused('repo/.git', 'config'), refused('absent', 'README.md')] },
  { name: 'refuses directories, missing files and missing parents', tree: plain(),
    steps: [refused('plain', 'src'), refused('plain', 'missing.txt'), refused('plain', 'nope/x.txt'), refused('plain', 'README.md/x')] },
  { name: 'refuses binary and oversized files', tree: plain([
    { file: 'plain/zero.bin', base64: Buffer.from([0x61, 0x00, 0x62]).toString('base64') }, { file: 'plain/bad.txt', base64: Buffer.from([0x61, 0xff, 0x62]).toString('base64') },
    { file: 'plain/big.txt', repeat: ['b', 65537] }]),
  steps: [prepare('zero.bin', 'x'), prepare('bad.txt', 'x'), prepare('big.txt', 'x')] },
  { name: 'refuses a linked parent and a hard-linked file', tree: plain([{ junction: 'plain/link', target: 'plain/src' }, { hardlink: 'plain/twin.md', target: 'plain/docs/b.md' }]),
    steps: [{ op: 'prepare', root: 'plain', path: 'link/a.ts', reviewed: { hashOf: 'plain/src/a.ts' }, after: 'x' }, prepare('docs/b.md', 'x'), prepare('twin.md', 'x')] },
  { name: 'refuses a tampered approval before writing', tree: plain(), steps: [prepare('README.md', 'changed\n'), apply({ after: 'other\n' }), apply({ fingerprint: ZERO })] },
  { name: 'refuses an approval whose file changed after review', tree: plain(), steps: [prepare('README.md', 'changed\n'), { op: 'write', file: 'plain/README.md', text: 'edited elsewhere\n' }, apply()] },
  { name: 'refuses a second application of one approval', tree: plain(), steps: [prepare('README.md', 'changed\n'), apply(), apply()] },
  { name: 'applies an unchanged edit again', tree: plain(), steps: [prepare('README.md', 'hello\n'), apply(), apply()] },
  { name: 'refuses a file hard-linked after review', tree: plain(), steps: [prepare('README.md', 'changed\n'), { op: 'hardlink', link: 'plain/twin.md', target: 'plain/README.md' }, apply()] },
  { name: 'refuses a file removed after review', tree: plain(), steps: [prepare('README.md', 'changed\n'), { op: 'remove', file: 'plain/README.md' }, apply()] },
  { name: 'refuses a read-only file at execution', tree: plain(), steps: [prepare('README.md', 'changed\n'), { op: 'readonly', file: 'plain/README.md' }, apply()] },
  { name: 'follows the name to a swapped file with identical content', tree: plain([file('plain/copy.md', 'hello\n')]), steps: [
    prepare('README.md', 'changed\n'), { op: 'rename', from: 'plain/README.md', to: 'plain/original.md' }, { op: 'rename', from: 'plain/copy.md', to: 'plain/README.md' }, apply()] },
  { name: 'edits inside a Git working tree and never its metadata', tree: committed([], 'repo'), steps: [
    { op: 'prepare', root: 'repo', path: 'src/a.ts', reviewed: { hashOf: 'repo/src/a.ts' }, after: 'export const a = 3;\n', as: 'edit' }, apply(),
    refused('repo', '.git/config'), refused('repo', '.GIT/HEAD')] },
];

/** Every file beneath the scratch folder except Git's metadata and the isolated home, with the SHA-256 of its bytes. */
function files(scratch: string): [string, string][] {
  const found: [string, string][] = [];
  const visit = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(scratch, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || entry.name === '.git' || child === 'home') continue;
      if (entry.isDirectory()) visit(child);
      else found.push([child, sha256File(path.join(scratch, child))]);
    }
  };
  visit('');
  return found.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function outcome(error: unknown, scratch: string): Outcome {
  if (!(error instanceof Error)) throw error;
  const classified = error instanceof RepositoryError ? error.outcome : null;
  // applyEdit rewraps Node's raw errors, so the code is read from the message as well.
  const code = (error as NodeJS.ErrnoException).code ?? /^(E[A-Z]+): /.exec(error.message)?.[1];
  return typeof code === 'string' ? { systemError: code, outcome: classified } : { error: normalize(error.message, scratch) as string, outcome: classified };
}

it('pins the one-shot existing-file edit primitive of the shipping Node authority', async () => {
  const recorded: (Case & { steps: (EditStep & { expected: Outcome })[]; files: [string, string][] })[] = [];
  for (const item of cases) {
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-edit-')));
    const home = path.join(scratch, 'home'); fs.mkdirSync(home);
    try {
      build(scratch, home, item.tree);
      const service = new RepositoryService(path.join(scratch, 'wt'));
      const prepared = new Map<string, PreparedEdit>();
      const steps: (EditStep & { expected: Outcome })[] = [];
      await withIsolatedGit(home, async () => {
        for (const step of item.steps) {
          let result: Outcome = { result: null };
          try {
            if (step.op === 'prepare') {
              const expected = step.reviewed !== null && typeof step.reviewed === 'object' ? sha256File(path.join(scratch, step.reviewed.hashOf)) : step.reviewed;
              const after = typeof step.after === 'string' ? step.after : step.after.repeat[0].repeat(step.after.repeat[1]);
              const root = step.root && step.root !== 'relative' ? path.join(scratch, step.root) : step.root;
              const edit = await service.prepareEdit(root, step.path, expected, after);
              if (step.as) prepared.set(step.as, edit);
              const preimage = JSON.stringify([edit.root, edit.path, edit.expectedHash, edit.resultingHash]);
              expect(createHash('sha256').update(preimage).digest('hex')).toBe(edit.fingerprint);
              result = { result: normalize({ ...edit, fingerprint: { preimage } }, scratch) };
            } else if (step.op === 'apply') {
              const edit = prepared.get(step.edit)!;
              result = { result: normalize(await service.applyEdit({ ...edit, ...step.tamper }), scratch) };
            } else if (step.op === 'write') fs.writeFileSync(path.join(scratch, step.file), step.text);
            else if (step.op === 'rename') fs.renameSync(path.join(scratch, step.from), path.join(scratch, step.to));
            else if (step.op === 'remove') fs.rmSync(path.join(scratch, step.file));
            else if (step.op === 'hardlink') fs.linkSync(path.join(scratch, step.target), path.join(scratch, step.link));
            else fs.chmodSync(path.join(scratch, step.file), 0o444);
          } catch (error) { result = outcome(error, scratch); }
          steps.push({ ...step, expected: result });
        }
      });
      recorded.push({ ...item, steps, files: files(scratch) });
    } finally {
      for (const [relative] of files(scratch)) fs.chmodSync(path.join(scratch, relative), 0o666);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  const corpus = {
    schemaVersion: 1,
    oracle: { sources: ['packages/runtime/src/repository.ts', 'packages/runtime/src/network-path.ts'].map(source => ({ path: source, sha256: sha256File(source) })) },
    cases: recorded,
  };
  const target = 'tests/p2/existing-file-edit-vectors.json';
  if (process.env.P2_WRITE_EXISTING_FILE_EDIT === '1') fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(corpus);
}, 120_000);
