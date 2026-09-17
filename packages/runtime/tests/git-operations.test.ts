import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitOperationError, GitOperations, type PreparedHandoff } from '../src/git-operations.js';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout;
}

async function headSha(root: string): Promise<string> {
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

interface Fixture {
  base: string;
  sourceRoot: string;
  worktreeBase: string;
  ops: GitOperations;
}

async function fixture(): Promise<Fixture> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-git-ops-'));
  temporaryDirectories.push(base);
  const sourceRoot = path.join(base, 'project');
  await fs.mkdir(sourceRoot);
  await git(sourceRoot, ['init']);
  await git(sourceRoot, ['config', 'user.email', 'test@example.invalid']);
  await git(sourceRoot, ['config', 'user.name', 'Git operations test']);
  // Deterministic across a Windows CI account that may lack symlink privilege:
  // committed 120000 entries still materialize as plain text with this off.
  await git(sourceRoot, ['config', 'core.symlinks', 'false']);
  await fs.writeFile(path.join(sourceRoot, 'README.md'), 'initial\n');
  await git(sourceRoot, ['add', 'README.md']);
  await git(sourceRoot, ['commit', '-m', 'initial']);
  const worktreeBase = path.join(base, 'app-worktrees');
  const ops = new GitOperations(worktreeBase);
  return { base, sourceRoot, worktreeBase, ops };
}

async function createChild(fx: Fixture, base?: string): Promise<{ worktreePath: string; branch: string; baseCommit: string; baseTree: string }> {
  const baseCommit = base ?? (await headSha(fx.sourceRoot));
  return fx.ops.createChildWorktree(fx.sourceRoot, randomUUID(), baseCommit);
}

function allowAll(): (candidatePath: string) => boolean {
  return () => true;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('GitOperations.createChildWorktree', () => {
  it('creates an isolated child worktree from an exact base while the source checkout has dirty and untracked files', async () => {
    const fx = await fixture();
    const base = await headSha(fx.sourceRoot);
    await fs.writeFile(path.join(fx.sourceRoot, 'README.md'), 'dirty edit\n');
    await fs.writeFile(path.join(fx.sourceRoot, 'untracked.txt'), 'untracked\n');
    const sourceStatusBefore = await git(fx.sourceRoot, ['status', '--porcelain=v2']);
    const mainRefBefore = (await git(fx.sourceRoot, ['rev-parse', 'refs/heads/main'])).trim();

    const child = await createChild(fx, base);

    expect(child.baseCommit).toBe(base);
    expect(child.branch).toMatch(/^codex\/child\/[0-9a-f-]{36}$/);
    expect(await fs.readFile(path.join(child.worktreePath, 'README.md'), 'utf8')).toBe('initial\n');

    // The new codex/child/<id> branch is an intentional, app-owned shared Git mutation
    // (it lives in the source repository's own ref database via linked-worktree metadata);
    // what must stay untouched is HEAD, the index/worktree, and every pre-existing ref.
    expect(await headSha(fx.sourceRoot)).toBe(base);
    expect(await git(fx.sourceRoot, ['status', '--porcelain=v2'])).toBe(sourceStatusBefore);
    expect((await git(fx.sourceRoot, ['rev-parse', 'refs/heads/main'])).trim()).toBe(mainRefBefore);
    expect(await fs.readFile(path.join(fx.sourceRoot, 'README.md'), 'utf8')).toBe('dirty edit\n');
    expect(await fs.readFile(path.join(fx.sourceRoot, 'untracked.txt'), 'utf8')).toBe('untracked\n');
  });

  it('reports a preflight rejection with outcome none when the base commit does not exist', async () => {
    const fx = await fixture();
    const fakeCommit = '1'.repeat(40);
    const error = await fx.ops.createChildWorktree(fx.sourceRoot, randomUUID(), fakeCommit).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
  });
});

describe('GitOperations handoff commits', () => {
  it('prepares and commits a handoff covering a modification, an untracked addition, and a deletion, calling hooks in order', async () => {
    const fx = await fixture();
    await fs.writeFile(path.join(fx.sourceRoot, 'to-delete.txt'), 'bye\n');
    await git(fx.sourceRoot, ['add', 'to-delete.txt']);
    await git(fx.sourceRoot, ['commit', '-m', 'add file to delete']);
    const base = await headSha(fx.sourceRoot);
    const child = await createChild(fx, base);

    await fs.writeFile(path.join(child.worktreePath, 'README.md'), 'modified\n');
    await fs.writeFile(path.join(child.worktreePath, 'new.txt'), 'brand new\n');
    await fs.rm(path.join(child.worktreePath, 'to-delete.txt'));

    const prepared = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: base, message: 'child handoff', allowed: allowAll(),
    });

    expect(prepared.paths).toEqual(['README.md', 'new.txt', 'to-delete.txt']);
    expect(prepared.manifest.entries.map((entry) => [entry.path, entry.status])).toEqual([
      ['README.md', 'M'], ['new.txt', 'A'], ['to-delete.txt', 'D'],
    ]);

    const order: string[] = [];
    let stagedTree = '';
    let committedSha = '';
    const result = await fx.ops.commitHandoff(prepared, {
      staged: (tree) => { order.push('staged'); stagedTree = tree; },
      committed: (commit) => { order.push('committed'); committedSha = commit; },
    });

    expect(order).toEqual(['staged', 'committed']);
    expect(stagedTree).toBe(result.tree);
    expect(committedSha).toBe(result.commit);

    const info = await fx.ops.commitInfo(child.worktreePath, result.commit);
    expect(info.parents).toEqual([base]);
    expect(info.tree).toBe(result.tree);

    const manifestAfter = await fx.ops.manifest(child.worktreePath, base, result.commit);
    expect(manifestAfter.sha256).toBe(prepared.manifest.sha256);

    const after = await fx.ops.state(child.worktreePath);
    expect(after.head).toBe(result.commit);
    expect(after.clean).toBe(true);
    expect(after.operation).toBe('none');
  }, 30000);

  it('rejects a path outside the approved scope', async () => {
    const fx = await fixture();
    const child = await createChild(fx);
    await fs.writeFile(path.join(child.worktreePath, 'README.md'), 'edited\n');
    const error = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: child.baseCommit, message: 'msg', allowed: () => false,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
    expect(String(error)).toMatch(/scope/i);
  });

  it('rejects preparing a handoff when the index already has staged content', async () => {
    const fx = await fixture();
    const child = await createChild(fx);
    await fs.writeFile(path.join(child.worktreePath, 'README.md'), 'edited\n');
    await git(child.worktreePath, ['add', 'README.md']);
    const error = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: child.baseCommit, message: 'msg', allowed: allowAll(),
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
  });

  it('rejects a stale expected head', async () => {
    const fx = await fixture();
    const child = await createChild(fx);
    await fs.writeFile(path.join(child.worktreePath, 'README.md'), 'edited\n');
    const error = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: '1'.repeat(40), message: 'msg', allowed: allowAll(),
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
  });

  it('rejects changes to .gitmodules', async () => {
    const fx = await fixture();
    const child = await createChild(fx);
    await fs.writeFile(path.join(child.worktreePath, '.gitmodules'), '[submodule "x"]\n');
    const error = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: child.baseCommit, message: 'msg', allowed: allowAll(),
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
    expect(String(error)).toMatch(/gitmodules/i);
  });

  it('rejects a changed path whose HEAD tree mode is a gitlink', async () => {
    const fx = await fixture();
    await git(fx.sourceRoot, ['update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,sub']);
    await git(fx.sourceRoot, ['commit', '-m', 'add gitlink']);
    const base = await headSha(fx.sourceRoot);
    const child = await createChild(fx, base);
    // Checkout materializes an empty placeholder directory for the uninitialized gitlink;
    // removing it produces a natural unstaged deletion whose HEAD tree mode is 160000.
    await fs.rmdir(path.join(child.worktreePath, 'sub'));
    await fs.writeFile(path.join(child.worktreePath, 'README.md'), 'unrelated change\n');
    const error = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: base, message: 'msg', allowed: allowAll(),
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
    expect(String(error)).toMatch(/gitlink/i);
  });

  it('rejects a changed path whose mode is a symlink', async () => {
    const fx = await fixture();
    const blob = (await git(fx.sourceRoot, ['hash-object', '-w', '--no-filters', path.join(fx.sourceRoot, 'README.md')])).trim();
    await git(fx.sourceRoot, ['update-index', '--add', '--cacheinfo', `120000,${blob},link.txt`]);
    await git(fx.sourceRoot, ['commit', '-m', 'add symlink entry']);
    const base = await headSha(fx.sourceRoot);
    const child = await createChild(fx, base);
    // core.symlinks=false materializes this as a plain text file; editing it produces
    // a natural unstaged modification whose index/worktree mode is still 120000.
    await fs.writeFile(path.join(child.worktreePath, 'link.txt'), 'changed target\n');
    const error = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: base, message: 'msg', allowed: allowAll(),
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
    expect(String(error)).toMatch(/symlink/i);
  });

  it('parses case-differing status records as distinct changed paths', async () => {
    // A tracked "Readme.md" plus a new untracked "README.md" cannot coexist on NTFS
    // (case-insensitive, case-preserving), so prepareHandoff's case-collision rejection
    // cannot be exercised end-to-end on this platform. Verify the underlying status
    // parser keeps two index-plumbed case variants distinct instead (it never merges or
    // drops one), which is the part of the module actually at risk of a parsing bug.
    const fx = await fixture();
    const child = await createChild(fx);
    const blob = (await git(child.worktreePath, ['hash-object', '-w', '--no-filters', path.join(child.worktreePath, 'README.md')])).trim();
    await git(child.worktreePath, ['update-index', '--add', '--cacheinfo', `100644,${blob},lower-case.txt`]);
    await git(child.worktreePath, ['update-index', '--add', '--cacheinfo', `100644,${blob},Lower-Case.txt`]);
    const changed = await fx.ops.changedPaths(child.worktreePath);
    // Each cacheinfo-only path is both a staged add and an unstaged delete (the blob was
    // registered in the index but never written to disk), so two ChangedPath rows per path
    // is correct; what matters is that the parser never merges or drops either literal path.
    const uniquePaths = [...new Set(changed.map((entry) => entry.path))].sort();
    expect(uniquePaths).toEqual(['Lower-Case.txt', 'lower-case.txt']);
  });

  it('rejects a stale fingerprint after the file changes again, without staging anything', async () => {
    const fx = await fixture();
    const child = await createChild(fx);
    await fs.writeFile(path.join(child.worktreePath, 'README.md'), 'first edit\n');
    const prepared = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: child.baseCommit, message: 'msg', allowed: allowAll(),
    });
    await fs.writeFile(path.join(child.worktreePath, 'README.md'), 'second edit, different from approval\n');

    const error = await fx.ops.commitHandoff(prepared, { staged: () => {}, committed: () => {} }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
    const state = await fx.ops.state(child.worktreePath);
    expect(state.stagedClean).toBe(true);
  });

  it('surfaces unknown when a staged hook throws, and reconciles the staged-but-uncommitted state as unknown', async () => {
    const fx = await fixture();
    const child = await createChild(fx);
    await fs.writeFile(path.join(child.worktreePath, 'README.md'), 'edited\n');
    const prepared = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: child.baseCommit, message: 'msg', allowed: allowAll(),
    });

    const error = await fx.ops.commitHandoff(prepared, {
      staged: () => { throw new Error('boom'); },
      committed: () => { throw new Error('should not run'); },
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('unknown');

    const reconciled = await fx.ops.reconcileHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: child.baseCommit, manifest: prepared.manifest,
    });
    expect(reconciled.kind).toBe('unknown');
  });

  it('reconciles a completed handoff commit as complete', async () => {
    const fx = await fixture();
    const child = await createChild(fx);
    await fs.writeFile(path.join(child.worktreePath, 'README.md'), 'edited\n');
    const prepared = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: child.baseCommit, message: 'msg', allowed: allowAll(),
    });
    const result = await fx.ops.commitHandoff(prepared, { staged: () => {}, committed: () => {} });
    const reconciled = await fx.ops.reconcileHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: child.baseCommit, manifest: prepared.manifest,
    });
    expect(reconciled).toEqual({ kind: 'complete', commit: result.commit, tree: result.tree });

    const notStarted = await fx.ops.reconcileHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: result.commit, manifest: prepared.manifest,
    });
    expect(notStarted).toEqual({ kind: 'not-started' });
  });
});

describe('GitOperations.manifest', () => {
  it('is identical for identical effects and differs for a pure mode change', async () => {
    const fx = await fixture();
    await fs.writeFile(path.join(fx.sourceRoot, 'exec.sh'), 'echo hi\n');
    await git(fx.sourceRoot, ['add', 'exec.sh']);
    await git(fx.sourceRoot, ['commit', '-m', 'add script']);
    const base = await headSha(fx.sourceRoot);

    await git(fx.sourceRoot, ['update-index', '--chmod=+x', 'exec.sh']);
    await git(fx.sourceRoot, ['commit', '-m', 'make executable']);
    const chmodCommit = await headSha(fx.sourceRoot);

    const identicalManifestA = await fx.ops.manifest(fx.sourceRoot, base, base);
    const identicalManifestB = await fx.ops.manifest(fx.sourceRoot, base, base);
    expect(identicalManifestA.sha256).toBe(identicalManifestB.sha256);
    expect(identicalManifestA.entries).toEqual([]);

    const modeChangeManifest = await fx.ops.manifest(fx.sourceRoot, base, chmodCommit);
    expect(modeChangeManifest.entries).toHaveLength(1);
    expect(modeChangeManifest.entries[0]?.oldMode).not.toBe(modeChangeManifest.entries[0]?.newMode);
    expect(modeChangeManifest.sha256).not.toBe(identicalManifestA.sha256);
  });
});

describe('GitOperations cherry-pick integration', () => {
  async function prepareAndCommit(fx: Fixture, child: { worktreePath: string; branch: string; baseCommit: string }, fileName: string, content: string): Promise<{ commit: string; tree: string; prepared: PreparedHandoff }> {
    await fs.writeFile(path.join(child.worktreePath, fileName), content);
    const prepared = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: child.baseCommit, message: `add ${fileName}`, allowed: allowAll(),
    });
    const result = await fx.ops.commitHandoff(prepared, { staged: () => {}, committed: () => {} });
    return { ...result, prepared };
  }

  it('cherry-picks two independent handoffs serially into the integration worktree', async () => {
    const fx = await fixture();
    const base = await headSha(fx.sourceRoot);
    const integration = await createChild(fx, base);
    const childA = await createChild(fx, base);
    const childB = await createChild(fx, base);

    const resultA = await prepareAndCommit(fx, childA, 'a.txt', 'from child a\n');
    const resultB = await prepareAndCommit(fx, childB, 'b.txt', 'from child b\n');

    const preA = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: base, sha: resultA.commit });
    const outcomeA = await fx.ops.cherryPick(integration.worktreePath, {
      branch: integration.branch, expectedHead: base, expectedTree: preA.tree, sha: resultA.commit, expectedManifest: preA.sourceManifest,
    });
    expect(outcomeA.kind).toBe('succeeded');
    if (outcomeA.kind !== 'succeeded') throw new Error('expected success');

    const preB = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: outcomeA.commit, sha: resultB.commit });
    const outcomeB = await fx.ops.cherryPick(integration.worktreePath, {
      branch: integration.branch, expectedHead: outcomeA.commit, expectedTree: preB.tree, sha: resultB.commit, expectedManifest: preB.sourceManifest,
    });
    expect(outcomeB.kind).toBe('succeeded');
    if (outcomeB.kind !== 'succeeded') throw new Error('expected success');

    expect(await fs.readFile(path.join(integration.worktreePath, 'a.txt'), 'utf8')).toBe('from child a\n');
    expect(await fs.readFile(path.join(integration.worktreePath, 'b.txt'), 'utf8')).toBe('from child b\n');

    const combinedManifest = await fx.ops.manifest(integration.worktreePath, base, outcomeB.commit);
    expect(combinedManifest.entries.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);

    const reconciled = await fx.ops.reconcileIntegration(integration.worktreePath, {
      branch: integration.branch, expectedHead: outcomeA.commit, sha: resultB.commit, expectedManifest: preB.sourceManifest,
    });
    expect(reconciled).toMatchObject({ kind: 'succeeded', commit: outcomeB.commit });

    expect(await fx.ops.isAncestor(integration.worktreePath, base, outcomeB.commit)).toBe(true);
    expect(await fx.ops.isAncestor(integration.worktreePath, outcomeB.commit, base)).toBe(false);
  }, 60000);

  it('rejects a cherry-pick prepared against a stale target head', async () => {
    const fx = await fixture();
    const base = await headSha(fx.sourceRoot);
    const integration = await createChild(fx, base);
    const child = await createChild(fx, base);
    const result = await prepareAndCommit(fx, child, 'a.txt', 'content\n');
    const pre = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: base, sha: result.commit });

    // Advance the integration worktree so the earlier preflight is now stale.
    await fs.writeFile(path.join(integration.worktreePath, 'unrelated.txt'), 'x\n');
    const advancePrepared = await fx.ops.prepareHandoff(integration.worktreePath, {
      branch: integration.branch, expectedHead: base, message: 'advance', allowed: allowAll(),
    });
    const advanced = await fx.ops.commitHandoff(advancePrepared, { staged: () => {}, committed: () => {} });

    const error = await fx.ops.cherryPick(integration.worktreePath, {
      branch: integration.branch, expectedHead: base, expectedTree: pre.tree, sha: result.commit, expectedManifest: pre.sourceManifest,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
    expect(await fx.ops.isAncestor(integration.worktreePath, advanced.commit, integration.baseCommit)).toBe(false);
  }, 30000);

  it('rejects a cherry-pick preflight when the target worktree is dirty', async () => {
    const fx = await fixture();
    const base = await headSha(fx.sourceRoot);
    const integration = await createChild(fx, base);
    const child = await createChild(fx, base);
    const result = await prepareAndCommit(fx, child, 'a.txt', 'content\n');
    await fs.writeFile(path.join(integration.worktreePath, 'README.md'), 'dirty\n');

    const error = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: base, sha: result.commit })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
  });

  it('rejects a cherry-pick when a custom merge driver is configured', async () => {
    const fx = await fixture();
    const base = await headSha(fx.sourceRoot);
    const integration = await createChild(fx, base);
    const child = await createChild(fx, base);
    const result = await prepareAndCommit(fx, child, 'a.txt', 'content\n');
    await git(integration.worktreePath, ['config', 'merge.custom.driver', 'true %O %A %B']);

    const error = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: base, sha: result.commit })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
    expect(String(error)).toMatch(/merge driver/i);
  });

  it('does not classify a forged-provenance commit as succeeded against the approved manifest', async () => {
    const fx = await fixture();
    const base = await headSha(fx.sourceRoot);
    const integration = await createChild(fx, base);
    const child = await createChild(fx, base);
    const result = await prepareAndCommit(fx, child, 'a.txt', 'real content\n');
    const pre = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: base, sha: result.commit });

    // Forge a commit in the integration worktree with a matching '-x' provenance trailer
    // but a different effect than the one that was actually reviewed and approved.
    await fs.writeFile(path.join(integration.worktreePath, 'a.txt'), 'forged content\n');
    const forgedPrepared = await fx.ops.prepareHandoff(integration.worktreePath, {
      branch: integration.branch, expectedHead: base,
      message: `forged\n\n(cherry picked from commit ${result.commit})`, allowed: allowAll(),
    });
    const forged = await fx.ops.commitHandoff(forgedPrepared, { staged: () => {}, committed: () => {} });

    const reconciled = await fx.ops.reconcileIntegration(integration.worktreePath, {
      branch: integration.branch, expectedHead: base, sha: result.commit, expectedManifest: pre.sourceManifest,
    });
    expect(reconciled.kind).toBe('mismatch');
    if (reconciled.kind === 'mismatch') expect(reconciled.commit).toBe(forged.commit);
  });

  it('preserves a real conflict with CHERRY_PICK_HEAD and unmerged paths without aborting', async () => {
    const fx = await fixture();
    await fs.writeFile(path.join(fx.sourceRoot, 'shared.txt'), 'line1\nline2\nline3\n');
    await git(fx.sourceRoot, ['add', 'shared.txt']);
    await git(fx.sourceRoot, ['commit', '-m', 'add shared file']);
    const base = await headSha(fx.sourceRoot);
    const integration = await createChild(fx, base);
    const childA = await createChild(fx, base);
    const childB = await createChild(fx, base);

    const resultA = await prepareAndCommitOverwrite(fx, childA, 'shared.txt', 'line1-A\nline2\nline3\n');
    const resultB = await prepareAndCommitOverwrite(fx, childB, 'shared.txt', 'line1-B\nline2\nline3\n');

    const preA = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: base, sha: resultA.commit });
    const outcomeA = await fx.ops.cherryPick(integration.worktreePath, {
      branch: integration.branch, expectedHead: base, expectedTree: preA.tree, sha: resultA.commit, expectedManifest: preA.sourceManifest,
    });
    expect(outcomeA.kind).toBe('succeeded');
    if (outcomeA.kind !== 'succeeded') throw new Error('expected success');

    const preB = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: outcomeA.commit, sha: resultB.commit });
    const outcomeB = await fx.ops.cherryPick(integration.worktreePath, {
      branch: integration.branch, expectedHead: outcomeA.commit, expectedTree: preB.tree, sha: resultB.commit, expectedManifest: preB.sourceManifest,
    });
    expect(outcomeB.kind).toBe('conflict');
    if (outcomeB.kind !== 'conflict') throw new Error('expected conflict');
    expect(outcomeB.unmergedPaths).toEqual(['shared.txt']);

    const state = await fx.ops.state(integration.worktreePath);
    expect(state.operation).toBe('cherry-pick');
    expect(state.cherryPickHead).toBe(outcomeB.cherryPickHead);
    expect(state.unmergedPaths).toEqual(['shared.txt']);
    expect(state.head).toBe(outcomeA.commit);

    const reconciled = await fx.ops.reconcileIntegration(integration.worktreePath, {
      branch: integration.branch, expectedHead: outcomeA.commit, sha: resultB.commit, expectedManifest: preB.sourceManifest,
    });
    expect(reconciled).toMatchObject({ kind: 'conflict', cherryPickHead: outcomeB.cherryPickHead });

    // Resolve the conflict as an external editor would, then continue.
    await fs.writeFile(path.join(integration.worktreePath, 'shared.txt'), 'line1-resolved\nline2\nline3\n');
    await git(integration.worktreePath, ['add', 'shared.txt']);

    const preparedContinue = await fx.ops.prepareContinue(integration.worktreePath, {
      branch: integration.branch, expectedHead: outcomeA.commit, cherryPickHead: outcomeB.cherryPickHead,
    });
    const continued = await fx.ops.continueCherryPick(integration.worktreePath, {
      branch: integration.branch, expectedHead: outcomeA.commit, cherryPickHead: outcomeB.cherryPickHead, prepared: preparedContinue,
    });
    expect(continued.kind).toBe('succeeded');
    if (continued.kind !== 'succeeded') throw new Error('expected success');
    expect(continued.tree).toBe(preparedContinue.resolvedTree);
    expect(await fs.readFile(path.join(integration.worktreePath, 'shared.txt'), 'utf8')).toBe('line1-resolved\nline2\nline3\n');

    const finalState = await fx.ops.state(integration.worktreePath);
    expect(finalState.clean).toBe(true);
    expect(finalState.operation).toBe('none');
  }, 60000);

  it('refuses prepareContinue while unresolved or untracked changes remain', async () => {
    const fx = await fixture();
    await fs.writeFile(path.join(fx.sourceRoot, 'shared.txt'), 'line1\nline2\nline3\n');
    await git(fx.sourceRoot, ['add', 'shared.txt']);
    await git(fx.sourceRoot, ['commit', '-m', 'add shared file']);
    const base = await headSha(fx.sourceRoot);
    const integration = await createChild(fx, base);
    const childA = await createChild(fx, base);
    const childB = await createChild(fx, base);

    const resultA = await prepareAndCommitOverwrite(fx, childA, 'shared.txt', 'line1-A\nline2\nline3\n');
    const resultB = await prepareAndCommitOverwrite(fx, childB, 'shared.txt', 'line1-B\nline2\nline3\n');

    const preA = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: base, sha: resultA.commit });
    const outcomeA = await fx.ops.cherryPick(integration.worktreePath, {
      branch: integration.branch, expectedHead: base, expectedTree: preA.tree, sha: resultA.commit, expectedManifest: preA.sourceManifest,
    });
    if (outcomeA.kind !== 'succeeded') throw new Error('expected success');
    const preB = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: outcomeA.commit, sha: resultB.commit });
    const outcomeB = await fx.ops.cherryPick(integration.worktreePath, {
      branch: integration.branch, expectedHead: outcomeA.commit, expectedTree: preB.tree, sha: resultB.commit, expectedManifest: preB.sourceManifest,
    });
    if (outcomeB.kind !== 'conflict') throw new Error('expected conflict');

    const unresolvedError = await fx.ops.prepareContinue(integration.worktreePath, {
      branch: integration.branch, expectedHead: outcomeA.commit, cherryPickHead: outcomeB.cherryPickHead,
    }).catch((reason: unknown) => reason);
    expect(unresolvedError).toBeInstanceOf(GitOperationError);
    expect((unresolvedError as GitOperationError).outcome).toBe('none');

    await fs.writeFile(path.join(integration.worktreePath, 'shared.txt'), 'line1-resolved\nline2\nline3\n');
    await git(integration.worktreePath, ['add', 'shared.txt']);
    await fs.writeFile(path.join(integration.worktreePath, 'stray.txt'), 'oops\n');

    const untrackedError = await fx.ops.prepareContinue(integration.worktreePath, {
      branch: integration.branch, expectedHead: outcomeA.commit, cherryPickHead: outcomeB.cherryPickHead,
    }).catch((reason: unknown) => reason);
    expect(untrackedError).toBeInstanceOf(GitOperationError);
    expect((untrackedError as GitOperationError).outcome).toBe('none');
  }, 60000);

  it('classifies an already-applied cherry-pick as empty and leaves the worktree unchanged', async () => {
    const fx = await fixture();
    const base = await headSha(fx.sourceRoot);
    const integration = await createChild(fx, base);
    const child = await createChild(fx, base);
    const result = await prepareAndCommit(fx, child, 'a.txt', 'same content\n');

    const pre1 = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: base, sha: result.commit });
    const outcome1 = await fx.ops.cherryPick(integration.worktreePath, {
      branch: integration.branch, expectedHead: base, expectedTree: pre1.tree, sha: result.commit, expectedManifest: pre1.sourceManifest,
    });
    expect(outcome1.kind).toBe('succeeded');
    if (outcome1.kind !== 'succeeded') throw new Error('expected success');

    // Apply the same effect independently on a sibling branch of the same base, then try
    // to cherry-pick the original commit on top of the branch that already has it.
    const secondChild = await createChild(fx, base);
    const secondResult = await prepareAndCommit(fx, secondChild, 'a.txt', 'same content\n');
    const secondIntegration = await createChild(fx, secondResult.commit);
    const preEmpty = await fx.ops.prepareCherryPick(secondIntegration.worktreePath, {
      branch: secondIntegration.branch, expectedHead: secondResult.commit, sha: result.commit,
    });
    const outcomeEmpty = await fx.ops.cherryPick(secondIntegration.worktreePath, {
      branch: secondIntegration.branch, expectedHead: secondResult.commit, expectedTree: preEmpty.tree, sha: result.commit, expectedManifest: preEmpty.sourceManifest,
    });
    expect(outcomeEmpty.kind).toBe('empty');

    const stateAfter = await fx.ops.state(secondIntegration.worktreePath);
    expect(stateAfter.head).toBe(secondResult.commit);
    expect(await fs.readFile(path.join(secondIntegration.worktreePath, 'a.txt'), 'utf8')).toBe('same content\n');
  }, 60000);

  it('reconcileIntegration reports not-started before any cherry-pick has run', async () => {
    const fx = await fixture();
    const base = await headSha(fx.sourceRoot);
    const integration = await createChild(fx, base);
    const child = await createChild(fx, base);
    const result = await prepareAndCommit(fx, child, 'a.txt', 'content\n');
    const pre = await fx.ops.prepareCherryPick(integration.worktreePath, { branch: integration.branch, expectedHead: base, sha: result.commit });

    const reconciled = await fx.ops.reconcileIntegration(integration.worktreePath, {
      branch: integration.branch, expectedHead: base, sha: result.commit, expectedManifest: pre.sourceManifest,
    });
    expect(reconciled).toEqual({ kind: 'not-started' });
  });

  async function prepareAndCommitOverwrite(
    fx: Fixture,
    child: { worktreePath: string; branch: string; baseCommit: string },
    fileName: string,
    content: string,
  ): Promise<{ commit: string; tree: string }> {
    await fs.writeFile(path.join(child.worktreePath, fileName), content);
    const prepared = await fx.ops.prepareHandoff(child.worktreePath, {
      branch: child.branch, expectedHead: child.baseCommit, message: `update ${fileName}`, allowed: allowAll(),
    });
    return fx.ops.commitHandoff(prepared, { staged: () => {}, committed: () => {} });
  }
});

describe('GitOperations.isAncestor', () => {
  it('throws GitOperationError with outcome none for an invalid object', async () => {
    const fx = await fixture();
    const base = await headSha(fx.sourceRoot);
    const error = await fx.ops.isAncestor(fx.sourceRoot, '1'.repeat(40), base).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitOperationError);
    expect((error as GitOperationError).outcome).toBe('none');
  });
});
