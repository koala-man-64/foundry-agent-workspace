import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { isNetworkOrDevicePath } from './network-path';
import { gitEnvironment } from './git-environment';
import { promisify } from 'node:util';
import type { DiffResult, FileContent, FileEntry, GitTask } from '../../protocol/src/index';

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_ARTIFACT_TEXT_BYTES = 256 * 1024;
const MAX_ARTIFACT_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_PIXELS = 16_000_000;
const MAX_PATHS = 5_000;
const EMPTY_HOOKS_DIRECTORY = '.empty-git-hooks';
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.terraformrc|\.(?:ssh|aws|azure|kube|docker|gnupg)|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** Transports a push or remote check may use: https, ssh and local paths. Plain git, http and ext:: are denied by name too,
 * because a protocol-specific key in the user's global configuration would beat the generic one. */
const TRUSTED_PROTOCOLS = [
  '-c', 'protocol.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'protocol.git.allow=never', '-c', 'protocol.http.allow=never',
  '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.file.allow=always',
];
const TRUSTED_CORE_KEYS = new Set(['repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'symlinks', 'ignorecase',
  'autocrlf', 'eol', 'safecrlf', 'longpaths', 'precomposeunicode', 'quotepath', 'fscache']);
const FOREIGN_WORKTREE = "The task worktree no longer belongs to the task's project repository.";
// System.IO.DriveType values.
const DRIVE_NO_ROOT_DIRECTORY = 1;
const DRIVE_FIXED = 3;
const DRIVE_NETWORK = 4;
const DRIVE_TYPE_QUERY = "$ErrorActionPreference = 'Stop'\n[int][System.IO.DriveInfo]::new($env:FOUNDRY_DRIVE).DriveType";

export const unsupportedRemoteMessage = (remote: string): string => `Remote ${remote} points at a network share, through a link, or at a location push does not use.`;

/** The Windows drive type of a drive letter, as native's DriveInfo reports it. Node has no GetDriveType, so the fixed
 * system Windows PowerShell answers with no profile and no inherited environment; the letter is its only input. */
export async function windowsDriveType(letter: string): Promise<number> {
  if (!/^[A-Za-z]$/.test(letter)) throw new Error('A drive letter is required.');
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const shell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DRIVE_TYPE_QUERY, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: GIT_TIMEOUT_MS, env: { SystemRoot: systemRoot, WINDIR: systemRoot, FOUNDRY_DRIVE: `${letter}:\\` },
  });
  if (!/^[0-6]$/.test(stdout.trim())) throw new Error('The drive type of a remote could not be determined.');
  return Number(stdout.trim());
}

/**
 * Whether Git, under TRUSTED_PROTOCOLS, would use a remote URL's transport at all: https, ssh and file URLs with the
 * lowercase schemes Git matches, scp-like ssh, and local paths (native IsPermittedRemoteForm). Git refuses any other
 * scheme, any other spelling of these, and every `<helper>::` form only once the command runs, which would leave a push's
 * outcome unknown and its remote check unable to resolve it. Git also refuses, before it connects, a URL with leading
 * whitespace (it does not trim), one starting with `-`, `rsync:`, and an ssh URL whose host starts with `-`.
 */
export function isPermittedRemoteForm(url: string): boolean {
  if (/^\s|^-|^rsync:/.test(url)) return false;
  const value = url.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) return false;
  const scheme = value.indexOf('://');
  if (scheme < 0) return true;
  const name = value.slice(0, scheme);
  if (!['https', 'ssh', 'git+ssh', 'ssh+git', 'file'].includes(name)) return false;
  return name === 'https' || name === 'file' || !value.slice(scheme + 3).startsWith('-');
}

/** An https, ssh, scp-like or other scheme URL that is not file:// (native IsTransportRemote). */
function isTransportRemote(url: string): boolean {
  const value = url.trim();
  const scheme = value.indexOf('://');
  if (scheme > 0) return !/^file$/i.test(value.slice(0, scheme));
  // scp-like [user@]host:path: a colon before any slash, and not a drive letter.
  const colon = value.indexOf(':'); const separator = value.search(/[\\/]/);
  return colon > 1 && (separator < 0 || colon < separator);
}

/** The local path a remote URL names (a plain path, or a file:// URL with no host and no percent sign); undefined for a
 * transport URL and for any file:// URL that is refused. Git opens `file://localhost/...` as the UNC path
 * `//localhost/...`, so a host, localhost included, is a share (native LocalRemotePath). */
function localRemotePath(url: string): string | undefined {
  if (isTransportRemote(url)) return undefined;
  const value = url.trim();
  const scheme = value.indexOf('://');
  if (scheme < 0) return value;
  const rest = value.slice(scheme + 3);
  if (rest.includes('%')) return undefined;
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash);
  if (host.length > 0) return undefined;
  const local = slash < 0 ? '' : rest.slice(slash);
  return /^\/[A-Za-z]:/.test(local) ? local.slice(1) : local;
}

/**
 * Decision 8 for remotes (native IsNetworkRemote): whether a remote URL, as Git resolves it, names a network share (UNC,
 * device or any file://host form) or a drive letter that is mapped to one or unavailable, where any access would make Windows
 * authenticate to a server. Git percent-decodes file:// URLs before using them, so any file:// URL holding a percent sign
 * is refused outright rather than decoded here. https, ssh and scp-like URLs are transports, limited by TRUSTED_PROTOCOLS.
 */
export async function isNetworkRemote(url: string, driveType: (letter: string) => Promise<number> = windowsDriveType): Promise<boolean> {
  const value = localRemotePath(url);
  if (value === undefined) return !isTransportRemote(url);
  if (isNetworkOrDevicePath(value)) return true;
  if (/^[A-Za-z]:/.test(value)) return [DRIVE_NETWORK, DRIVE_NO_ROOT_DIRECTORY].includes(await driveType(value[0]!));
  return false;
}

/**
 * Every URL a push or remote check would use must be in a form Git uses under TRUSTED_PROTOCOLS, and must be a transport
 * or a local folder on a fixed local drive whose existing chain holds no link (checked from the drive root without
 * following one), so the named path is neither a share nor reached through a link to one. Relative paths resolve against
 * the folder the command runs in; Git's own `~` expansion and drive-relative paths (`C:repo`) are refused rather than
 * resolved. The check is not held across the push. Native RequireSupportedRemotes, with its message; its chain pin refuses
 * every reparse point, while Node's lstat recognizes symbolic links and junctions.
 * Not screened, in either runtime: Git also opens the destination's own layout (`<path>/.git`, `<path>.git`, a gitfile,
 * objects/info/alternates), which can lead elsewhere, a share included. The destination is trusted as its own receive-pack
 * hooks are (Rudy, 17 October 2026).
 */
export async function requireSupportedRemotes(cwd: string, remote: string, urls: string[], driveType: (letter: string) => Promise<number> = windowsDriveType): Promise<void> {
  const unsupported = () => new RepositoryError(unsupportedRemoteMessage(remote), 'none');
  for (const url of urls) {
    if (!isPermittedRemoteForm(url) || await isNetworkRemote(url, driveType)) throw unsupported();
    const local = localRemotePath(url);
    if (local === undefined) continue;
    if (!local || local.includes('\0') || local.startsWith('~') || /^[A-Za-z]:(?![\\/])/.test(local)
      || local.split(/[\\/]/).some(segment => segment !== '.' && segment !== '..' && /[. ]$/.test(segment))) throw unsupported();
    const resolved = path.win32.resolve(cwd, local);
    if (!/^[A-Za-z]:\\/.test(resolved) || resolved.slice(2).includes(':') || await driveType(resolved[0]!) !== DRIVE_FIXED) throw unsupported();
    let current = resolved.slice(0, 3);
    for (const component of ['', ...resolved.slice(3).split('\\').filter(Boolean)]) {
      if (component) current = path.win32.join(current, component);
      let stat: fsSync.Stats;
      try { stat = await fs.lstat(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw unsupported(); }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsupported();
    }
  }
}

/** The key as a push refusal names it, without its subsection, which can hold a URL with credentials; undefined when the
 * key neither runs a program nor changes the connection (native TrustedPushKey). Git lowercases sections and variables. */
function untrustedPushKey(key: string): string | undefined {
  const first = key.indexOf('.'); const last = key.lastIndexOf('.');
  const section = first > 0 ? key.slice(0, first) : key; const variable = last >= 0 && last < key.length - 1 ? key.slice(last + 1) : '';
  const subsection = first > 0 && last > first;
  const shown = subsection ? `${section}.*.${variable}` : key;
  if (first <= 0 || !variable) return shown;
  const trusted = subsection
    ? (section === 'remote' && ['url', 'pushurl', 'fetch', 'push', 'tagopt', 'prune'].includes(variable))
      || (section === 'branch' && ['remote', 'pushremote', 'merge', 'rebase'].includes(variable))
    : (section === 'core' && TRUSTED_CORE_KEYS.has(variable)) || section === 'extensions'
      || (section === 'user' && ['name', 'email', 'useconfigonly'].includes(variable))
      || (section === 'pull' && ['rebase', 'ff'].includes(variable)) || (section === 'push' && variable === 'default');
  return trusted ? undefined : shown;
}

/**
 * Before a publication mutation or its reconciliation, the worktree must share the project repository's common directory,
 * and that must still be the one bound when the task was created, when a binding exists (native RequireTaskWorktree). A
 * replaced folder holding another repository, with its own configuration and remotes, is never committed to or pushed from.
 */
function requireTaskWorktree(worktree: GitAdmissionIdentity, project: GitAdmissionIdentity, boundCommon: string | undefined): void {
  if (worktree.common !== project.common || (boundCommon !== undefined && worktree.common !== boundCommon)) throw new RepositoryError(FOREIGN_WORKTREE, 'none');
}

/** Inspect link metadata before following it; a local alias never grants network authority. */
export function resolveLocalPath(candidate: string, approvedPath?: string): string {
  if (isNetworkOrDevicePath(candidate)) throw new Error('Projects on network shares are not supported.');
  if (!path.isAbsolute(candidate)) throw new Error('Repository root must be an absolute path.');
  let absolute = path.resolve(candidate);
  const visited = new Set<string>();
  for (let hops = 0; hops <= 32; hops++) {
    const root = path.parse(absolute).root;
    const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
    let current = root; let redirected = false;
    for (let index = -1; index < components.length; index++) {
      if (index >= 0) current = path.join(current, components[index]!);
      const stat = fsSync.lstatSync(current);
      if (!stat.isSymbolicLink()) continue;
      const target = fsSync.readlinkSync(current);
      if (isNetworkOrDevicePath(target)) throw new Error('Projects on network shares are not supported.');
      const key = process.platform === 'win32' ? current.toLowerCase() : current;
      if (visited.has(key)) throw new Error('Repository alias contains a cycle.');
      visited.add(key);
      absolute = path.resolve(path.dirname(current), target, ...components.slice(index + 1));
      redirected = true; break;
    }
    if (redirected) continue;
    const canonical = fsSync.realpathSync.native(absolute);
    if (isNetworkOrDevicePath(canonical)) throw new Error('Projects on network shares are not supported.');
    const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    // An 8.3 or case spelling of the approved folder is the same folder; a replaced (now linked) or different folder is not.
    if (approvedPath && key(canonical) !== key(approvedPath) && !sameFolderSpelling(approvedPath, canonical)) {
      throw new Error('The saved folder now resolves to a different location.');
    }
    return canonical;
  }
  throw new Error('Repository alias depth exceeded.');
}

/**
 * Whether `spelling` names `canonical` through the same chain of real entries, differing only by 8.3 short names or case:
 * same drive root, same depth, and every prefix a non-link entry with the canonical prefix's file identity. Subst drives,
 * links, mount points and different folders never qualify; the drive check runs before any probe of `spelling`.
 */
function sameFolderSpelling(spelling: string, canonical: string): boolean {
  if (process.platform !== 'win32' || isNetworkOrDevicePath(spelling) || !path.isAbsolute(spelling)) return false;
  const parts = (value: string) => {
    const resolved = path.resolve(value); const root = path.parse(resolved).root;
    return [root, ...resolved.slice(root.length).split(path.sep).filter(Boolean)];
  };
  const left = parts(spelling); const right = parts(canonical);
  if (left.length !== right.length || left[0]!.toLowerCase() !== right[0]!.toLowerCase()) return false;
  try {
    for (let index = 1, a = left[0]!, b = right[0]!; index < left.length; index++) {
      a = path.join(a, left[index]!); b = path.join(b, right[index]!);
      const named = fsSync.lstatSync(a, { bigint: true }); const real = fsSync.lstatSync(b, { bigint: true });
      if (named.isSymbolicLink() || real.isSymbolicLink() || named.dev !== real.dev || named.ino !== real.ino) return false;
    }
    return true;
  } catch { return false; }
}

export interface GitAdmissionIdentity { path: string; root: string; gitDirectory: string; common: string }

/** Inspect Git pointers without invoking Git or following raw network/device targets. */
export function resolveGitAdmission(projectPath: string): GitAdmissionIdentity | undefined {
  const canonicalPath = resolveLocalPath(projectPath);
  let root = canonicalPath;
  const localExists = (file: string): boolean => {
    try { resolveLocalPath(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  while (!localExists(path.join(root, '.git'))) {
    const parent = path.dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
  const metadata = (file: string): string => {
    const safe = resolveLocalPath(file, file);
    if (fsSync.statSync(safe).size > 16384) throw new Error('Invalid Git project metadata.');
    return fsSync.readFileSync(safe, 'utf8').trim();
  };
  let gitDirectory = resolveLocalPath(path.join(root, '.git'));
  if (fsSync.statSync(gitDirectory).isFile()) {
    const gitdir = /^gitdir: (.+)$/.exec(metadata(gitDirectory));
    if (!gitdir) throw new Error('Invalid Git project metadata.');
    if (isNetworkOrDevicePath(gitdir[1]!)) throw new Error('Projects on network shares are not supported.');
    gitDirectory = resolveLocalPath(path.resolve(root, gitdir[1]!));
  }
  if (!fsSync.statSync(gitDirectory).isDirectory()) throw new Error('Invalid Git project metadata.');
  const common = path.join(gitDirectory, 'commondir');
  const pointer = localExists(common) ? metadata(common) : undefined;
  if (pointer && isNetworkOrDevicePath(pointer)) throw new Error('Projects on network shares are not supported.');
  return { path: canonicalPath, root, gitDirectory, common: resolveLocalPath(pointer ? path.resolve(gitDirectory, pointer) : gitDirectory) };
}

/** Point-in-time revalidation across awaits; this does not pin filesystem objects. */
export function assertGitAdmission(projectPath: string, expected: GitAdmissionIdentity | undefined): void {
  if (JSON.stringify(resolveGitAdmission(projectPath)) !== JSON.stringify(expected)) throw new Error('Project channel identity changed during admission.');
}

/** Paths within an admitted root cannot redirect individual file operations. */
export function assertNoReparseDirectories(candidate: string): void {
  if (isNetworkOrDevicePath(candidate)) throw new Error('Projects on network shares are not supported.');
  if (!path.isAbsolute(candidate)) throw new Error('Repository root must be an absolute path.');
  const absolute = path.resolve(candidate); const root = path.parse(absolute).root;
  let current = root;
  for (const component of ['', ...absolute.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    if (fsSync.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links cannot be accessed.');
  }
}

type GitOutput = { stdout: string; truncated: boolean; exitCode: number };
export interface PreparedEdit {
  root: string; path: string; before: string; after: string; expectedHash: string | null; resultingHash: string; fingerprint: string;
}
export interface ArtifactBytes { bytes: Buffer; mimeType: string; width?: number; height?: number }

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

  /** Classify a saved folder without creating a worktree or altering Git state. */
  public async isGitWorkingTree(root: string): Promise<boolean> {
    // A security refusal must not be swallowed as ordinary folder classification.
    const identity = resolveGitAdmission(root);
    if (!identity) return false;
    try {
      const selected = await this.requireRepository(root);
      const top = (await this.git(selected, ['rev-parse', '--show-toplevel'])).stdout.trim();
      const canonicalTop = await fs.realpath(top);
      const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      return key(selected) === key(canonicalTop);
    } catch { return false; }
    finally { assertGitAdmission(root, identity); }
  }

  public async createTaskWorktree(
    projectPath: string,
    taskId: string,
    baseCommit?: string,
    admittedIdentity?: GitAdmissionIdentity,
  ): Promise<{ worktreePath: string; branch: string; baseCommit: string }> {
    let identity: GitAdmissionIdentity;
    try {
      const expected = admittedIdentity ?? resolveGitAdmission(projectPath);
      if (!expected) throw new Error('Project channel requires an available local Git project.');
      identity = Object.freeze({ ...expected });
      assertGitAdmission(projectPath, identity);
    } catch (error) {
      throw new RepositoryError(error instanceof Error ? error.message : 'Repository admission failed.', 'none', { cause: error });
    }
    const key = process.platform === 'win32' ? identity.common.toLowerCase() : identity.common;
    const previous = this.creating.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.createTaskWorktreeSerialized(projectPath, taskId, baseCommit, identity));
    this.creating.set(key, operation);
    try { return await operation; } finally { if (this.creating.get(key) === operation) this.creating.delete(key); }
  }

  private async createTaskWorktreeSerialized(
    projectPath: string,
    taskId: string,
    requestedBase: string | undefined,
    identity: GitAdmissionIdentity,
  ): Promise<{ worktreePath: string; branch: string; baseCommit: string }> {
    let mutationStarted = false;

    try {
      assertGitAdmission(projectPath, identity);
      const projectRoot = await this.requireRepository(projectPath);
      assertGitAdmission(projectPath, identity);
      const baseCommit = requestedBase ? await this.requireLocalCommit(projectRoot, requestedBase) : (await this.git(projectRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
      assertGitAdmission(projectPath, identity);
      if (!baseCommit) throw new Error('Repository does not have a valid HEAD commit.');
      await this.rejectTrackedFiltersAtRevision(projectRoot, baseCommit);
      assertGitAdmission(projectPath, identity);
      const id = this.requireTaskId(taskId);
      const branch = `codex/task/${id}`;
      const base = await this.prepareWorktreeBase();
      const worktreePath = path.join(base, id);
      assertGitAdmission(projectPath, identity);
      await this.git(projectRoot, ['worktree', 'add', '--no-checkout', '-b', branch, worktreePath, baseCommit], false, false, {
        admission: identity,
        beforeMutation: () => {
          assertGitAdmission(projectPath, identity);
          // Set only at the final process boundary; later failures retain an unknown outcome.
          mutationStarted = true;
        },
      });
      assertGitAdmission(projectPath, identity);
      const worktreeIdentity = resolveGitAdmission(worktreePath);
      if (!worktreeIdentity || worktreeIdentity.common !== identity.common) throw new Error('Created worktree does not belong to the admitted repository.');
      // Checkout may run filters, so it follows the tracked-filter check above and disables hooks.
      await this.git(worktreePath, ['checkout', '--no-recurse-submodules', branch], false, false, {
        admission: worktreeIdentity,
        beforeMutation: () => { assertGitAdmission(projectPath, identity); },
      });
      assertGitAdmission(projectPath, identity);
      return { worktreePath, branch, baseCommit };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      const detail = error instanceof Error ? error.message : 'Repository operation failed.';
      throw new RepositoryError(detail, mutationStarted ? 'unknown' : 'none', { cause: error });
    }
  }

  /** A continuation can use a clean live task HEAD or an explicitly selected retained local commit. */
  public async continuationSource(task: GitTask, selectedCommit?: string): Promise<{ projectPath: string; commit: string }> {
    const projectPath = await this.requireRepository(task.projectPath);
    if (task.status === 'retired') {
      if (!selectedCommit) throw new Error('A retired task requires an explicit retained commit.');
      return { projectPath, commit: await this.requireLocalCommit(projectPath, selectedCommit) };
    }
    const worktreePath = await this.requireRepository(task.worktreePath);
    const projectGit = await fs.realpath(path.resolve(projectPath, (await this.git(projectPath, ['rev-parse', '--git-common-dir'])).stdout.trim()));
    const worktreeGit = await fs.realpath(path.resolve(worktreePath, (await this.git(worktreePath, ['rev-parse', '--git-common-dir'])).stdout.trim()));
    if (process.platform === 'win32' ? projectGit.toLowerCase() !== worktreeGit.toLowerCase() : projectGit !== worktreeGit)
      throw new Error('Source worktree does not belong to the selected project repository.');
    if ((await this.uncommittedPaths(worktreePath)).length) throw new Error('Continuation requires a clean source worktree.');
    const head = (await this.git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    if (selectedCommit) {
      const selected = await this.requireLocalCommit(projectPath, selectedCommit);
      if (selected !== head) throw new Error('Selected commit differs from the clean source HEAD.');
    }
    return { projectPath, commit: head };
  }

  private async requireLocalCommit(repositoryRoot: string, candidate: string): Promise<string> {
    if (!/^[0-9a-f]{40}$/i.test(candidate)) throw new Error('A full local 40-character commit SHA is required.');
    const commit = (await this.git(repositoryRoot, ['rev-parse', '--verify', `${candidate}^{commit}`])).stdout.trim();
    if (commit.toLowerCase() !== candidate.toLowerCase()) throw new Error('Selected commit is not an exact local commit.');
    return commit;
  }

  /** Filter attributes must be inspected from the selected tree, which may differ from the current checkout. */
  private async rejectTrackedFiltersAtRevision(repositoryRoot: string, commit: string): Promise<void> {
    const tracked = (await this.git(repositoryRoot, ['ls-tree', '-r', '-z', '--name-only', commit])).stdout.split('\0').filter(Boolean);
    if (tracked.length > MAX_PATHS) throw new Error('Repository has too many tracked paths to safely inspect filters.');
    for (let index = 0; index < tracked.length; index += 100) {
      const paths = tracked.slice(index, index + 100);
      const values = (await this.git(repositoryRoot, ['check-attr', `--source=${commit}`, '-z', 'filter', '--', ...paths])).stdout.split('\0');
      if (values.some((value, position) => position % 3 === 2 && value && value !== 'unspecified')) {
        throw new Error('Selected revision uses Git filters; refusing because checkout may execute code.');
      }
    }
  }

  /** Tracked modifications plus untracked files (ignored files excluded), as Git reports them. Read-only. */
  public async uncommittedPaths(root: string): Promise<string[]> {
    return (await this.changedEntries(root)).map(entry => entry.path);
  }

  /** Each status entry's path and, for a rename or copy in either status column, its source, which porcelain v1 writes after it. The repository is
   * admitted again; with `admission`, its identity must still be that one. */
  private async changedEntries(root: string, admission?: GitAdmissionIdentity): Promise<{ path: string; source?: string }[]> {
    const repositoryRoot = await this.requireRepository(root);
    const output = (await this.git(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], false, false, { admission })).stdout;
    const entries: { path: string; source?: string }[] = [];
    const fields = output.split('\0');
    for (let index = 0; index < fields.length; index++) {
      const entry = fields[index];
      if (!entry) continue;
      const code = entry.slice(0, 2); const changedPath = entry.slice(3);
      if (/[RC]/.test(code)) entries.push({ path: changedPath, source: fields[++index] });
      else entries.push({ path: changedPath });
    }
    return entries;
  }

  /**
   * Explicit user commit of every change in the task worktree. Secret-named paths are never staged;
   * hooks stay disabled; the commit identity comes from the user's Git configuration and is never invented.
   * The worktree must still belong to the task's project repository, which stays pinned for the rest of the commit; both
   * endpoints of a rename or copy are screened before staging, and the staged paths again without rename detection, so a
   * secret-named path cannot be committed under another name (review of #36, as native CommitAll).
   */
  public async commitAll(root: string, projectPath: string, boundCommon: string | undefined, expectedBranch: string, message: string): Promise<{ commit: string; changedPaths: string[] }> {
    const repository = await this.admitRepository(root);
    let project: { identity: GitAdmissionIdentity };
    try { project = await this.admitRepository(projectPath); }
    catch (error) { throw new RepositoryError(error instanceof Error ? error.message : 'Repository admission failed.', 'none', { cause: error }); }
    requireTaskWorktree(repository.identity, project.identity, boundCommon);
    const repositoryRoot = repository.root; const pinned = { admission: repository.identity };
    const branch = (await this.git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], false, false, pinned)).stdout.trim();
    if (branch !== expectedBranch) throw new RepositoryError(`The worktree is on ${branch}, not the task branch ${expectedBranch}.`, 'none');
    const entries = await this.changedEntries(repositoryRoot, repository.identity);
    const dirty = entries.map(entry => entry.path);
    if (!dirty.length) throw new RepositoryError('There are no changes to commit.', 'none');
    const denied = entries.flatMap(entry => entry.source === undefined ? [entry.path] : [entry.path, entry.source]).filter(entry => this.isDeniedRelativePath(entry));
    if (denied.length) throw new RepositoryError(`Refusing to commit secret-named paths: ${denied.slice(0, 5).join(', ')}. Remove or ignore them first.`, 'none');
    // `git add` runs clean filters. Attributes may have changed since the worktree was created (a .gitattributes edit is an
    // ordinary reviewed file change), so every tracked path and every path about to be staged is re-checked here.
    try {
      await this.rejectTrackedFilters(repositoryRoot, repository.identity);
      await this.rejectFilters(repositoryRoot, dirty, repository.identity);
    } catch (error) { throw new RepositoryError(error instanceof Error ? error.message : 'Filter check failed.', 'none', { cause: error }); }
    let mutationStarted = false;
    try {
      mutationStarted = true;
      await this.git(repositoryRoot, ['add', '--all', '--', '.'], false, false, pinned);
      const staged = (await this.git(repositoryRoot, ['diff', '--cached', '--name-only', '-z'], false, false, pinned)).stdout.split('\0').filter(Boolean);
      if (!staged.length) { await this.git(repositoryRoot, ['reset', '-q'], false, false, pinned); throw new Error('Nothing was staged.'); }
      const screened = (await this.git(repositoryRoot, ['diff', '--cached', '--name-only', '--no-renames', '-z'], false, false, pinned)).stdout.split('\0').filter(Boolean);
      if ([...staged, ...screened].some(entry => this.isDeniedRelativePath(entry))) { await this.git(repositoryRoot, ['reset', '-q'], false, false, pinned); throw new Error('A secret-named path was staged; the index was reset and nothing was committed.'); }
      await this.git(repositoryRoot, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', message], false, false, pinned);
      const commit = (await this.git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], false, false, pinned)).stdout.trim();
      return { commit, changedPaths: staged };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(error instanceof Error ? error.message : 'Commit failed.', mutationStarted ? 'unknown' : 'none', { cause: error });
    }
  }

  /**
   * Explicit user push of the task branch. Never forces, never prompts; the user's credential helper may run for this action only.
   * The worktree must still belong to the task's project repository, its own configuration must pass
   * requireTrustedPushConfiguration, and every push URL must pass requireSupportedRemotes; each refusal is "none" (as native Push).
   */
  public async push(root: string, projectPath: string, boundCommon: string | undefined, remote: string, branch: string): Promise<string> {
    const repository = await this.admitRepository(root);
    const project = await this.admitRepository(projectPath);
    requireTaskWorktree(repository.identity, project.identity, boundCommon);
    const repositoryRoot = repository.root; const pinned = { admission: repository.identity };
    const url = await this.git(project.root, ['remote', 'get-url', '--', remote], false, true, { admission: project.identity });
    if (url.exitCode !== 0 || !url.stdout.trim()) throw new RepositoryError(`Remote ${remote} is not configured in the project repository.`, 'none');
    const current = (await this.git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], false, false, pinned)).stdout.trim();
    if (current !== branch) throw new RepositoryError(`The worktree is on ${current}, not the task branch ${branch}.`, 'none');
    try {
      await this.requireTrustedPushConfiguration(repositoryRoot, repository.identity);
      const pushUrls = (await this.git(repositoryRoot, ['remote', 'get-url', '--push', '--all', '--', remote], false, false, pinned)).stdout.split('\n').filter(Boolean);
      await requireSupportedRemotes(repositoryRoot, remote, pushUrls);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(error instanceof Error ? error.message : 'Push preflight failed.', 'none', { cause: error });
    }
    try {
      const result = await this.git(repositoryRoot, [...TRUSTED_PROTOCOLS, 'push', '--no-verify', '--porcelain', '--', remote, `refs/heads/${branch}:refs/heads/${branch}`], false, false, { timeoutMs: 120_000, allowCredentialHelper: true, ...pinned });
      return result.stdout.trim();
    } catch (error) {
      throw new RepositoryError(error instanceof Error ? error.message : 'Push failed.', 'unknown', { cause: error });
    }
  }

  public async headCommit(worktreePath: string): Promise<string> {
    const repositoryRoot = await this.requireRepository(worktreePath);
    return (await this.git(repositoryRoot, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  /**
   * Reconcile whether a previously ambiguous push reached the remote by checking if the remote ref contains the attempted commit (or HEAD).
   * ls-remote reads the remote's fetch URLs, so a remote whose push URLs differ stays unknown rather than being judged against
   * another server; so does one that fails requireSupportedRemotes or requireTrustedPushConfiguration (as native VerifyPushOutcome).
   */
  public async verifyPushOutcome(projectPath: string, worktreePath: string, boundCommon: string | undefined, remote: string, branch: string, expectedCommit?: string): Promise<boolean | undefined> {
    try {
      const project = await this.admitRepository(projectPath);
      const projectRoot = project.root; const pinned = { admission: project.identity };
      const commit = expectedCommit ?? (await this.taskWorktreeHead(worktreePath, project.identity, boundCommon));
      const fetchUrls = await this.git(projectRoot, ['remote', 'get-url', '--all', '--', remote], false, true, pinned);
      const pushUrls = await this.git(projectRoot, ['remote', 'get-url', '--push', '--all', '--', remote], false, true, pinned);
      if (fetchUrls.exitCode !== 0 || pushUrls.exitCode !== 0 || fetchUrls.stdout !== pushUrls.stdout) return undefined;
      await requireSupportedRemotes(projectRoot, remote, fetchUrls.stdout.split('\n').filter(Boolean));
      await this.requireTrustedPushConfiguration(projectRoot, project.identity);
      const result = await this.git(projectRoot, [...TRUSTED_PROTOCOLS, 'ls-remote', '--heads', remote, `refs/heads/${branch}`], false, true, { allowCredentialHelper: true, ...pinned });
      if (result.exitCode !== 0) return undefined;
      // SHA-1 or SHA-256 object names.
      const match = result.stdout.trim().match(/^([0-9a-f]{64}|[0-9a-f]{40})\s+/i);
      if (!match) {
        return result.stdout.trim() === '' ? false : undefined;
      }
      const remoteTip = match[1]!;
      if (remoteTip.toLowerCase() === commit.toLowerCase()) return true;
      const ancestor = await this.git(projectRoot, ['merge-base', '--is-ancestor', commit, remoteTip], false, true, pinned);
      if (ancestor.exitCode === 0) return true;
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** The task worktree's HEAD, read only once the worktree still belongs to the task's project repository. */
  private async taskWorktreeHead(worktreePath: string, project: GitAdmissionIdentity, boundCommon: string | undefined): Promise<string> {
    const worktree = await this.admitRepository(worktreePath);
    requireTaskWorktree(worktree.identity, project, boundCommon);
    return (await this.git(worktree.root, ['rev-parse', 'HEAD'], false, false, { admission: worktree.identity })).stdout.trim();
  }

  /**
   * Reconcile whether an ambiguous commit succeeded by identifying the created commit against its base and expected message.
   * A worktree that no longer belongs to the task's project repository proves nothing, so it stays unknown (as native).
   */
  public async verifyCommitOutcome(worktreePath: string, projectPath: string, boundCommon: string | undefined, baseCommit?: string, expectedMessage?: string): Promise<boolean | undefined> {
    if (!baseCommit) return undefined;
    try {
      const repository = await this.admitRepository(worktreePath);
      requireTaskWorktree(repository.identity, (await this.admitRepository(projectPath)).identity, boundCommon);
      const repositoryRoot = repository.root; const pinned = { admission: repository.identity };
      const currentHead = (await this.git(repositoryRoot, ['rev-parse', 'HEAD'], false, false, pinned)).stdout.trim();
      if (currentHead === baseCommit) {
        return false;
      }
      const parentResult = await this.git(repositoryRoot, ['rev-parse', 'HEAD^'], false, true, pinned);
      const parentCommit = parentResult.exitCode === 0 ? parentResult.stdout.trim() : undefined;
      const logResult = await this.git(repositoryRoot, ['log', '-1', '--format=%B', 'HEAD'], false, true, pinned);
      const messageMatches = expectedMessage ? logResult.stdout.trim() === expectedMessage.trim() : true;
      const dirty = await this.changedEntries(repositoryRoot, repository.identity);
      if (parentCommit === baseCommit && messageMatches && dirty.length === 0) {
        return true;
      }
      return undefined;
    } catch {
      return undefined;
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

  /** Bounded local preview bytes; the caller renders text safely and never loads file URLs. */
  public async readArtifact(task: GitTask, relativePath: string): Promise<ArtifactBytes> {
    if (task.status === 'retired') throw new Error('A retired task has no preview worktree.');
    const root = await this.requireRepository(task.worktreePath);
    this.validateRelativePath(relativePath, false);
    const extension = path.extname(relativePath).toLowerCase();
    const text = ['.md', '.markdown', '.txt', '.log', '.out', '.tap'].includes(extension);
    const image = ['.png', '.jpg', '.jpeg', '.webp'].includes(extension);
    if (!text && !image) throw new Error('This artifact type cannot be previewed.');
    const segments = relativePath.replaceAll('\\', '/').split('/');
    let candidate = root;
    for (const segment of segments) {
      candidate = path.join(candidate, segment);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links cannot be previewed.');
    }
    const resolved = await fs.realpath(candidate);
    if (!this.isInside(root, resolved) || this.isDeniedRelativePath(this.toPortableRelativePath(root, resolved))) throw new Error('Artifact path is unavailable.');
    const handle = await fs.open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      const max = text ? MAX_ARTIFACT_TEXT_BYTES : MAX_ARTIFACT_IMAGE_BYTES;
      if (!stat.isFile() || stat.size > max) throw new Error('Artifact exceeds its preview limit or is not a regular file.');
      const bytes = await handle.readFile();
      if (bytes.length > max) throw new Error('Artifact changed beyond its preview limit.');
      const finalPath = await fs.realpath(candidate);
      if (!this.isInside(root, finalPath) || finalPath !== resolved) throw new Error('Artifact path changed during preview.');
      if (text) {
        if (bytes.includes(0)) throw new Error('Binary data cannot be previewed as text.');
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Artifact must be UTF-8 text.'); }
        return { bytes, mimeType: extension === '.md' || extension === '.markdown' ? 'text/markdown' : 'text/plain' };
      }
      const dimensions = imageDimensions(bytes, extension);
      if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > MAX_ARTIFACT_PIXELS) throw new Error('Image signature or dimensions are invalid.');
      return { bytes, mimeType: extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg', ...dimensions };
    } finally { await handle.close(); }
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
    return (await this.admitRepository(candidate)).root;
  }

  /** requireRepository, with the Git identity it held throughout, for callers that pin it across later commands. */
  private async admitRepository(candidate: string): Promise<{ root: string; identity: GitAdmissionIdentity }> {
    const identity = resolveGitAdmission(candidate);
    const root = await this.requireRoot(candidate);
    assertGitAdmission(candidate, identity);
    await this.assertGitOutside(root);
    assertGitAdmission(candidate, identity);
    await this.rejectCoreWorktree(root);
    assertGitAdmission(candidate, identity);
    const inside = (await this.git(root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim();
    assertGitAdmission(candidate, identity);
    const bare = (await this.git(root, ['rev-parse', '--is-bare-repository'])).stdout.trim();
    assertGitAdmission(candidate, identity);
    if (inside !== 'true' || bare !== 'false') throw new Error('Path must be a non-bare Git working tree.');
    if (!identity) throw new Error('Project channel requires an available local Git project.');
    return { root, identity };
  }

  /**
   * Push and remote verification honor the repository's own configuration, which can run programs (credential helpers,
   * core.sshCommand, transport programs, ext:: URLs) or redirect where and how Git connects. Before either runs, every key
   * that the repository's configuration sets (its local and worktree scopes, with everything they include) must be one that
   * neither runs a program nor changes the connection; anything else, including include directives, refuses with "none".
   * The user's global configuration is theirs and is not screened. Unknown keys refuse. Limits, accepted by Rudy on
   * 17 October 2026: a local-folder remote runs that destination repository's own receive-pack hooks and configuration, and
   * a same-user process that rewrites the configuration between this screen and the push is not detected. Network shares
   * and links are refused separately (requireSupportedRemotes). Native RequireTrustedPushConfiguration, with the same message.
   */
  private async requireTrustedPushConfiguration(repositoryRoot: string, admission: GitAdmissionIdentity): Promise<void> {
    const fields = (await this.git(repositoryRoot, ['config', '--list', '--show-scope', '-z'], false, false, { admission })).stdout.split('\0');
    for (let index = 0; index + 1 < fields.length; index += 2) {
      if (['global', 'system', 'command'].includes(fields[index]!)) continue;
      const entry = fields[index + 1]!; const newline = entry.indexOf('\n');
      const shown = untrustedPushKey(newline < 0 ? entry : entry.slice(0, newline));
      if (shown !== undefined) throw new RepositoryError(`Push refused: the repository's own Git configuration sets ${shown}, which push does not trust. Move it to your global Git configuration or remove it.`, 'none');
    }
  }

  private async requireRoot(candidate: string): Promise<string> {
    if (!candidate || !path.isAbsolute(candidate)) throw new Error('Repository root must be an absolute path.');
    if (isNetworkOrDevicePath(candidate)) throw new Error('Projects on network shares are not supported.');
    const root = resolveLocalPath(candidate);
    const stat = await fs.stat(root);
    if (!stat.isDirectory() || path.basename(root).toLowerCase() === '.git') throw new Error('Root must be a working directory.');
    return root;
  }

  private async resolveSafePath(root: string, relativePath: string, allowDirectory: boolean): Promise<string> {
    this.validateRelativePath(relativePath, allowDirectory);
    const candidate = path.resolve(root, relativePath || '.');
    if (!this.isInside(root, candidate)) throw new Error('Path escapes the repository root.');
    assertNoReparseDirectories(path.dirname(candidate));
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

  private async rejectTrackedFilters(repositoryRoot: string, admission?: GitAdmissionIdentity): Promise<void> {
    const tracked = (await this.git(repositoryRoot, ['ls-files', '-z'], false, false, { admission })).stdout.split('\0').filter(Boolean);
    if (tracked.length > MAX_PATHS) throw new Error('Repository has too many tracked paths to safely inspect filters.');
    await this.rejectFilters(repositoryRoot, tracked, admission);
  }

  /** Reject any path with a `filter` attribute: clean/smudge filters run arbitrary commands during add and checkout. */
  private async rejectFilters(repositoryRoot: string, candidates: string[], admission?: GitAdmissionIdentity): Promise<void> {
    if (candidates.length > MAX_PATHS) throw new Error('Too many paths to safely inspect filters.');
    for (let index = 0; index < candidates.length; index += 100) {
      const paths = candidates.slice(index, index + 100);
      const values = (await this.git(repositoryRoot, ['check-attr', '-z', 'filter', '--', ...paths], false, false, { admission })).stdout.split('\0');
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

  private async git(cwd: string, args: string[], permitTruncation = false, allowNonZero = false, options: { timeoutMs?: number; allowCredentialHelper?: boolean; admission?: GitAdmissionIdentity; beforeMutation?: () => void } = {}): Promise<GitOutput> {
    const identity = options.admission ?? resolveGitAdmission(cwd);
    if (!identity) throw new Error('Project channel requires an available local Git project.');
    assertGitAdmission(cwd, identity);
    const hooksPath = path.join(path.resolve(this.worktreeBase), EMPTY_HOOKS_DIRECTORY);
    const env = gitEnvironment();
    try {
      const executable = await this.getGitExecutable(cwd);
      assertGitAdmission(cwd, identity);
      options.beforeMutation?.();
      const result = await execFile(executable, ['--literal-pathspecs', '--no-pager', '-c', `core.hooksPath=${hooksPath}`, '-c', 'core.fsmonitor=', ...(options.allowCredentialHelper ? [] : ['-c', 'credential.helper=']), ...args], {
        cwd,
        env,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      assertGitAdmission(cwd, identity);
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

function imageDimensions(bytes: Buffer, extension: string): { width: number; height: number } | undefined {
  if (extension === '.png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (extension === '.webp') {
    if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) return undefined;
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      return { width: 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)), height: 1 + ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)) };
    }
    if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    return undefined;
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return undefined;
    let offset = 2;
    while (offset + 8 <= bytes.length) {
      if (bytes[offset] !== 0xff) return undefined;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue;
      if (offset + 2 > bytes.length) return undefined;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return undefined;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7) return undefined;
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  return undefined;
}
