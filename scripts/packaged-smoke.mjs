import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import console from 'node:console';

const directory = await mkdtemp(join(tmpdir(), 'foundry-package-smoke-'));
const executable = resolve('release/win-unpacked/Foundry Agent Workspace.exe');
const runtime = resolve('release/win-unpacked/resources/app.asar/out/main/runtime.js');
// The packaged runtime keeps coordinated mode behind its release gate; the smoke opts in explicitly.
const environment = { ELECTRON_RUN_AS_NODE: '1', FOUNDRY_WORKSPACE_DATA: join(directory, 'data'), FOUNDRY_WORKSPACE_ENABLE_COORDINATED: '1' };
for (const key of ['SystemRoot', 'PATH', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE']) if (process.env[key]) environment[key] = process.env[key];
const VALIDATION = { command: "$files = @(Get-ChildItem -File -Filter *.txt); if ($files.Count -lt 3) { exit 1 }; foreach ($f in $files) { if ((Get-Content -Raw $f.FullName) -notmatch 'fixture') { exit 2 } }; Write-Output ('validated ' + $files.Count)", cwd: '', timeoutMs: 60000 };
let child; let errors = ''; let sequence = 0; let watchdog;
const pending = new Map();
try {
  await stat(executable);
  const source = join(directory, 'source');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', source], { windowsHide: true });
  git(source, 'config', 'user.name', 'Package Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid'); git(source, 'config', 'core.autocrlf', 'false');
  await writeFile(join(source, 'README.md'), '# Package fixture\n');
  for (const name of ['alpha', 'beta', 'gamma']) await writeFile(join(source, `${name}.txt`), `${name} fixture\n`);
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'fixture');
  child = spawn(executable, [runtime], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n'); if (index < 0) break;
      const response = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const waiter = pending.get(response.id);
      if (waiter) { pending.delete(response.id); if (response.error) waiter.reject(new Error(response.error.message)); else waiter.resolve(response.result); }
    }
  });
  const exit = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', code => { for (const waiter of pending.values()) waiter.reject(new Error(`Runtime exited: ${code}; ${errors}`)); accept(code); });
  });
  watchdog = setTimeout(() => { child.kill(); }, 300000);
  const invoke = (method, params) => new Promise((resolve, reject) => {
    const id = String(++sequence); pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const snapshot = await invoke('workspace.snapshot', {});
  assert.equal(snapshot.runtime, 'ready'); assert.equal(snapshot.profiles[0]?.apiKind, 'fake');

  // 1. Existing single-agent coding path.
  const task = await invoke('task.create', { title: 'Packaged coding smoke', projectPath: source, profileId: snapshot.profiles[0].id, mode: 'coding', tokenBudget: 200000 });
  await invoke('task.send', { taskId: task.id, content: '/demo' });
  let final;
  for (let i = 0; i < 400; i++) {
    const detail = await invoke('task.get', { taskId: task.id });
    const approval = detail.approvals.find(value => value.state === 'awaiting-approval');
    if (approval) await invoke('approval.decide', { taskId: task.id, approvalId: approval.id, nonce: approval.nonce, decision: 'approve' });
    if (detail.task.status !== 'running') { final = detail; break; }
    await delay(100);
  }
  assert.equal(final?.task.status, 'idle', JSON.stringify(final));
  assert.equal(final.approvals.length, 2);
  assert.ok(final.approvals.every(value => value.state === 'complete'), JSON.stringify(final.approvals));
  assert.equal(final.approvals.find(value => value.command).result.cleanupVerified, true);

  // 2. Coordinated two-child workflow plus a dependent child, serial integration and combined validation.
  assert.deepEqual(await invoke('workspace.schema', {}), { version: 2, current: 2, upgradeRequired: false, coordinatedAvailable: true });
  const root = await invoke('task.create', { title: 'Packaged coordinated smoke', projectPath: source, profileId: snapshot.profiles[0].id, mode: 'coordinated', tokenBudget: 600000, coordination: { childProfileIds: [], requiredValidation: VALIDATION } });
  const baseHead = git(root.worktreePath, 'rev-parse', 'HEAD');
  await invoke('task.send', { taskId: root.id, content: '/orchestrate-demo' });
  let view; let approvals = 0; let maxActiveChildren = 0;
  for (let i = 0; i < 3000; i++) {
    view = await invoke('orchestration.get', { rootTaskId: root.id });
    maxActiveChildren = Math.max(maxActiveChildren, view.runs.filter(run => run.role === 'child' && run.lifecycle !== 'terminal').length);
    const coordinator = view.runs.find(run => run.role === 'coordinator');
    if (coordinator.lifecycle === 'terminal') break;
    const candidates = [...(await invoke('task.get', { taskId: root.id })).approvals];
    for (const run of view.runs.filter(item => item.role === 'child' && item.lifecycle !== 'terminal')) candidates.push(...(await invoke('orchestration.child', { rootTaskId: root.id, childTaskId: run.taskId })).approvals);
    const next = candidates.find(value => value.state === 'awaiting-approval');
    if (next) {
      assert.ok(next.rootTaskId === root.id && next.targetLabel && Number.isInteger(next.generation), JSON.stringify(next));
      await invoke('orchestration.decide', { rootTaskId: root.id, taskId: next.taskId, approvalId: next.id, nonce: next.nonce, assignmentId: next.assignmentId ?? null, generation: next.generation, fingerprint: next.fingerprint, decision: 'approve' });
      approvals++;
    } else await delay(50);
  }
  assert.equal(view.runs.find(run => run.role === 'coordinator').outcome, 'succeeded', JSON.stringify({ runs: view.runs, assignments: view.assignments, completion: view.completion, events: view.events.slice(0, 8) }));
  assert.ok(view.completion.complete, JSON.stringify(view.completion));
  assert.ok(maxActiveChildren <= 2);
  assert.deepEqual(view.assignments.map(item => [item.key, item.state]), [['alpha', 'integrated'], ['beta', 'integrated'], ['gamma', 'integrated']]);
  assert.equal(git(root.worktreePath, 'rev-list', '--count', `${baseHead}..HEAD`), '3');
  assert.equal(git(root.worktreePath, 'rev-list', '--merges', `${baseHead}..HEAD`), '');
  assert.equal(git(root.worktreePath, 'status', '--porcelain'), '');
  for (const name of ['alpha', 'beta', 'gamma']) assert.equal(await readFile(join(root.worktreePath, `${name}.txt`), 'utf8'), `${name} fixture\n${name} child change\n`);
  const combined = view.evidence.find(item => item.kind === 'combined');
  assert.ok(combined?.passed && combined.head === git(root.worktreePath, 'rev-parse', 'HEAD') && combined.tree === git(root.worktreePath, 'rev-parse', 'HEAD^{tree}') && combined.cleanupVerified, JSON.stringify(combined));
  assert.equal(view.budget.inFlight, 0); assert.equal(view.budget.unusedHolds, 0);
  assert.equal(view.budget.charged + view.budget.unallocated, view.budget.cap);

  // The source checkout is unchanged by both workflows.
  assert.equal(await readFile(join(source, 'README.md'), 'utf8'), '# Package fixture\n');
  assert.equal(git(source, 'status', '--porcelain'), '');
  assert.equal(git(source, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  child.stdin.end(); assert.equal(await exit, 0, errors);
  assert.ok((await stat(join(directory, 'data', 'workspace.db'))).size > 0);
  console.log(`PASS: packaged runtime loads SQLite v2, applies an approved edit and verified-cleanup command, and completes a coordinated workflow (${approvals} bound approvals, at most ${maxActiveChildren} active children, 3 serial cherry-picks, combined validation on the exact final tree) while preserving the source repository.`);
} finally {
  clearTimeout(watchdog);
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true });
}
