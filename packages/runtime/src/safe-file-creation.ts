import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import primitiveSource from '../../../src/Foundry.Platform/SafeFileCreation.cs?raw';
import { MAX_WINDOWS_JOB_STDIN_BYTES, resolveWindowsJobHelperPath, runWindowsJob } from './windows-job';

export interface FileCreation {
  inspect(root: string, relativePath: string, signal?: AbortSignal): Promise<string[]>;
  create(root: string, relativePath: string, identities: readonly string[], bytes: Buffer, hash: string, signal?: AbortSignal): Promise<void>;
}

/** Only a trusted primitive response can prove that no file was created. */
export class FileCreationError extends Error {
  public constructor(message: string, public readonly outcome: 'none' | 'unknown') { super(message); this.name = 'FileCreationError'; }
}

const Identity = z.string().regex(/^[a-f0-9]{16}:[a-f0-9]{32}$/);
const Inspection = z.object({ version: z.literal(1), outcome: z.literal('success'), identities: z.array(Identity).min(1).max(4096) }).strict();
const Creation = z.object({ version: z.literal(1), outcome: z.enum(['success', 'none', 'unknown']), hash: z.string(), error: z.string().max(4096) }).strict();
const Failure = z.object({ version: z.literal(1), outcome: z.enum(['none', 'unknown']), hash: z.literal(''), error: z.string().max(4096) }).strict();

// This program is fixed application code. Source and bounded request data travel over stdin, never by interpolation
// into executable PowerShell/C#. The supervisor assigns the child to its kill-on-close job before resuming it.
const DRIVER = String.raw`
$ErrorActionPreference = 'Stop'
$enteredCreate = $false
$compiled = $false
try {
  $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true), $false)
  $request = $reader.ReadToEnd() | ConvertFrom-Json
  if ($request.version -ne 1 -or @('inspect', 'create') -notcontains [string]$request.operation) { throw 'Invalid file creation request.' }
  Add-Type -TypeDefinition ([string]$request.source) -Language CSharp -ErrorAction Stop
  $compiled = $true
  $creator = New-Object Foundry.Platform.SafeFileCreation
  if ($request.operation -eq 'inspect') {
    $identities = $creator.Inspect([string]$request.root, [string]$request.path)
    $response = @{ version = 1; outcome = 'success'; identities = @($identities) }
  } else {
    $enteredCreate = $true
    $result = $creator.Create([string]$request.root, [string]$request.path, [string[]]$request.identities, [string]$request.contentBase64, [string]$request.hash)
    $response = @{ version = 1; outcome = [string]$result.Outcome; hash = [string]$result.Hash; error = [string]$result.Error }
  }
} catch {
  $message = 'The safe file operation could not be verified.'
  if ($compiled -and $request.operation -eq 'inspect') {
    $observed = $_.Exception.GetBaseException().Message
    if ($observed.Length -le 4096) { $message = $observed }
  }
  $response = @{ version = 1; outcome = $(if ($enteredCreate) { 'unknown' } else { 'none' }); hash = ''; error = $message }
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Out.Write(($response | ConvertTo-Json -Compress -Depth 4))
`;

/** Windows-only bridge to the same source compiled into Foundry.Platform; it never starts the native runtime. */
export class WindowsFileCreation implements FileCreation {
  public async inspect(root: string, relativePath: string, signal?: AbortSignal): Promise<string[]> {
    const raw = await this.invoke(root, { operation: 'inspect', root, path: relativePath }, signal);
    const parsed = Inspection.safeParse(raw);
    if (parsed.success) return parsed.data.identities;
    const failure = Failure.safeParse(raw);
    throw new FileCreationError(failure.success ? failure.data.error : 'Safe parent-directory inspection returned an invalid result.', 'none');
  }

  public async create(root: string, relativePath: string, identities: readonly string[], bytes: Buffer, hash: string, signal?: AbortSignal): Promise<void> {
    const raw = await this.invoke(root, { operation: 'create', root, path: relativePath, identities, contentBase64: bytes.toString('base64'), hash }, signal);
    const result = Creation.safeParse(raw);
    if (!result.success) throw new FileCreationError('File creation returned an invalid result; inspect the retained operation.', 'unknown');
    if (result.data.outcome !== 'success') {
      if (result.data.hash !== '' || result.data.error === '') throw new FileCreationError('File creation returned inconsistent failure evidence.', 'unknown');
      throw new FileCreationError(result.data.error, result.data.outcome);
    }
    if (result.data.hash !== hash || result.data.error !== '') throw new FileCreationError('Created-file evidence did not match the reviewed content.', 'unknown');
  }

  private async invoke(root: string, request: Record<string, unknown>, signal = new AbortController().signal): Promise<unknown> {
    const creation = request.operation === 'create';
    const unavailable = (message: string) => new FileCreationError(message, 'none');
    if (process.platform !== 'win32') throw unavailable('Safe new-file creation is supported only on Windows.');
    if (signal.aborted) throw unavailable('File operation was cancelled before launch.');
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw unavailable('SystemRoot is unavailable.');
    let shell: string, helper: string, input: Buffer, directory: string, nonce: string;
    try {
      shell = await fs.realpath(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
      helper = await fs.realpath(resolveWindowsJobHelperPath());
      for (const executable of [shell, helper]) {
        const relative = path.relative(root, executable);
        if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw unavailable('File helper must be outside the approved worktree.');
      }
      input = Buffer.from(JSON.stringify({ version: 1, source: primitiveSource, ...request }), 'utf8');
      if (input.length > MAX_WINDOWS_JOB_STDIN_BYTES) throw unavailable('Safe file operation exceeds the helper input limit.');
      nonce = randomUUID();
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-file-create-'));
    } catch (error) {
      if (error instanceof FileCreationError) throw error;
      throw unavailable('Safe file helper setup failed before launch.');
    }
    try {
      if (signal.aborted) throw unavailable('File operation was cancelled before launch.');
      const temp = process.env.TEMP ?? process.env.TMP ?? path.join(systemRoot, 'Temp');
      const environment = {
        SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
        PATH: [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
        TEMP: temp, TMP: temp, USERPROFILE: process.env.USERPROFILE ?? path.dirname(temp),
      };
      const result = await runWindowsJob(helper, {
        shell, command: DRIVER, cwd: path.dirname(shell), environment, timeoutMs: 30_000, nonce,
        resultPath: path.join(directory, 'result.json'), cancelPath: path.join(directory, 'cancel'), stdinBytesBase64: input.toString('base64'),
      }, signal);
      if (result.nonce !== nonce || result.exitCode !== 0 || result.cancelled !== false || result.timedOut !== false || result.cleanupVerified !== true || result.stdinDelivered !== true) throw new Error('File helper did not complete with verified cleanup.');
      return JSON.parse(result.stdout) as unknown;
    } catch (error) {
      if (error instanceof FileCreationError) throw error;
      throw new FileCreationError(creation ? 'File creation could not be verified; inspect the retained operation.' : 'Safe parent-directory inspection failed.', creation ? 'unknown' : 'none');
    } finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  }
}
