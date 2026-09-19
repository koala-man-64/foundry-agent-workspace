import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { gitEnvironment } from './git-environment';
import { promisify } from 'node:util';
import type { DiffResult, FileContent, FileEntry } from '../../protocol/src/index';

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PATHS = 5_000;
const EMPTY_HOOKS_DIRECTORY = '.empty-git-hooks';
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.terraformrc|\.(?:ssh|aws|azure|kube|docker|gnupg)|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

type GitOutput = { stdout: string; truncated: boolean; exitCode: number };
export interface PreparedEdit {
  root: string; path: string; before: string; after: string; expectedHash: string | null; resultingHash: string; fingerprint: string;
}

/** Distinguishes a preflight rejection from a Git operation whose effects need reconciliation. */
export class RepositoryError extends Error {
  public readonly mutationStarted: boolean;

  public constructor(
    message: string,
    public readonly outcome: 'none' | 'unknown',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RepositoryError';
    this.mutationStarted = outcome === 'unknown';
  }
}

/** Local, read-only repository access plus isolated task-worktree creation. */
export class RepositoryService {
  private gitExecutable: Promise<string> | undefined;
  /** Concurrent `worktree add` calls in one repository race on Git's worktree metadata; creation is serialized per repository. */
  private readonly creating = new Map<string, Promise<unknown>>();

  public constructor(private readonly worktreeBase: string) {}

  public get worktreeBaseDirectory(): string {
    return this.worktreeBase;
  }

  public async createTaskWorktree(
    projectPath: string,
    taskId: string,
  ): Promise<{ worktreePath: string; branch: string; baseCommit: string }> {
    const key = process.platform === 'win32' ? path.resolve(projectPath).toLowerCase() : path.resolve(projectPath);
    const previous = this.creating.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.createTaskWorktreeSerialized(projectPath, taskId));
    this.creating.set(key, operation);
    try { return await operation; } finally { if (this.creating.get(key) === operation) this.creating.delete(key); }
  }

  private async createTaskWorktreeSerialized(
    projectPath: string,
    taskId: string,
  ): Promise<{ worktreePath: string; branch: string; baseCommit: string }> {
    let mutationStarted = false;

    try {
      const projectRoot = await this.requireRepository(projectPath);
      const baseCommit = (await this.git(projectRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
      if (!baseCommit) throw new Error('Repository does not have a valid HEAD commit.');
      await this.rejectTrackedFilters(projectRoot);
      const id = this.requireTaskId(taskId);
      const branch = `codex/task/${id}`;
      const base = await this.prepareWorktreeBase();
      const worktreePath = path.join(base, id);
      // A timeout or process failure can occur after Git has created refs or worktree metadata.
      mutationStarted = true;
      await this.git(projectRoot, ['worktree', 'add', '--no-checkout', '-b', branch, worktreePath, baseCommit]);
      // Checkout may run filters, so it follows the tracked-filter check above and disables hooks.
      await this.git(worktreePath, ['checkout', '--no-recurse-submodules', branch]);
      return { worktreePath, branch, baseCommit };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      const detail = error instanceof Error ? error.message : 'Repository operation failed.';
      throw new RepositoryError(detail, mutationStarted ? 'unknown' : 'none', { cause: error });
    }
  }

  /** Tracked modifications plus untracked files (ignored files excluded), as Git reports them. Read-only. */
  public async uncommittedPaths(root: string): Promise<string[]> {
    const repositoryRoot = await this.requireRepository(root);
    const output = (await this.git(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout;
    const paths: string[] = [];
    const fields = output.split('\0');
    for (let index = 0; index < fields.length; index++) {
      const entry = fields[index];
      if (!entry) continue;
      const code = entry.slice(0, 2); const changedPath = entry.slice(3);
      paths.push(changedPath);
      if (code.startsWith('R') || code.startsWith('C')) index++;
    }
    return paths;
  }

  /**
   * Explicit user commit of every change in the task worktree. Secret-named paths are never staged;
   * hooks stay disabled; the commit identity comes from the user's Git configuration and is never invented.
   */
  public async commitAll(root: string, expectedBranch: string, message: string): Promise<{ commit: string; changedPaths: string[] }> {
    const repositoryRoot = await this.requireRepository(root);
    const branch = (await this.git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (branch !== expectedBranch) throw new RepositoryError(`The worktree is on ${branch}, not the task branch ${expectedBranch}.`, 'none');
    const dirty = await this.uncommittedPaths(repositoryRoot);
    if (!dirty.length) throw new RepositoryError('There are no changes to commit.', 'none');
    const denied = dirty.filter(entry => this.isDeniedRelativePath(entry));
    if (denied.length) throw new RepositoryError(`Refusing to commit secret-named paths: ${denied.slice(0, 5).join(', ')}. Remove or ignore them first.`, 'none');
    // `git add` runs clean filters. Attributes may have changed since the worktree was created (a .gitattributes edit is an
    // ordinary reviewed file change), so every tracked path and every path about to be staged is re-checked here.
    try {
      await this.rejectTrackedFilters(repositoryRoot);
      await this.rejectFilters(repositoryRoot, dirty);
    } catch (error) { throw new RepositoryError(error instanceof Error ? error.message : 'Filter check failed.', 'none', { cause: error }); }
    let mutationStarted = false;
    try {
      mutationStarted = true;
      await this.git(repositoryRoot, ['add', '--all', '--', '.']);
      const staged = (await this.git(repositoryRoot, ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean);
      if (!staged.length) { await this.git(repositoryRoot, ['reset', '-q']); throw new Error('Nothing was staged.'); }
      if (staged.some(entry => this.isDeniedRelativePath(entry))) { await this.git(repositoryRoot, ['reset', '-q']); throw new Error('A secret-named path was staged; the index was reset and nothing was committed.'); }
      await this.git(repositoryRoot, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', message]);
      const commit = (await this.git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
      return { commit, changedPaths: staged };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(error instanceof Error ? error.message : 'Commit failed.', mutationStarted ? 'unknown' : 'none', { cause: error });
    }
  }

  /** Explicit user push of the task branch. Never forces, never prompts; the user's credential helper may run for this action only. */
  public async push(root: string, projectPath: string, remote: string, branch: string): Promise<string> {
    const repositoryRoot = await this.requireRepository(root);
    const projectRoot = await this.requireRepository(projectPath);
    const url = await this.git(projectRoot, ['remote', 'get-url', '--', remote], false, true);
    if (url.exitCode !== 0 || !url.stdout.trim()) throw new RepositoryError(`Remote ${remote} is not configured in the project repository.`, 'none');
    const current = (await this.git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (current !== branch) throw new RepositoryError(`The worktree is on ${current}, not the task branch ${branch}.`, 'none');
    try {
      const result = await this.git(repositoryRoot, ['push', '--no-verify', '--porcelain', '--', remote, `refs/heads/${branch}:refs/heads/${branch}`], false, false, { timeoutMs: 120_000, allowCredentialHelper: true });
      return result.stdout.trim();
    } catch (error) {
      throw new RepositoryError(error instanceof Error ? error.message : 'Push failed.', 'unknown', { cause: error });
    }
  }

  /** `git worktree remove` without --force: Git itself refuses when untracked or modified files exist. The branch is kept. */
  public async removeWorktree(projectPath: string, worktreePath: string): Promise<void> {
    const projectRoot = await this.requireRepository(projectPath);
    const base = await fs.realpath(path.resolve(this.worktreeBase));
    const target = await fs.realpath(worktreePath);
    if (!this.isInside(base, target) || this.isInside(target, base)) throw new RepositoryError('Only app-owned task worktrees can be retired.', 'none');
    try {
      await this.git(projectRoot, ['worktree', 'remove', '--', target]);
    } catch (error) {
      const stillThere = await fs.stat(target).then(() => true).catch(() => false);
      throw new RepositoryError(error instanceof Error ? error.message : 'Worktree removal failed.', stillThere ? 'none' : 'unknown', { cause: error });
    }
  }

  public async listFiles(root: string, relativePath = ''): Promise<FileEntry[]> {
    const safeRoot = await this.requireRoot(root);
    const target = await this.resolveSafePath(safeRoot, relativePath, true);
    const entries: FileEntry[] = [];
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      if (this.isDeniedName(entry.name) || entry.isSymbolicLink()) continue;
      const candidate = path.join(target, entry.name);
      const relative = path.relative(safeRoot, candidate).split(path.sep).join('/');
      if (!relative || this.isDeniedRelativePath(relative)) continue;
      if (entry.isDirectory()) entries.push({ path: relative, kind: 'directory' });
      else if (entry.isFile()) entries.push({ path: relative, kind: 'file' });
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  public async readFile(root: string, relativePath: string): Promise<FileContent> {
    const safeRoot = await this.requireRoot(root);
    const target = await this.resolveSafePath(safeRoot, relativePath, false);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('Requested path is not a regular file.');
    if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES} byte read limit.`);
    const bytes = await fs.readFile(target);
    if (bytes.includes(0)) throw new Error('Binary files cannot be read.');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Binary files cannot be read.');
    }
    return {
      path: this.toPortableRelativePath(safeRoot, target),
      content,
      hash: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  public async prepareEdit(root: string, relativePath: string, expectedHash: string | null, after: string): Promise<PreparedEdit> {
    if (Buffer.byteLength(after, 'utf8') > MAX_FILE_BYTES || after.includes('\0')) throw new Error('Edits must be UTF-8 text of at most 64 KB.');
    if (expectedHash === null) throw new Error('Creating new files is unavailable until a race-safe Windows directory creation primitive is available.');
    const safeRoot = await this.requireRoot(root);
    this.validateRelativePath(relativePath, false);
    // Parents must exist already. Directory creation is a separately approved command.
    const parent = path.dirname(relativePath).replaceAll('\\', '/');
    await this.resolveSafePath(safeRoot, parent === '.' ? '' : parent, true);
    const target = path.resolve(safeRoot, relativePath);
    const current = await this.readFile(safeRoot, relativePath);
    if (current.hash !== expectedHash) throw new Error('Stale edit: file content changed since it was read.');
    const stat = await fs.stat(await this.resolveSafePath(safeRoot, relativePath, false));
    if (stat.nlink !== 1) throw new Error('Hard-linked files cannot be edited.');
    const before = current.content;
    const normalized = this.toPortableRelativePath(safeRoot, target);
    const resultingHash = createHash('sha256').update(after, 'utf8').digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([safeRoot, normalized, expectedHash, resultingHash])).digest('hex');
    return { root: safeRoot, path: normalized, before, after, expectedHash, resultingHash, fingerprint };
  }

  public async applyEdit(edit: PreparedEdit): Promise<{ path: string; hash: string }> {
    let fresh: PreparedEdit;
    try {
      fresh = await this.prepareEdit(edit.root, edit.path, edit.expectedHash, edit.after);
      if (fresh.fingerprint !== edit.fingerprint) throw new Error('Edit approval is stale.');
    } catch (error) { throw new RepositoryError(error instanceof Error ? error.message : 'Edit preflight failed.', 'none'); }
    const target = path.resolve(fresh.root, fresh.path);
    // Creation is unavailable, so opening the existing file itself cannot mutate it.
    const handle = await fs.open(target, 'r+').catch((error: unknown) => { throw new RepositoryError(error instanceof Error ? error.message : 'Cannot open file for editing.', 'none'); });
    let mutationStarted = false;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) throw new Error('Only unlinked regular files can be edited.');
      if (fresh.expectedHash !== null) {
        const current = await handle.readFile();
        if (createHash('sha256').update(current).digest('hex') !== fresh.expectedHash) throw new Error('Stale edit: file changed before execution.');
      }
      // Re-check canonical identity immediately before mutation. The host filesystem
      // is not a sandbox; external processes with this user's rights can still race.
      const resolved = await this.resolveSafePath(fresh.root, fresh.path, false);
      const named = await fs.stat(resolved);
      if (named.dev !== opened.dev || named.ino !== opened.ino) throw new Error('File identity changed before execution.');
      const bytes = Buffer.from(fresh.after, 'utf8');
      mutationStarted = true;
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesWritten) throw new Error('File write made no progress.');
        offset += result.bytesWritten;
      }
      await handle.truncate(bytes.length); await handle.sync();
    } catch (error) {
      if (!mutationStarted) throw new RepositoryError(error instanceof Error ? error.message : 'Edit preflight failed.', 'none');
      throw error;
    } finally { await handle.close(); }
    const result = await this.readFile(fresh.root, fresh.path);
    if (result.hash !== fresh.resultingHash) throw new Error('File verification failed; inspect the retained operation.');
    return { path: result.path, hash: result.hash };
  }

  public async search(root: string, query: string, start = ''): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean; skipped: number }> {
    const pending = [start]; const matches: { path: string; line: number; text: string }[] = [];
    let visited = 0; let skipped = 0; let truncated = false;
    while (pending.length) {
      const current = pending.pop()!;
      if (++visited > 2000) { truncated = true; break; }
      for (const entry of await this.listFiles(root, current)) {
        if (++visited > 2000) return { matches, truncated: true, skipped };
        if (entry.kind === 'directory') {
          if (!['node_modules', 'dist', 'out', 'coverage', '.venv'].includes(path.basename(entry.path))) pending.push(entry.path);
          else skipped++;
          continue;
        }
        try {
          const file = await this.readFile(root, entry.path);
          for (const [index, text] of file.content.split(/\r?\n/).entries()) {
            if (text.includes(query)) matches.push({ path: file.path, line: index + 1, text: text.slice(0, 500) });
            if (matches.length >= 100) return { matches, truncated: true, skipped };
          }
        } catch { skipped++; }
      }
    }
    return { matches, truncated, skipped };
  }

  public async diff(root: string): Promise<DiffResult> {
    const repositoryRoot = await this.requireRepository(root);
    const safePaths = await this.safeDiffPaths(repositoryRoot);
    const summary = safePaths.length ? await this.git(repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--stat', 'HEAD', '--', ...safePaths]) : { stdout: '' };
    const patch = safePaths.length ? await this.git(repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--binary', 'HEAD', '--', ...safePaths], true) : { stdout: '', truncated: false };
    const omitUntracked = await this.hasSensitiveTrackedDeletion(repositoryRoot);
    const untracked = omitUntracked ? [] : (await this.git(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
    let truncated = patch.truncated; let output = patch.stdout; let stat = summary.stdout;
    for (const name of untracked.slice(0, 100)) {
      if (this.isDeniedRelativePath(name)) continue;
      try {
        const file = await this.readFile(repositoryRoot, name);
        const addition = `diff --git a/${file.path} b/${file.path}\nnew file\n--- /dev/null\n+++ b/${file.path}\n${file.content.split('\n').map(line => '+' + line).join('\n')}\n`;
        if (Buffer.byteLength(output + addition) > GIT_MAX_OUTPUT_BYTES) { truncated = true; break; }
        output += addition; stat += `${file.path} | new file\n`;
      } catch { /* Unsupported/denied untracked content remains unavailable. */ }
    }
    if (omitUntracked) stat += 'Untracked content omitted because a sensitive tracked deletion is present.\n';
    return { summary: stat, patch: output, truncated: truncated || untracked.length > 100 || omitUntracked };
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

  private async requireRoot(candidate: string): Promise<string> {
    if (!candidate || !path.isAbsolute(candidate)) throw new Error('Repository root must be an absolute path.');
    const root = await fs.realpath(candidate);
    const stat = await fs.stat(root);
    if (!stat.isDirectory() || path.basename(root).toLowerCase() === '.git') throw new Error('Root must be a working directory.');
    return root;
  }

  private async resolveSafePath(root: string, relativePath: string, allowDirectory: boolean): Promise<string> {
    this.validateRelativePath(relativePath, allowDirectory);
    const candidate = path.resolve(root, relativePath || '.');
    if (!this.isInside(root, candidate)) throw new Error('Path escapes the repository root.');
    const before = await fs.lstat(candidate);
    if (before.isSymbolicLink()) throw new Error('Symbolic links cannot be accessed.');
    const resolved = await fs.realpath(candidate);
    if (!this.isInside(root, resolved)) throw new Error('Path escapes the repository root.');
    if (this.isDeniedRelativePath(this.toPortableRelativePath(root, resolved))) throw new Error('Path is not available.');
    return resolved;
  }

  private validateRelativePath(relativePath: string, allowEmpty: boolean): void {
    if (typeof relativePath !== 'string' || (!allowEmpty && !relativePath)) throw new Error('A relative path is required.');
    if (!relativePath && allowEmpty) return;
    if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) throw new Error('Absolute paths are not allowed.');
    const segments = relativePath.replaceAll('\\', '/').split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..' || this.isDeniedName(segment))) {
      throw new Error('Path contains a forbidden segment.');
    }
  }

  private isDeniedName(name: string): boolean {
    return name.toLowerCase() === '.git' || name.includes(':') || /[. ]$/.test(name) || RESERVED_WINDOWS_NAME.test(name) || SECRET_NAME.test(name);
  }

  private isDeniedRelativePath(relativePath: string): boolean {
    return relativePath.replaceAll('\\', '/').split('/').some((segment) => this.isDeniedName(segment));
  }

  private isInside(root: string, candidate: string): boolean {
    const normalize = (value: string) => {
      const resolved = path.resolve(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const relative = path.relative(normalize(root), normalize(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }

  private toPortableRelativePath(root: string, target: string): string {
    return path.relative(root, target).split(path.sep).join('/');
  }

  private requireTaskId(taskId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
      throw new Error('Task id must be a UUID.');
    }
    return taskId.toLowerCase();
  }

  private async prepareWorktreeBase(): Promise<string> {
    const base = path.resolve(this.worktreeBase);
    await fs.mkdir(base, { recursive: true });
    const resolved = await fs.realpath(base);
    await fs.mkdir(path.join(resolved, EMPTY_HOOKS_DIRECTORY), { recursive: true });
    return resolved;
  }

  private async rejectTrackedFilters(repositoryRoot: string): Promise<void> {
    const tracked = (await this.git(repositoryRoot, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
    if (tracked.length > MAX_PATHS) throw new Error('Repository has too many tracked paths to safely inspect filters.');
    await this.rejectFilters(repositoryRoot, tracked);
  }

  /** Reject any path with a `filter` attribute: clean/smudge filters run arbitrary commands during add and checkout. */
  private async rejectFilters(repositoryRoot: string, candidates: string[]): Promise<void> {
    if (candidates.length > MAX_PATHS) throw new Error('Too many paths to safely inspect filters.');
    for (let index = 0; index < candidates.length; index += 100) {
      const paths = candidates.slice(index, index + 100);
      const values = (await this.git(repositoryRoot, ['check-attr', '-z', 'filter', '--', ...paths])).stdout.split('\0');
      if (values.some((value, position) => position % 3 === 2 && value && value !== 'unspecified')) {
        throw new Error('Repository uses Git filters; refusing because filters may execute code.');
      }
    }
  }

  private async rejectCoreWorktree(repositoryRoot: string): Promise<void> {
    const result = await this.git(repositoryRoot, ['config', '--null', '--get-all', 'core.worktree'], false, true);
    if (result.exitCode === 1) return;
    if (result.exitCode !== 0) throw new Error('Unable to inspect Git core.worktree configuration.');
    if (result.stdout.length > 0) throw new Error('Repository configures core.worktree; refusing to materialize files outside the app-owned worktree.');
  }

  private async safeDiffPaths(repositoryRoot: string): Promise<string[]> {
    const status = await this.git(repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z', 'HEAD', '--']);
    const fields = status.stdout.split('\0');
    const safe = new Set<string>();
    let pathCount = 0;
    for (let index = 0; index < fields.length - 1;) {
      const code = fields[index++];
      if (!code) continue;
      const first = fields[index++];
      const hasSecondPath = code.startsWith('R') || code.startsWith('C');
      const second = hasSecondPath ? fields[index++] : undefined;
      if (!first || (hasSecondPath && !second)) throw new Error('Git returned malformed changed-path data.');
      const paths = second ? [first, second] : [first];
      pathCount += paths.length;
      if (pathCount > MAX_PATHS) throw new Error('Too many changed paths to safely render a diff.');
      // A rename/copy inherits the sensitive classification of either endpoint.
      if (paths.some((entry) => this.isDeniedRelativePath(entry))) continue;
      for (const entry of paths) safe.add(entry);
    }
    return [...safe];
  }

  private async hasSensitiveTrackedDeletion(repositoryRoot: string): Promise<boolean> {
    const fields = (await this.git(repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', 'HEAD', '--'])).stdout.split('\0');
    for (let index = 0; index < fields.length - 1;) {
      const code = fields[index++];
      if (!code) continue;
      const changedPath = fields[index++];
      if (!changedPath) throw new Error('Git returned malformed changed-path data.');
      if (code.startsWith('D') && this.isDeniedRelativePath(changedPath)) return true;
    }
    return false;
  }

  private async git(cwd: string, args: string[], permitTruncation = false, allowNonZero = false, options: { timeoutMs?: number; allowCredentialHelper?: boolean } = {}): Promise<GitOutput> {
    const hooksPath = path.join(path.resolve(this.worktreeBase), EMPTY_HOOKS_DIRECTORY);
    const env = gitEnvironment();
    try {
      const executable = await this.getGitExecutable(cwd);
      const result = await execFile(executable, ['--literal-pathspecs', '--no-pager', '-c', `core.hooksPath=${hooksPath}`, '-c', 'core.fsmonitor=', ...(options.allowCredentialHelper ? [] : ['-c', 'credential.helper=']), ...args], {
        cwd,
        env,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      return { stdout: result.stdout, truncated: false, exitCode: 0 };
    } catch (error: unknown) {
      const value = error as { code?: string; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      if (permitTruncation && value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { stdout: String(value.stdout ?? '').slice(0, GIT_MAX_OUTPUT_BYTES), truncated: true, exitCode: 0 };
      }
      if (allowNonZero && typeof value.code === 'number') return { stdout: String(value.stdout ?? ''), truncated: false, exitCode: value.code };
      const detail = String(value.stderr ?? value.message ?? 'Git command failed.').trim();
      throw new Error(`Git command failed: ${detail.slice(0, 500)}`, { cause: error });
    }
  }

  private async assertGitOutside(repositoryRoot: string): Promise<void> {
    const executable = await this.getGitExecutable(repositoryRoot);
    if (this.isInside(repositoryRoot, executable)) {
      throw new Error('Git executable resolves inside the selected repository.');
    }
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
}

export function createRepositoryService(worktreeBase: string): RepositoryService {
  return new RepositoryService(worktreeBase);
}
