import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
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

  public constructor(private readonly worktreeBase: string) {}

  public async createTaskWorktree(
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

  public async diff(root: string): Promise<DiffResult> {
    const repositoryRoot = await this.requireRepository(root);
    const safePaths = await this.safeDiffPaths(repositoryRoot);
    if (!safePaths.length) return { summary: '', patch: '', truncated: false };

    const summary = await this.git(repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--stat', 'HEAD', '--', ...safePaths]);
    const patch = await this.git(repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--binary', 'HEAD', '--', ...safePaths], true);
    return { summary: summary.stdout, patch: patch.stdout, truncated: patch.truncated };
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
    for (let index = 0; index < tracked.length; index += 100) {
      const paths = tracked.slice(index, index + 100);
      const values = (await this.git(repositoryRoot, ['check-attr', '-z', 'filter', '--', ...paths])).stdout.split('\0');
      if (values.some((value, position) => position % 3 === 2 && value && value !== 'unspecified')) {
        throw new Error('Repository uses Git filters; refusing checkout because filters may execute code.');
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

  private async git(cwd: string, args: string[], permitTruncation = false, allowNonZero = false): Promise<GitOutput> {
    const hooksPath = path.join(path.resolve(this.worktreeBase), EMPTY_HOOKS_DIRECTORY);
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    try {
      const executable = await this.getGitExecutable(cwd);
      const result = await execFile(executable, ['--literal-pathspecs', '--no-pager', '-c', `core.hooksPath=${hooksPath}`, '-c', 'core.fsmonitor=', '-c', 'credential.helper=', ...args], {
        cwd,
        env,
        timeout: GIT_TIMEOUT_MS,
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
