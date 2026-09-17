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
const environment = { ELECTRON_RUN_AS_NODE: '1', FOUNDRY_WORKSPACE_DATA: join(directory, 'data') };
for (const key of ['SystemRoot', 'PATH', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE']) if (process.env[key]) environment[key] = process.env[key];
let child; let errors = ''; let sequence = 0; let watchdog;
const pending = new Map();
try {
  await stat(executable);
  const source = join(directory, 'source');
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { windowsHide: true });
  execFileSync('git', ['init', '-q', source], { windowsHide: true });
  git('config', 'user.name', 'Package Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, 'README.md'), '# Package fixture\n'); git('add', '.'); git('commit', '-qm', 'fixture');
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
  watchdog = setTimeout(() => { child.kill(); }, 60000);
  const invoke = (method, params) => new Promise((resolve, reject) => {
    const id = String(++sequence); pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const snapshot = await invoke('workspace.snapshot', {});
  assert.equal(snapshot.runtime, 'ready'); assert.equal(snapshot.profiles[0]?.apiKind, 'fake');
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
  assert.equal(await readFile(join(source, 'README.md'), 'utf8'), '# Package fixture\n');
  assert.equal(git('status', '--porcelain').toString().trim(), '');
  child.stdin.end(); assert.equal(await exit, 0, errors);
  assert.ok((await stat(join(directory, 'data', 'workspace.db'))).size > 0);
  console.log('PASS: packaged runtime loads SQLite, persists coding history, applies an approved edit, runs the unpacked Windows Job helper with verified cleanup, and preserves the source repository.');
} finally {
  clearTimeout(watchdog);
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true });
}
