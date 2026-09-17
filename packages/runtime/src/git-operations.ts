import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_OUTPUT_BYTES = 512 * 1024;
const PATCH_LIMIT_BYTES = 256 * 1024;
const MAX_PATHS = 5_000;
const EMPTY_HOOKS_DIRECTORY = '.empty-git-hooks';
const EMPTY_DIFF_SOURCE_NAME = '.empty-git-diff-source';
const CHILDREN_DIRECTORY = 'children';
const CHILD_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DANGEROUS_MODES = new Set(['120000', '160000']);
const PERMITTED_MERGE_ATTRIBUTE_VALUES = new Set(['unspecified', 'set', 'unset', 'text', 'binary', 'union']);

type GitOutput = { stdout: string; truncated: boolean; exitCode: number };
type GitCallOptions = { mutating?: boolean; permitTruncation?: boolean; allowNonZero?: boolean };

type RawStatusRecord =
  | { kind: '1'; xy: string; mH: string; mI: string; mW: string; path: string }
  | { kind: '2'; xy: string; mH: string; mI: string; mW: string; path: string; origPath: string }
  | { kind: 'u'; xy: string; m1: string; m2: string; m3: string; mW: string; path: string }
  | { kind: '?'; path: string };

/** Distinguishes a preflight rejection from a Git operation whose effects need reconciliation. */
export class GitOperationError extends Error {
  public constructor(
    message: string,
    public readonly outcome: 'none' | 'unknown',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GitOperationError';
  }
}

export interface GitIdentity {
  path: string;
  sha256: string;
}

export interface EffectEntry {
  path: string;
  status: 'A' | 'M' | 'D' | 'T';
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
}

export interface EffectManifest {
  entries: EffectEntry[];
  sha256: string;
}

export type GitOperationKind = 'none' | 'cherry-pick' | 'sequencer' | 'merge' | 'rebase' | 'revert' | 'am' | 'bisect';

export interface WorktreeState {
  head: string;
  tree: string;
  branch: string | null;
  clean: boolean;
  stagedClean: boolean;
  operation: GitOperationKind;
  cherryPickHead: string | null;
  unmergedPaths: string[];
}

export interface ChangedPath {
  path: string;
  kind: 'modified' | 'added' | 'deleted' | 'typechange' | 'untracked' | 'unmerged';
  staged: boolean;
  indexMode: string | null;
  worktreeMode: string | null;
}

export interface PreparedHandoff {
  worktreePath: string;
  branch: string;
  expectedHead: string;
  paths: string[];
  entries: { path: string; mode: string | null; blob: string | null }[];
  manifest: EffectManifest;
  patch: string;
  patchTruncated: boolean;
  message: string;
  git: GitIdentity;
  fingerprint: string;
}

export type CherryPickOutcome =
  | { kind: 'succeeded'; commit: string; tree: string }
  | { kind: 'mismatch'; commit: string; tree: string; detail: string }
  | { kind: 'conflict'; cherryPickHead: string; unmergedPaths: string[]; indexFingerprint: string }
  | { kind: 'empty'; cherryPickHead: string | null; detail: string }
  | { kind: 'no-effect'; detail: string }
  | { kind: 'unknown'; detail: string };

export interface PreparedContinue {
  resolvedTree: string;
  manifest: EffectManifest;
  patch: string;
  patchTruncated: boolean;
  git: GitIdentity;
  fingerprint: string;
}

/** Narrow, reviewed local Git operations for coordinator/child worktrees. Read paths never mutate; mutating paths distinguish 'none' (nothing happened) from 'unknown' (effects need reconciliation). */
export class GitOperations {
  private gitExecutable: Promise<string> | undefined;
  private hooksDirectoryPromise: Promise<string> | undefined;
  private emptyDiffSourcePromise: Promise<string> | undefined;

  public constructor(private readonly worktreeBase: string) {}

  // ---------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------

  public async identity(excludedRoot: string): Promise<GitIdentity> {
    return this.guardedNone(async () => {
      const executable = await this.getGitExecutable(excludedRoot);
      const bytes = await fs.readFile(executable);
      return { path: executable, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
  }

  // ---------------------------------------------------------------------
  // Child worktrees
  // ---------------------------------------------------------------------

  public async createChildWorktree(
    sourceProjectPath: string,
    childTaskId: string,
    baseCommit: string,
  ): Promise<{ worktreePath: string; branch: string; baseCommit: string; baseTree: string }> {
    return this.guardedMutation(async (markMutation) => {
      const projectRoot = await this.requireRepository(sourceProjectPath);
      if (!/^[0-9a-f]{40}$/i.test(baseCommit)) throw new Error('Base commit must be a full 40-character hex commit id.');
      const normalizedBase = baseCommit.toLowerCase();
      const verified = (await this.git(projectRoot, ['rev-parse', '--verify', `${normalizedBase}^{commit}`])).stdout.trim().toLowerCase();
      if (verified !== normalizedBase) throw new Error('Base commit does not exist in the source repository.');
      const baseTree = (await this.git(projectRoot, ['rev-parse', '--verify', `${normalizedBase}^{tree}`])).stdout.trim();

      await this.rejectTrackedFilters(projectRoot);

      const id = this.requireChildId(childTaskId);
      const branch = `codex/child/${id}`;
      const childrenBase = await this.prepareChildrenBase();
      const worktreePath = path.join(childrenBase, id);

      // A timeout or process failure can occur after Git has created refs or worktree metadata.
      markMutation();
      await this.git(projectRoot, ['worktree', 'add', '--no-checkout', '-b', branch, worktreePath, normalizedBase], { mutating: true });
      // Checkout may run filters, so it follows the tracked-filter check above and disables hooks.
      await this.git(worktreePath, ['checkout', '--no-recurse-submodules', branch], { mutating: true });

      return { worktreePath, branch, baseCommit: normalizedBase, baseTree };
    });
  }

  // ---------------------------------------------------------------------
  // Read-only worktree inspection
  // ---------------------------------------------------------------------

  public async state(worktreePath: string): Promise<WorktreeState> {
    return this.guardedNone(async () => {
      const head = (await this.git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
      const tree = (await this.git(worktreePath, ['rev-parse', '--verify', 'HEAD^{tree}'])).stdout.trim();
      const branchResult = await this.git(worktreePath, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowNonZero: true });
      const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;

      const records = await this.statusRecords(worktreePath);
      const clean = records.length === 0;
      const stagedClean = !records.some((record) => (record.kind === '1' && record.xy.charAt(0) !== '.') || record.kind === '2' || record.kind === 'u');
      const unmergedPaths = records.filter((record): record is Extract<RawStatusRecord, { kind: 'u' }> => record.kind === 'u').map((record) => record.path);

      const operation = await this.detectOperation(worktreePath);

      return { head, tree, branch, clean, stagedClean, operation: operation.kind, cherryPickHead: operation.cherryPickHead, unmergedPaths };
    });
  }

  public async changedPaths(worktreePath: string): Promise<ChangedPath[]> {
    return this.guardedNone(async () => {
      const records = await this.statusRecords(worktreePath);
      const results: ChangedPath[] = [];
      for (const record of records) {
        if (record.kind === '1') {
          const x = record.xy.charAt(0);
          const y = record.xy.charAt(1);
          if (x !== '.') results.push({ path: record.path, kind: this.classifyStatusCode(x), staged: true, indexMode: record.mI, worktreeMode: record.mW });
          if (y !== '.') results.push({ path: record.path, kind: this.classifyStatusCode(y), staged: false, indexMode: record.mI, worktreeMode: record.mW });
        } else if (record.kind === '2') {
          // Defensive: with status.renames=false git should not emit rename records.
          const staged = record.xy.charAt(0) !== '.';
          results.push({ path: record.origPath, kind: 'deleted', staged, indexMode: record.mI, worktreeMode: record.mW });
          results.push({ path: record.path, kind: 'added', staged, indexMode: record.mI, worktreeMode: record.mW });
        } else if (record.kind === 'u') {
          results.push({ path: record.path, kind: 'unmerged', staged: true, indexMode: null, worktreeMode: record.mW });
        } else {
          const full = path.join(worktreePath, record.path);
          let worktreeMode: string | null = '100644';
          try {
            const lstat = await fs.lstat(full);
            if (lstat.isSymbolicLink()) worktreeMode = '120000';
          } catch {
            worktreeMode = null;
          }
          results.push({ path: record.path, kind: 'untracked', staged: false, indexMode: null, worktreeMode });
        }
      }
      return results;
    });
  }

  public async commitInfo(worktreePath: string, sha: string): Promise<{ sha: string; tree: string; parents: string[] }> {
    return this.guardedNone(async () => {
      const full = (await this.git(worktreePath, ['rev-parse', '--verify', `${sha}^{commit}`])).stdout.trim();
      if (!full) throw new Error('Commit does not exist.');
      const tree = (await this.git(worktreePath, ['rev-parse', '--verify', `${full}^{tree}`])).stdout.trim();
      const parentsRaw = (await this.git(worktreePath, ['show', '-s', '--format=%P', full])).stdout.trim();
      const parents = parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [];
      return { sha: full, tree, parents };
    });
  }

  public async manifest(worktreePath: string, from: string, to: string): Promise<EffectManifest> {
    return this.guardedNone(async () => {
      const raw = (await this.git(worktreePath, ['diff-tree', '-r', '-z', '--raw', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', from, to])).stdout;
      const entries = this.sortByPathBytes(this.parseDiffTreeRaw(raw));
      return { entries, sha256: this.hashManifestEntries(entries) };
    });
  }

  public async patch(worktreePath: string, from: string, to: string): Promise<{ patch: string; truncated: boolean }> {
    return this.guardedNone(async () => {
      const result = await this.git(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', from, to], { permitTruncation: true });
      return { patch: result.stdout, truncated: result.truncated };
    });
  }

  public async isAncestor(worktreePath: string, ancestor: string, descendant: string): Promise<boolean> {
    return this.guardedNone(async () => {
      const result = await this.git(worktreePath, ['merge-base', '--is-ancestor', ancestor, descendant], { allowNonZero: true });
      if (result.exitCode === 0) return true;
      if (result.exitCode === 1) return false;
      throw new Error(`Unable to determine ancestry (exit code ${result.exitCode}).`);
    });
  }

  // ---------------------------------------------------------------------
  // Child handoff commit
  // ---------------------------------------------------------------------

  public async prepareHandoff(
    worktreePath: string,
    input: { branch: string; expectedHead: string; message: string; allowed: (candidatePath: string) => boolean },
  ): Promise<PreparedHandoff> {
    return this.guardedNone(async () => {
      this.validateMessage(input.message);

      const state = await this.state(worktreePath);
      if (state.branch !== input.branch) throw new Error('Worktree is not on the expected branch.');
      if (state.head !== input.expectedHead) throw new Error('Worktree HEAD does not match the expected base.');
      if (state.operation !== 'none') throw new Error('A Git operation is already in progress.');
      if (!state.stagedClean) throw new Error('The index already has staged content.');
      if (state.unmergedPaths.length > 0) throw new Error('Unmerged paths are present.');

      const changed = await this.changedPaths(worktreePath);
      if (changed.length === 0) throw new Error('There are no changes to hand off.');

      const byPath = new Map<string, ChangedPath[]>();
      for (const entry of changed) {
        const list = byPath.get(entry.path) ?? [];
        list.push(entry);
        byPath.set(entry.path, list);
      }
      const uniquePaths = [...byPath.keys()];
      if (uniquePaths.length > MAX_PATHS) throw new Error('Too many changed paths to safely hand off.');

      for (const relativePath of uniquePaths) {
        if (this.hasForbiddenSegment(relativePath)) throw new Error(`Path uses a forbidden .git segment: ${relativePath}`);
        if (relativePath.toLowerCase() === '.gitmodules') throw new Error('Changes to .gitmodules are not permitted.');
        if (!input.allowed(relativePath)) throw new Error(`Path is outside the approved scope: ${relativePath}`);
      }

      const lowerSeen = new Map<string, string>();
      for (const relativePath of uniquePaths) {
        const lower = relativePath.toLowerCase();
        const existing = lowerSeen.get(lower);
        if (existing && existing !== relativePath) throw new Error(`Paths differ only by case: ${existing} vs ${relativePath}`);
        lowerSeen.set(lower, relativePath);
      }

      const trackedPaths = await this.listTrackedPaths(worktreePath, input.expectedHead);
      const trackedLower = new Map<string, string>();
      for (const trackedPath of trackedPaths) trackedLower.set(trackedPath.toLowerCase(), trackedPath);
      for (const relativePath of uniquePaths) {
        const collision = trackedLower.get(relativePath.toLowerCase());
        if (collision && collision !== relativePath) {
          throw new Error(`Path collides with an existing tracked path by case only: ${collision} vs ${relativePath}`);
        }
      }

      const headModes = await this.lsTreeModes(worktreePath, input.expectedHead, uniquePaths);
      for (const relativePath of uniquePaths) {
        const headMode = headModes.get(relativePath);
        if (headMode && DANGEROUS_MODES.has(headMode)) throw new Error(`Path has a symlink or gitlink mode in HEAD: ${relativePath}`);
        for (const entry of byPath.get(relativePath) ?? []) {
          if (entry.indexMode && DANGEROUS_MODES.has(entry.indexMode)) throw new Error(`Path has a symlink or gitlink index mode: ${relativePath}`);
          if (entry.worktreeMode && DANGEROUS_MODES.has(entry.worktreeMode)) throw new Error(`Path has a symlink or gitlink worktree mode: ${relativePath}`);
        }
      }

      const committerIdent = await this.git(worktreePath, ['var', 'GIT_COMMITTER_IDENT'], { allowNonZero: true });
      if (committerIdent.exitCode !== 0 || !committerIdent.stdout.trim()) throw new Error('A committer identity is not available.');

      const sortedPaths = [...uniquePaths].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));

      const entries: PreparedHandoff['entries'] = [];
      const manifestEntries: EffectEntry[] = [];
      for (const relativePath of sortedPaths) {
        const records = byPath.get(relativePath) ?? [];
        const isDeleted = records.some((entry) => entry.kind === 'deleted');
        const headMode = headModes.get(relativePath) ?? '000000';
        let oldBlob = '0'.repeat(40);
        if (headMode !== '000000') {
          oldBlob = (await this.git(worktreePath, ['rev-parse', `${input.expectedHead}:${relativePath}`])).stdout.trim();
        }

        if (isDeleted) {
          entries.push({ path: relativePath, mode: null, blob: null });
          manifestEntries.push({ path: relativePath, status: 'D', oldMode: headMode, newMode: '000000', oldBlob, newBlob: '0'.repeat(40) });
          continue;
        }

        const worktreeModeCandidate = records.find((entry) => entry.worktreeMode && entry.worktreeMode !== '000000')?.worktreeMode;
        const newMode = worktreeModeCandidate ?? (headMode !== '000000' ? headMode : '100644');
        const newBlob = await this.hashObjectBlob(worktreePath, relativePath);
        entries.push({ path: relativePath, mode: newMode, blob: newBlob });
        const status: EffectEntry['status'] = headMode === '000000' ? 'A' : newMode !== headMode ? 'T' : 'M';
        manifestEntries.push({ path: relativePath, status, oldMode: headMode, newMode, oldBlob, newBlob });
      }

      const manifest: EffectManifest = { entries: manifestEntries, sha256: this.hashManifestEntries(manifestEntries) };
      const { patch, truncated: patchTruncated } = await this.renderHandoffPatch(worktreePath, input.expectedHead, entries, headModes);
      const git = await this.identity(worktreePath);

      const patchSha256 = createHash('sha256').update(patch, 'utf8').digest('hex');
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({
          worktreePath, branch: input.branch, expectedHead: input.expectedHead, paths: sortedPaths, entries, manifest, message: input.message, git, patchSha256,
        }), 'utf8')
        .digest('hex');

      return {
        worktreePath, branch: input.branch, expectedHead: input.expectedHead, paths: sortedPaths, entries, manifest, patch, patchTruncated, message: input.message, git, fingerprint,
      };
    });
  }

  public async commitHandoff(
    prepared: PreparedHandoff,
    hooks: { staged: (tree: string) => void; committed: (commit: string) => void },
  ): Promise<{ commit: string; tree: string }> {
    return this.guardedMutation(async (markMutation) => {
      const allowedSet = new Set(prepared.paths);
      const fresh = await this.prepareHandoff(prepared.worktreePath, {
        branch: prepared.branch,
        expectedHead: prepared.expectedHead,
        message: prepared.message,
        allowed: (candidatePath: string) => allowedSet.has(candidatePath),
      });
      if (fresh.fingerprint !== prepared.fingerprint) throw new Error('The approved handoff is stale.');

      // Mutation begins here: staging, tree/commit creation, and the ref update that follows
      // are recovery cases (outcome 'unknown') rather than plain rejections if anything fails.
      markMutation();

      for (let index = 0; index < prepared.paths.length; index += 200) {
        const batch = prepared.paths.slice(index, index + 200);
        await this.git(prepared.worktreePath, ['add', '--all', '--', ...batch], { mutating: true });
      }

      const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
      const stagedNames = (await this.git(prepared.worktreePath, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD']))
        .stdout.split('\0').filter(Boolean).sort(byteOrder);
      const expectedNames = [...prepared.paths].sort(byteOrder);
      if (stagedNames.length !== expectedNames.length || stagedNames.some((name, index) => name !== expectedNames[index])) {
        throw new Error('Staged paths do not match the approved path set.');
      }

      const lsOut = (await this.git(prepared.worktreePath, ['ls-files', '-s', '-z', '--', ...prepared.paths])).stdout;
      const staged = new Map<string, { mode: string; blob: string }>();
      for (const record of lsOut.split('\0')) {
        if (!record) continue;
        const tabIndex = record.indexOf('\t');
        if (tabIndex === -1) continue;
        const meta = record.slice(0, tabIndex).split(' ');
        const entryPath = record.slice(tabIndex + 1);
        const mode = meta[0];
        const blob = meta[1];
        if (mode && blob) staged.set(entryPath, { mode, blob });
      }
      for (const entry of prepared.entries) {
        const actual = staged.get(entry.path);
        if (entry.blob === null) {
          if (actual) throw new Error(`Expected ${entry.path} to be staged as a deletion.`);
        } else if (!actual || actual.mode !== entry.mode || actual.blob !== entry.blob) {
          throw new Error(`Staged content for ${entry.path} does not match the approved snapshot.`);
        }
      }

      const tree = (await this.git(prepared.worktreePath, ['write-tree'])).stdout.trim();
      hooks.staged(tree);

      const treeManifest = await this.manifest(prepared.worktreePath, prepared.expectedHead, tree);
      if (treeManifest.sha256 !== prepared.manifest.sha256) throw new Error('The staged tree does not match the approved effect manifest.');

      const commit = (await this.git(prepared.worktreePath, ['commit-tree', tree, '-p', prepared.expectedHead, '-m', prepared.message], { mutating: true })).stdout.trim();
      hooks.committed(commit);

      await this.git(prepared.worktreePath, ['update-ref', `refs/heads/${prepared.branch}`, commit, prepared.expectedHead], { mutating: true });

      const after = await this.state(prepared.worktreePath);
      if (after.head !== commit) throw new Error('HEAD does not reflect the new commit.');
      const info = await this.commitInfo(prepared.worktreePath, commit);
      if (info.parents.length !== 1 || info.parents[0] !== prepared.expectedHead) throw new Error('The new commit does not have the expected single parent.');
      if (!after.clean || after.operation !== 'none') throw new Error('The worktree is not clean after committing the handoff.');

      return { commit, tree };
    });
  }

  public async reconcileHandoff(
    worktreePath: string,
    input: { branch: string; expectedHead: string; manifest: EffectManifest },
  ): Promise<{ kind: 'complete'; commit: string; tree: string } | { kind: 'not-started' } | { kind: 'unknown'; detail: string }> {
    return this.guardedNone(async () => {
      const current = await this.state(worktreePath);
      if (current.branch !== input.branch) return { kind: 'unknown' as const, detail: 'Worktree is not on the expected branch.' };
      if (current.head === input.expectedHead) {
        return current.stagedClean ? { kind: 'not-started' as const } : { kind: 'unknown' as const, detail: 'The index has staged content without a resulting commit.' };
      }
      const info = await this.commitInfo(worktreePath, current.head);
      if (info.parents.length !== 1 || info.parents[0] !== input.expectedHead) {
        return { kind: 'unknown' as const, detail: 'The branch head does not have the expected single parent.' };
      }
      const effect = await this.manifest(worktreePath, input.expectedHead, current.head);
      if (effect.sha256 !== input.manifest.sha256) return { kind: 'unknown' as const, detail: 'The resulting effect does not match the approved manifest.' };
      if (!current.clean) return { kind: 'unknown' as const, detail: 'The worktree is not clean.' };
      return { kind: 'complete' as const, commit: current.head, tree: current.tree };
    });
  }

  // ---------------------------------------------------------------------
  // Coordinator integration: cherry-pick, conflict continuation, reconciliation
  // ---------------------------------------------------------------------

  public async prepareCherryPick(
    worktreePath: string,
    input: { branch: string; expectedHead: string; sha: string },
  ): Promise<{ head: string; tree: string; git: GitIdentity; sourceParent: string; sourceManifest: EffectManifest; patch: string; patchTruncated: boolean }> {
    return this.guardedNone(async () => {
      const state = await this.state(worktreePath);
      if (state.branch !== input.branch) throw new Error('Worktree is not on the expected branch.');
      if (state.head !== input.expectedHead) throw new Error('Worktree HEAD does not match the expected target.');
      if (state.operation !== 'none') throw new Error('A Git operation is already in progress.');
      if (!state.clean) throw new Error('The target worktree is not clean.');

      const info = await this.commitInfo(worktreePath, input.sha);
      if (info.parents.length !== 1) throw new Error('The source commit must have exactly one parent.');
      const sourceParent = info.parents[0];
      if (!sourceParent) throw new Error('The source commit has no resolvable parent.');
      const sourceManifest = await this.manifest(worktreePath, sourceParent, info.sha);

      const driverConfig = await this.git(worktreePath, ['config', '--get-regexp', '^merge\\..*\\.driver$'], { allowNonZero: true });
      if (driverConfig.exitCode === 0 && driverConfig.stdout.trim()) throw new Error('Repository configures a custom merge driver.');
      if (driverConfig.exitCode !== 0 && driverConfig.exitCode !== 1) throw new Error('Unable to inspect merge driver configuration.');

      const manifestPaths = sourceManifest.entries.map((entry) => entry.path);
      for (let index = 0; index < manifestPaths.length; index += 100) {
        const batch = manifestPaths.slice(index, index + 100);
        if (batch.length === 0) continue;
        const attrOut = (await this.git(worktreePath, ['check-attr', '-z', 'merge', '--', ...batch])).stdout;
        const tokens = attrOut.split('\0');
        for (let offset = 0; offset + 2 < tokens.length; offset += 3) {
          const attrPath = tokens[offset];
          const value = tokens[offset + 2];
          if (value !== undefined && !PERMITTED_MERGE_ATTRIBUTE_VALUES.has(value)) {
            throw new Error(`Path uses a non-builtin merge driver attribute: ${attrPath ?? '(unknown path)'}`);
          }
        }
      }

      for (const entry of sourceManifest.entries) {
        if (DANGEROUS_MODES.has(entry.oldMode) || DANGEROUS_MODES.has(entry.newMode)) {
          throw new Error(`Path has a symlink or gitlink mode: ${entry.path}`);
        }
      }

      const committerIdent = await this.git(worktreePath, ['var', 'GIT_COMMITTER_IDENT'], { allowNonZero: true });
      if (committerIdent.exitCode !== 0 || !committerIdent.stdout.trim()) throw new Error('A committer identity is not available.');

      const patchResult = await this.patch(worktreePath, sourceParent, info.sha);
      const git = await this.identity(worktreePath);

      return { head: state.head, tree: state.tree, git, sourceParent, sourceManifest, patch: patchResult.patch, patchTruncated: patchResult.truncated };
    });
  }

  public async cherryPick(
    worktreePath: string,
    input: { branch: string; expectedHead: string; expectedTree: string; sha: string; expectedManifest: EffectManifest },
  ): Promise<CherryPickOutcome> {
    return this.guardedMutation(async (markMutation) => {
      const pre = await this.prepareCherryPick(worktreePath, { branch: input.branch, expectedHead: input.expectedHead, sha: input.sha });
      if (pre.tree !== input.expectedTree || pre.sourceManifest.sha256 !== input.expectedManifest.sha256) {
        throw new Error('The approved cherry-pick is stale.');
      }

      markMutation();
      await this.git(worktreePath, ['cherry-pick', '--no-edit', '-x', input.sha], { mutating: true, allowNonZero: true });

      const after = await this.state(worktreePath);

      if (after.head !== input.expectedHead) {
        const info = await this.commitInfo(worktreePath, after.head);
        if (info.parents.length === 1 && info.parents[0] === input.expectedHead && after.clean && after.operation === 'none' && after.branch === input.branch) {
          const effect = await this.manifest(worktreePath, input.expectedHead, after.head);
          if (effect.sha256 === input.expectedManifest.sha256) return { kind: 'succeeded', commit: after.head, tree: after.tree };
        }
        return { kind: 'mismatch', commit: after.head, tree: after.tree, detail: 'Commit was created but does not match the approved effect.' };
      }

      if (after.operation === 'cherry-pick' && after.cherryPickHead) {
        if (after.unmergedPaths.length > 0) {
          const indexFingerprint = await this.indexFingerprint(worktreePath);
          return { kind: 'conflict', cherryPickHead: after.cherryPickHead, unmergedPaths: after.unmergedPaths, indexFingerprint };
        }
        return { kind: 'empty', cherryPickHead: after.cherryPickHead, detail: 'The cherry-pick produced no changes to commit.' };
      }

      if (after.clean && after.stagedClean) return { kind: 'no-effect', detail: 'HEAD, index, and worktree are unchanged; no operation is in progress.' };
      return { kind: 'unknown', detail: 'Unexpected repository state after the cherry-pick.' };
    });
  }

  public async prepareContinue(
    worktreePath: string,
    input: { branch: string; expectedHead: string; cherryPickHead: string },
  ): Promise<PreparedContinue> {
    return this.guardedNone(async () => {
      const state = await this.state(worktreePath);
      if (state.branch !== input.branch) throw new Error('Worktree is not on the expected branch.');
      if (state.head !== input.expectedHead) throw new Error('Worktree HEAD does not match the expected base.');
      if (state.operation !== 'cherry-pick' || state.cherryPickHead !== input.cherryPickHead) {
        throw new Error('No matching cherry-pick operation is in progress.');
      }
      if (state.unmergedPaths.length > 0) throw new Error('Unresolved conflicts remain.');

      const changed = await this.changedPaths(worktreePath);
      if (changed.some((entry) => entry.kind === 'untracked' || entry.staged === false)) {
        throw new Error('Unresolved, unstaged, or untracked changes remain in the worktree.');
      }

      const resolvedTree = (await this.git(worktreePath, ['write-tree'])).stdout.trim();
      if (resolvedTree === state.tree) throw new Error('The conflict resolution has no effect; nothing to continue.');

      const manifest = await this.manifest(worktreePath, input.expectedHead, resolvedTree);
      const patchResult = await this.patch(worktreePath, input.expectedHead, resolvedTree);
      const git = await this.identity(worktreePath);

      const patchSha256 = createHash('sha256').update(patchResult.patch, 'utf8').digest('hex');
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ branch: input.branch, expectedHead: input.expectedHead, cherryPickHead: input.cherryPickHead, resolvedTree, manifest, git, patchSha256 }), 'utf8')
        .digest('hex');

      return { resolvedTree, manifest, patch: patchResult.patch, patchTruncated: patchResult.truncated, git, fingerprint };
    });
  }

  public async continueCherryPick(
    worktreePath: string,
    input: { branch: string; expectedHead: string; cherryPickHead: string; prepared: PreparedContinue },
  ): Promise<Exclude<CherryPickOutcome, { kind: 'conflict' }>> {
    return this.guardedMutation(async (markMutation) => {
      const fresh = await this.prepareContinue(worktreePath, { branch: input.branch, expectedHead: input.expectedHead, cherryPickHead: input.cherryPickHead });
      if (fresh.fingerprint !== input.prepared.fingerprint) throw new Error('The approved continuation is stale.');

      markMutation();
      await this.git(worktreePath, ['cherry-pick', '--continue'], { mutating: true, allowNonZero: true });

      const after = await this.state(worktreePath);

      if (after.head !== input.expectedHead) {
        const info = await this.commitInfo(worktreePath, after.head);
        if (
          info.parents.length === 1 && info.parents[0] === input.expectedHead &&
          after.tree === input.prepared.resolvedTree && after.clean && after.operation === 'none' && after.branch === input.branch
        ) {
          return { kind: 'succeeded', commit: after.head, tree: after.tree };
        }
        return { kind: 'mismatch', commit: after.head, tree: after.tree, detail: 'Commit was created but does not match the approved resolution.' };
      }

      if (after.operation === 'cherry-pick') {
        if (after.unmergedPaths.length > 0) return { kind: 'unknown', detail: 'cherry-pick --continue left unresolved conflicts.' };
        return { kind: 'empty', cherryPickHead: after.cherryPickHead, detail: 'The continuation produced no changes to commit.' };
      }

      if (after.clean && after.stagedClean) return { kind: 'no-effect', detail: 'HEAD, index, and worktree are unchanged.' };
      return { kind: 'unknown', detail: 'Unexpected repository state after continuing the cherry-pick.' };
    });
  }

  public async reconcileIntegration(
    worktreePath: string,
    input: { branch: string; expectedHead: string; sha: string; expectedManifest: EffectManifest; resolvedTree?: string },
  ): Promise<CherryPickOutcome | { kind: 'not-started' }> {
    return this.guardedNone(async () => {
      const current = await this.state(worktreePath);
      if (current.branch !== input.branch) return { kind: 'unknown' as const, detail: 'Worktree is not on the expected branch.' };

      if (current.head === input.expectedHead) {
        if (current.operation === 'cherry-pick' && current.cherryPickHead) {
          if (current.unmergedPaths.length > 0) {
            const indexFingerprint = await this.indexFingerprint(worktreePath);
            return { kind: 'conflict' as const, cherryPickHead: current.cherryPickHead, unmergedPaths: current.unmergedPaths, indexFingerprint };
          }
          return { kind: 'empty' as const, cherryPickHead: current.cherryPickHead, detail: 'The cherry-pick produced no changes to commit.' };
        }
        if (current.clean && current.operation === 'none') return { kind: 'not-started' as const };
        return { kind: 'unknown' as const, detail: 'Unexpected repository state at the expected head.' };
      }

      const info = await this.commitInfo(worktreePath, current.head);
      if (info.parents.length === 1 && info.parents[0] === input.expectedHead) {
        const effect = await this.manifest(worktreePath, input.expectedHead, current.head);
        const treeMatches = input.resolvedTree === undefined || current.tree === input.resolvedTree;
        if (effect.sha256 === input.expectedManifest.sha256 && treeMatches && current.clean && current.operation === 'none') {
          return { kind: 'succeeded' as const, commit: current.head, tree: current.tree };
        }
        return { kind: 'mismatch' as const, commit: current.head, tree: current.tree, detail: 'The commit does not match the approved effect.' };
      }
      return { kind: 'mismatch' as const, commit: current.head, tree: current.tree, detail: 'Unexpected ancestry at the branch head.' };
    });
  }

  // ---------------------------------------------------------------------
  // Internal: status/diff-tree plumbing parsers
  // ---------------------------------------------------------------------

  private async statusRecords(worktreePath: string): Promise<RawStatusRecord[]> {
    const stdout = (await this.git(worktreePath, ['-c', 'status.renames=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all'])).stdout;
    return this.parseStatusV2(stdout);
  }

  private parseStatusV2(stdout: string): RawStatusRecord[] {
    const tokens = stdout.split('\0');
    if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
    const records: RawStatusRecord[] = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if (!token) { index += 1; continue; }
      const type = token.charAt(0);
      if (type === '1') {
        const fields = this.splitFixed(token, 9);
        records.push({ kind: '1', xy: fields[1] ?? '', mH: fields[3] ?? '', mI: fields[4] ?? '', mW: fields[5] ?? '', path: fields[8] ?? '' });
        index += 1;
      } else if (type === '2') {
        const fields = this.splitFixed(token, 10);
        const origPath = tokens[index + 1] ?? '';
        records.push({ kind: '2', xy: fields[1] ?? '', mH: fields[3] ?? '', mI: fields[4] ?? '', mW: fields[5] ?? '', path: fields[9] ?? '', origPath });
        index += 2;
      } else if (type === 'u') {
        const fields = this.splitFixed(token, 11);
        records.push({ kind: 'u', xy: fields[1] ?? '', m1: fields[3] ?? '', m2: fields[4] ?? '', m3: fields[5] ?? '', mW: fields[6] ?? '', path: fields[10] ?? '' });
        index += 1;
      } else if (type === '?') {
        const fields = this.splitFixed(token, 2);
        records.push({ kind: '?', path: fields[1] ?? '' });
        index += 1;
      } else if (type === '!') {
        index += 1;
      } else {
        throw new Error(`Unexpected git status record: ${token}`);
      }
    }
    return records;
  }

  private splitFixed(line: string, fieldCount: number): string[] {
    const parts: string[] = [];
    let rest = line;
    for (let i = 0; i < fieldCount - 1; i++) {
      const spaceIndex = rest.indexOf(' ');
      if (spaceIndex === -1) throw new Error('Malformed git status record.');
      parts.push(rest.slice(0, spaceIndex));
      rest = rest.slice(spaceIndex + 1);
    }
    parts.push(rest);
    return parts;
  }

  private classifyStatusCode(code: string): ChangedPath['kind'] {
    if (code === 'A') return 'added';
    if (code === 'D') return 'deleted';
    if (code === 'T') return 'typechange';
    return 'modified';
  }

  private async detectOperation(worktreePath: string): Promise<{ kind: GitOperationKind; cherryPickHead: string | null }> {
    const cherryPickHeadFile = await this.gitPathIfExists(worktreePath, 'CHERRY_PICK_HEAD');
    if (cherryPickHeadFile) {
      const content = (await fs.readFile(cherryPickHeadFile, 'utf8')).trim();
      return { kind: 'cherry-pick', cherryPickHead: content || null };
    }
    if (await this.gitPathIfExists(worktreePath, 'sequencer')) return { kind: 'sequencer', cherryPickHead: null };
    if (await this.gitPathIfExists(worktreePath, 'MERGE_HEAD')) return { kind: 'merge', cherryPickHead: null };
    if (await this.gitPathIfExists(worktreePath, 'rebase-merge')) return { kind: 'rebase', cherryPickHead: null };
    if (await this.gitPathIfExists(worktreePath, 'rebase-apply')) {
      const rebasing = await this.gitPathIfExists(worktreePath, 'rebase-apply/rebasing');
      return { kind: rebasing ? 'rebase' : 'am', cherryPickHead: null };
    }
    if (await this.gitPathIfExists(worktreePath, 'REVERT_HEAD')) return { kind: 'revert', cherryPickHead: null };
    if (await this.gitPathIfExists(worktreePath, 'BISECT_LOG')) return { kind: 'bisect', cherryPickHead: null };
    return { kind: 'none', cherryPickHead: null };
  }

  private async gitPathIfExists(worktreePath: string, relative: string): Promise<string | null> {
    const resolved = (await this.git(worktreePath, ['rev-parse', '--git-path', relative])).stdout.trim();
    const absolute = path.isAbsolute(resolved) ? resolved : path.join(worktreePath, resolved);
    try {
      await fs.access(absolute);
      return absolute;
    } catch {
      return null;
    }
  }

  private parseDiffTreeRaw(stdout: string): EffectEntry[] {
    const tokens = stdout.split('\0');
    if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
    const entries: EffectEntry[] = [];
    for (let i = 0; i < tokens.length; i += 2) {
      const meta = tokens[i];
      const filePath = tokens[i + 1];
      if (!meta || !meta.startsWith(':') || filePath === undefined) throw new Error('Malformed diff-tree output.');
      const fields = meta.slice(1).split(' ');
      const [oldMode, newMode, oldBlob, newBlob, status] = fields;
      if (!oldMode || !newMode || !oldBlob || !newBlob || !status) throw new Error('Malformed diff-tree metadata.');
      if (status !== 'A' && status !== 'M' && status !== 'D' && status !== 'T') throw new Error(`Unsupported diff-tree status: ${status}`);
      entries.push({ path: filePath, status, oldMode, newMode, oldBlob, newBlob });
    }
    return entries;
  }

  private sortByPathBytes<T extends { path: string }>(items: T[]): T[] {
    return [...items].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  }

  private hashManifestEntries(entries: EffectEntry[]): string {
    return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
  }

  private async indexFingerprint(worktreePath: string): Promise<string> {
    const out = (await this.git(worktreePath, ['ls-files', '-s', '-z'])).stdout;
    return createHash('sha256').update(out, 'utf8').digest('hex');
  }

  private async lsTreeModes(worktreePath: string, ref: string, paths: string[]): Promise<Map<string, string>> {
    const modes = new Map<string, string>();
    for (let index = 0; index < paths.length; index += 100) {
      const batch = paths.slice(index, index + 100);
      if (batch.length === 0) continue;
      const out = (await this.git(worktreePath, ['ls-tree', '-z', ref, '--', ...batch])).stdout;
      for (const record of out.split('\0')) {
        if (!record) continue;
        const tabIndex = record.indexOf('\t');
        if (tabIndex === -1) continue;
        const meta = record.slice(0, tabIndex);
        const entryPath = record.slice(tabIndex + 1);
        const mode = meta.split(' ')[0];
        if (mode) modes.set(entryPath, mode);
      }
    }
    return modes;
  }

  private async listTrackedPaths(worktreePath: string, ref: string): Promise<string[]> {
    const out = (await this.git(worktreePath, ['ls-tree', '-r', '-z', '--name-only', ref])).stdout;
    return out.split('\0').filter(Boolean);
  }

  private async hashObjectBlob(worktreePath: string, relativePath: string): Promise<string> {
    const out = (await this.git(worktreePath, ['hash-object', '--no-filters', '--', relativePath])).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(out)) throw new Error('Unexpected hash-object output.');
    return out;
  }

  private hasForbiddenSegment(relativePath: string): boolean {
    return relativePath.split('/').some((segment) => segment.toLowerCase() === '.git');
  }

  private validateMessage(message: string): void {
    if (typeof message !== 'string' || message.length === 0) throw new Error('Commit message must not be empty.');
    if (message.includes('\0')) throw new Error('Commit message must not contain NUL.');
    if (Buffer.byteLength(message, 'utf8') > 4096) throw new Error('Commit message exceeds 4096 bytes.');
  }

  private async renderHandoffPatch(
    worktreePath: string,
    expectedHead: string,
    entries: PreparedHandoff['entries'],
    headModes: Map<string, string>,
  ): Promise<{ patch: string; truncated: boolean }> {
    const emptyFile = await this.prepareEmptyDiffSource();
    const parts: string[] = [];
    for (const entry of entries) {
      if (entry.blob === null || headModes.has(entry.path)) {
        const result = await this.git(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', expectedHead, '--', entry.path], { permitTruncation: true });
        parts.push(result.stdout);
      } else {
        const full = path.join(worktreePath, entry.path);
        const result = await this.git(worktreePath, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--', emptyFile, full], { allowNonZero: true, permitTruncation: true });
        parts.push(result.stdout);
      }
    }
    return this.boundConcat(parts);
  }

  private boundConcat(parts: string[]): { patch: string; truncated: boolean } {
    let out = '';
    let truncated = false;
    for (const part of parts) {
      const candidate = out + part;
      if (Buffer.byteLength(candidate, 'utf8') > PATCH_LIMIT_BYTES) { truncated = true; break; }
      out = candidate;
    }
    return { patch: out, truncated };
  }

  // ---------------------------------------------------------------------
  // Internal: repository/path safety, mirrored from RepositoryService
  // ---------------------------------------------------------------------

  private requireChildId(childTaskId: string): string {
    if (!CHILD_UUID_PATTERN.test(childTaskId)) throw new Error('Child task id must be a UUID.');
    return childTaskId.toLowerCase();
  }

  private async requireRoot(candidate: string): Promise<string> {
    if (!candidate || !path.isAbsolute(candidate)) throw new Error('Path must be an absolute path.');
    const root = await fs.realpath(candidate);
    const stat = await fs.stat(root);
    if (!stat.isDirectory() || path.basename(root).toLowerCase() === '.git') throw new Error('Path must be a working directory.');
    return root;
  }

  private async requireRepository(candidate: string): Promise<string> {
    const root = await this.requireRoot(candidate);
    await this.assertGitOutside(root);
    await this.rejectCoreWorktree(root);
    const inside = (await this.git(root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim();
    const bare = (await this.git(root, ['rev-parse', '--is-bare-repository'])).stdout.trim();
    if (inside !== 'true' || bare !== 'false') throw new Error('Path must be a non-bare Git working tree.');
    return root;
  }

  private async rejectTrackedFilters(repositoryRoot: string): Promise<void> {
    const tracked = (await this.git(repositoryRoot, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
    if (tracked.length > MAX_PATHS) throw new Error('Repository has too many tracked paths to safely inspect filters.');
    for (let index = 0; index < tracked.length; index += 100) {
      const batch = tracked.slice(index, index + 100);
      const values = (await this.git(repositoryRoot, ['check-attr', '-z', 'filter', '--', ...batch])).stdout.split('\0');
      if (values.some((value, position) => position % 3 === 2 && value && value !== 'unspecified')) {
        throw new Error('Repository uses Git filters; refusing checkout because filters may execute code.');
      }
    }
  }

  private async rejectCoreWorktree(repositoryRoot: string): Promise<void> {
    const result = await this.git(repositoryRoot, ['config', '--null', '--get-all', 'core.worktree'], { allowNonZero: true });
    if (result.exitCode === 1) return;
    if (result.exitCode !== 0) throw new Error('Unable to inspect Git core.worktree configuration.');
    if (result.stdout.length > 0) throw new Error('Repository configures core.worktree; refusing to materialize files outside the app-owned worktree.');
  }

  private isInside(root: string, candidate: string): boolean {
    const normalize = (value: string) => {
      const resolved = path.resolve(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const relative = path.relative(normalize(root), normalize(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }

  private async assertGitOutside(repositoryRoot: string): Promise<void> {
    const executable = await this.getGitExecutable(repositoryRoot);
    if (this.isInside(repositoryRoot, executable)) throw new Error('Git executable resolves inside the selected repository.');
  }

  private async getGitExecutable(excludedRoot: string): Promise<string> {
    this.gitExecutable ??= this.resolveGitExecutable(excludedRoot);
    const executable = await this.gitExecutable;
    if (this.isInside(excludedRoot, executable)) throw new Error('Git executable resolves inside the selected repository.');
    return executable;
  }

  private async resolveGitExecutable(excludedRoot: string): Promise<string> {
    const pathValue = process.env.PATH ?? process.env.Path ?? '';
    const candidates = pathValue.split(path.delimiter)
      .map((entry) => entry.trim().replace(/^"|"$/g, ''))
      .filter((entry) => path.isAbsolute(entry))
      .map((entry) => path.join(entry, process.platform === 'win32' ? 'git.exe' : 'git'));
    for (const candidate of candidates) {
      try {
        const resolved = await fs.realpath(candidate);
        if (this.isInside(excludedRoot, resolved)) continue;
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) continue;
        if (process.platform !== 'win32') await fs.access(resolved, fsConstants.X_OK);
        return resolved;
      } catch {
        // Continue through the caller's absolute PATH entries; no repository executable is invoked.
      }
    }
    throw new Error('A Git executable was not found in an absolute PATH entry outside the selected repository.');
  }

  private async hooksDirectory(): Promise<string> {
    this.hooksDirectoryPromise ??= (async () => {
      const base = path.resolve(this.worktreeBase);
      await fs.mkdir(base, { recursive: true });
      const resolved = await fs.realpath(base);
      const hooks = path.join(resolved, EMPTY_HOOKS_DIRECTORY);
      await fs.mkdir(hooks, { recursive: true });
      return hooks;
    })();
    return this.hooksDirectoryPromise;
  }

  private async prepareChildrenBase(): Promise<string> {
    await this.hooksDirectory();
    const base = path.resolve(this.worktreeBase);
    const children = path.join(base, CHILDREN_DIRECTORY);
    await fs.mkdir(children, { recursive: true });
    return fs.realpath(children);
  }

  private async prepareEmptyDiffSource(): Promise<string> {
    this.emptyDiffSourcePromise ??= (async () => {
      const base = path.resolve(this.worktreeBase);
      await fs.mkdir(base, { recursive: true });
      const resolved = await fs.realpath(base);
      const file = path.join(resolved, EMPTY_DIFF_SOURCE_NAME);
      try {
        await fs.access(file);
      } catch {
        await fs.writeFile(file, '');
      }
      return file;
    })();
    return this.emptyDiffSourcePromise;
  }

  // ---------------------------------------------------------------------
  // Internal: error-outcome guards
  // ---------------------------------------------------------------------

  private async guardedNone<T>(execute: () => Promise<T>): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      if (error instanceof GitOperationError) throw error;
      const detail = error instanceof Error ? error.message : 'Git operation failed.';
      throw new GitOperationError(detail, 'none', { cause: error });
    }
  }

  private async guardedMutation<T>(execute: (markMutation: () => void) => Promise<T>): Promise<T> {
    let mutationStarted = false;
    try {
      return await execute(() => { mutationStarted = true; });
    } catch (error) {
      if (error instanceof GitOperationError) throw error;
      const detail = error instanceof Error ? error.message : 'Git operation failed.';
      throw new GitOperationError(detail, mutationStarted ? 'unknown' : 'none', { cause: error });
    }
  }

  // ---------------------------------------------------------------------
  // Internal: Git process execution
  // ---------------------------------------------------------------------

  private async git(cwd: string, args: string[], options: GitCallOptions = {}): Promise<GitOutput> {
    const hooksPath = await this.hooksDirectory();
    const baseConfig = ['-c', `core.hooksPath=${hooksPath}`, '-c', 'core.fsmonitor=', '-c', 'credential.helper='];
    const mutatingConfig = [
      '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
      '-c', 'rerere.enabled=false', '-c', 'rerere.autoUpdate=false',
      '-c', 'core.editor=:', '-c', 'sequence.editor=:',
      '-c', 'protocol.allow=never', '-c', 'merge.renames=false',
    ];
    const config = options.mutating ? [...baseConfig, ...mutatingConfig] : baseConfig;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...(options.mutating ? { GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':', GIT_NO_LAZY_FETCH: '1', GIT_MERGE_AUTOEDIT: 'no' } : {}),
    };
    try {
      const executable = await this.getGitExecutable(cwd);
      const result = await execFile(executable, ['--literal-pathspecs', '--no-pager', ...config, ...args], {
        cwd,
        env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      return { stdout: result.stdout, truncated: false, exitCode: 0 };
    } catch (error: unknown) {
      const value = error as { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      if (options.permitTruncation && value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { stdout: String(value.stdout ?? '').slice(0, GIT_MAX_OUTPUT_BYTES), truncated: true, exitCode: 0 };
      }
      if (options.allowNonZero && typeof value.code === 'number') {
        return { stdout: String(value.stdout ?? ''), truncated: false, exitCode: value.code };
      }
      const detail = String(value.stderr ?? value.message ?? 'Git command failed.').trim();
      throw new Error(`Git command failed: ${detail.slice(0, 500)}`, { cause: error });
    }
  }
}

export function createGitOperations(worktreeBase: string): GitOperations {
  return new GitOperations(worktreeBase);
}

// randomUUID is exposed for callers that mint child task ids before creating a worktree.
export { randomUUID as randomChildTaskId };
