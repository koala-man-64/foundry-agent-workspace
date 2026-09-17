import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { Approval, ModelProfile, ProviderAdapter, ProviderRequest, Task, WorkspaceEvent } from '../../packages/protocol/src/index';
import { createProvider } from '../../packages/providers/src/index';
import { CommandRunner } from '../../packages/runtime/src/command-runner';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';

export const REQUIRED_VALIDATION = { command: "$files = @(Get-ChildItem -File -Filter *.txt); if ($files.Count -lt 3) { exit 1 }; foreach ($f in $files) { if ((Get-Content -Raw $f.FullName) -notmatch 'fixture') { exit 2 } }; Write-Output ('validated ' + $files.Count)", cwd: '', timeoutMs: 60000 };
export const SECOND_PROFILE: ModelProfile = { id: '7b0f3a52-4d7e-4b8a-9d6f-2f5a1c3e8b90', name: 'Offline child profile', apiKind: 'fake', endpoint: '', deployment: 'deterministic-child', contextLimit: 32000, outputLimit: 2048 };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

export interface Harness {
  directory: string; project: string; store: Store; runtime: RuntimeService; events: WorkspaceEvent[]; requests: { taskId?: string; profileId: string; request: ProviderRequest }[];
  sourceSnapshot: () => Record<string, string>;
  restart(provider?: (kind: ModelProfile['apiKind']) => ProviderAdapter): Promise<void>;
  close(): Promise<void>;
}

/** Temporary Git repository plus an isolated SQLite state directory. Never touches a user's repository or data. */
export async function createHarness(provider?: (kind: ModelProfile['apiKind']) => ProviderAdapter): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'foundry-orchestration-'));
  const project = join(directory, 'source'); await mkdir(project);
  git(project, 'init', '-b', 'main'); git(project, 'config', 'user.name', 'Fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  git(project, 'config', 'core.autocrlf', 'false');
  for (const name of ['alpha', 'beta', 'gamma']) await writeFile(join(project, `${name}.txt`), `${name} fixture\n`);
  await writeFile(join(project, 'README.md'), '# Orchestration fixture\n');
  git(project, 'add', '.'); git(project, 'commit', '-m', 'fixture');
  // Pre-existing uncommitted user work in the source checkout must survive untouched.
  await writeFile(join(project, 'README.md'), '# Orchestration fixture\n\nuser dirty edit\n');
  await writeFile(join(project, 'notes.untracked'), 'user untracked file\n');
  const events: WorkspaceEvent[] = []; const requests: Harness['requests'] = [];
  const base = provider ?? ((kind: ModelProfile['apiKind']) => createProvider(kind));
  const recording = (kind: ModelProfile['apiKind']): ProviderAdapter => {
    const adapter = base(kind);
    return { probe: profile => adapter.probe(profile), streamTurn: request => { requests.push({ profileId: request.profile.id, request }); return adapter.streamTurn(request); } };
  };
  const harness: Harness = {
    directory, project, events, requests,
    store: new Store(join(directory, 'state', 'workspace.db')),
    runtime: undefined as unknown as RuntimeService,
    sourceSnapshot: () => ({ head: git(project, 'rev-parse', 'HEAD'), status: git(project, 'status', '--porcelain=v1', '--untracked-files=all'), branches: git(project, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/main', 'refs/remotes'), readme: execFileSync('git', ['-C', project, 'show', 'HEAD:README.md'], { encoding: 'utf8' }) }),
    async restart(next) {
      await harness.runtime.shutdown();
      harness.store = new Store(join(directory, 'state', 'workspace.db'));
      harness.runtime = new RuntimeService(harness.store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event), next ? (kind => { const adapter = next(kind); return { probe: p => adapter.probe(p), streamTurn: r => { requests.push({ profileId: r.profile.id, request: r }); return adapter.streamTurn(r); } }; }) : recording, new CommandRunner(), { coordinatedMode: true });
    },
    async close() { await harness.runtime.shutdown(); await rm(directory, { recursive: true, force: true }); }
  };
  harness.store.saveProfile(SECOND_PROFILE);
  harness.runtime = new RuntimeService(harness.store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event), recording, new CommandRunner(), { coordinatedMode: true });
  return harness;
}

export async function createCoordinated(harness: Harness, tokenBudget = 600_000): Promise<Task> {
  return await harness.runtime.dispatch('task.create', { title: 'Coordinated fixture', projectPath: harness.project, profileId: FAKE_PROFILE_ID, tokenBudget, mode: 'coordinated', coordination: { childProfileIds: [SECOND_PROFILE.id], requiredValidation: REQUIRED_VALIDATION } }) as Task;
}

export function rootTasks(harness: Harness, rootId: string): Task[] {
  return harness.store.allTasks().filter(task => task.id === rootId || task.rootTaskId === rootId);
}
export function pendingApprovals(harness: Harness, rootId: string): Approval[] {
  return rootTasks(harness, rootId).flatMap(task => harness.store.approvals(task.id)).filter(item => item.state === 'awaiting-approval');
}
export async function waitFor<T>(check: () => T | undefined | false, timeout = 60_000): Promise<T> {
  let value: T | undefined | false;
  await vi.waitFor(() => { value = check(); expect(value).toBeTruthy(); }, { timeout, interval: 25 });
  return value as T;
}
export function bound(approval: Approval): { rootTaskId: string; taskId: string; approvalId: string; nonce: string; assignmentId: string | null; generation: number; fingerprint: string } {
  return { rootTaskId: approval.rootTaskId!, taskId: approval.taskId, approvalId: approval.id, nonce: approval.nonce, assignmentId: approval.assignmentId ?? null, generation: approval.generation!, fingerprint: approval.fingerprint };
}
export async function decide(harness: Harness, approval: Approval, decision: 'approve' | 'reject' = 'approve'): Promise<unknown> {
  return harness.runtime.dispatch('orchestration.decide', { ...bound(approval), decision });
}
/** Approve every pending action until `done` holds, optionally skipping approvals a test wants to hold. */
export async function approveUntil(harness: Harness, rootId: string, done: () => boolean, options: { skip?: (approval: Approval) => boolean; timeout?: number } = {}): Promise<void> {
  const deadline = Date.now() + (options.timeout ?? 150_000);
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out. Pending: ${JSON.stringify(pendingApprovals(harness, rootId).map(item => [item.tool, item.targetLabel]))}; runs: ${JSON.stringify(harness.runtime.orchestrator.records.runs(rootId).map(run => [run.title, run.lifecycle, run.waitReason, run.outcome]))}; assignments: ${JSON.stringify(harness.runtime.orchestrator.records.assignments(rootId).map(item => [item.key, item.state, item.waitReason]))}; last: ${JSON.stringify(harness.events.slice(-6))}`);
    const next = pendingApprovals(harness, rootId).find(item => !options.skip?.(item));
    if (next) { try { await decide(harness, next); } catch { /* raced with a state change; re-read */ } }
    else await new Promise(resolve => setTimeout(resolve, 25));
  }
}
export const fresh = randomUUID;
