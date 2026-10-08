// Generates tests/fixtures/databases for the WPF migration (docs/wpf-webview2-migration.md, P0). Each schema era's
// real runtime is built from its commit and driven over stdio JSON-RPC against ONE shared data directory, upgrading
// forward with each era's own confirmation flow. The final database therefore carries every era's row shapes, like a
// long-lived user profile. Run manually (needs network for pnpm install, several minutes); never in CI.
//
//   node scripts/fixtures/generate-fixture-databases.mjs
//
// The scratch root is name-free (default %ProgramData%\FoundryFixtures) so no user path reaches the fixtures, and every
// output is scanned for the user name and profile path before it is kept.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const output = join(repository, 'tests', 'fixtures', 'databases');
const root = process.env.FOUNDRY_FIXTURE_ROOT ?? join(process.env.ProgramData ?? os.tmpdir(), 'FoundryFixtures');
const MARKER = '.foundry-fixture-root';
const ERAS = [
  { name: 'v1', commit: 'f75d1ed' }, // 0.2.0 layout, before schema versioning
  { name: 'v2', commit: '2b42bb7' }, // orchestration, channel, MCP, publication
  { name: 'v3', commit: 'cdec0a3' }, // saved projects and drafts
  { name: 'v4', commit: '0212982' }, // usage analytics and effort
  { name: 'v5', commit: 'HEAD' },    // personal workspace expansion
];
const PROFILE_ID = '00000000-0000-4000-8000-0000000000e1';
const VALIDATION = { command: "$files = @(Get-ChildItem -File -Filter *.txt); if ($files.Count -lt 3) { exit 1 }; Write-Output ('validated ' + $files.Count)", cwd: '', timeoutMs: 60000 };

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** Extract a commit's tree, install its locked dependencies and build its runtime once; reuse builds across runs. */
async function buildEra(era) {
  const commit = git(repository, 'rev-parse', era.commit);
  const directory = join(root, 'builds', `${era.name}-${commit.slice(0, 7)}`);
  const runtime = join(directory, 'out', 'main', 'runtime.js');
  if (existsSync(runtime)) return { ...era, commit, directory, runtime };
  await mkdir(directory, { recursive: true });
  const archive = join(root, 'builds', `${era.name}.tar`);
  run('git', ['-C', repository, 'archive', '--format=tar', '-o', archive, commit]);
  run(process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xf', archive, '-C', directory]);
  await rm(archive);
  run(pnpm, ['install', '--frozen-lockfile'], { cwd: directory, shell: process.platform === 'win32' });
  run(pnpm, ['build'], { cwd: directory, shell: process.platform === 'win32' });
  assert.ok(existsSync(runtime), `${era.name} did not build out/main/runtime.js`);
  return { ...era, commit, directory, runtime };
}

/** A runtime process driven over stdio JSON-RPC, as the desktop host drives it. */
function startRuntime(runtimePath, data) {
  const profile = join(root, 'profile');
  const env = {
    FOUNDRY_WORKSPACE_DATA: data, FOUNDRY_WORKSPACE_ENABLE_COORDINATED: '1',
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT,
    // Synthetic profile and temp directories keep user paths and global Git configuration out of the fixtures.
    USERPROFILE: profile, HOME: profile, APPDATA: join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: join(profile, 'AppData', 'Local'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
  };
  const child = spawn(process.execPath, [runtimePath], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0; let buffer = ''; let errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      if (message.method === 'browser.host') { // No browser exists in a headless fixture run.
        const reply = message.params.kind === 'tabs' ? { result: [] } : message.params.kind === 'revoke' ? { result: null } : { error: { code: 'stale', message: 'No browser window exists in this fixture run.' } };
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, method: 'browser.host.result', ...reply }) + '\n');
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result); }
    }
  });
  const exit = new Promise(accept => child.once('close', code => { for (const waiter of pending.values()) waiter.reject(new Error(`Runtime exited ${code}: ${errors}`)); pending.clear(); accept(code); }));
  const invoke = (method, params) => new Promise((accept, reject) => {
    const id = String(++sequence); pending.set(id, { resolve: accept, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const stop = async () => { child.stdin.end(); const timer = setTimeout(() => child.kill(), 30000); try { return await exit; } finally { clearTimeout(timer); } };
  const kill = async () => { child.kill('SIGKILL'); await exit; };
  return { invoke, stop, kill, errors: () => errors };
}

async function until(label, check, attempts = 600) {
  for (let attempt = 0; attempt < attempts; attempt++) { const value = await check(); if (value) return value; await delay(100); }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Task detail for v1-v4, which expose task.get (v5 replaced it; the v5 scenario reads through verifyExpansion). */
const legacyDetail = runtime => async taskId => runtime.invoke('task.get', { taskId });

/** Decide every one-shot approval the offline demo proposes until the task stops running. */
async function settle(runtime, detail, taskId, decision) {
  return until(`task ${taskId} to settle`, async () => {
    const current = await detail(taskId);
    const waiting = (current.approvals ?? []).find(item => item.state === 'awaiting-approval');
    if (waiting) { await runtime.invoke('approval.decide', { taskId, approvalId: waiting.id, nonce: waiting.nonce, decision }); return false; }
    return current.task.status !== 'running' && current;
  });
}

async function chat(runtime, detail, input, messages) {
  const task = await runtime.invoke('task.create', { ...input, mode: 'chat' });
  for (const content of messages) { await runtime.invoke('task.send', { taskId: task.id, content }); await settle(runtime, detail, task.id, 'approve'); }
  return task;
}

/** Coordinated root through the orchestration fixture, approving each bound decision. In the v2 era a child's approvals
 * are visible only through orchestration.child, as the era's own packaged smoke reads them. */
async function coordinate(runtime, detail, base, title) {
  const root = await runtime.invoke('task.create', { ...base, title, mode: 'coordinated', tokenBudget: 600000, coordination: { childProfileIds: [], requiredValidation: VALIDATION } });
  await runtime.invoke('task.send', { taskId: root.id, content: '/orchestrate-demo' });
  await until('the coordinator to finish', async () => {
    const view = await runtime.invoke('orchestration.get', { rootTaskId: root.id });
    if (view.runs.find(item => item.role === 'coordinator').lifecycle === 'terminal') return true;
    const candidates = [...((await detail(root.id)).approvals ?? [])];
    for (const child of view.runs.filter(item => item.role === 'child' && item.lifecycle !== 'terminal')) candidates.push(...((await runtime.invoke('orchestration.child', { rootTaskId: root.id, childTaskId: child.taskId })).approvals ?? []));
    const next = candidates.find(item => item.state === 'awaiting-approval');
    if (next) await runtime.invoke('orchestration.decide', { rootTaskId: root.id, taskId: next.taskId, approvalId: next.id, nonce: next.nonce, assignmentId: next.assignmentId ?? null, generation: next.generation, fingerprint: next.fingerprint, decision: 'approve' });
    return false;
  }, 3000);
  return root;
}

const scenarios = {
  async v1(runtime, context) {
    const detail = legacyDetail(runtime);
    const { profiles } = await runtime.invoke('workspace.snapshot', {});
    context.fake = profiles[0].id;
    await runtime.invoke('profile.save', { id: PROFILE_ID, name: 'Azure fixture', apiKind: 'responses', endpoint: 'https://contoso.openai.azure.com', deployment: 'gpt-fixture', contextLimit: 128000, outputLimit: 4096 });
    const base = { projectPath: context.source, profileId: context.fake, tokenBudget: 200000 };
    await chat(runtime, detail, { ...base, title: 'v1 chat' }, ['Hello from the v1 era', 'Unicode \u00e9 \u6f22\u5b57 \u{1F600} and a CRLF\r\nline']);
    for (const [title, decision] of [['v1 coding approved', 'approve'], ['v1 coding rejected', 'reject']]) {
      const task = await runtime.invoke('task.create', { ...base, title, mode: 'coding' });
      await runtime.invoke('task.send', { taskId: task.id, content: '/demo' });
      await settle(runtime, detail, task.id, decision);
    }
  },
  async v2(runtime, context) {
    const detail = legacyDetail(runtime);
    assert.equal((await runtime.invoke('workspace.schema', {})).upgradeRequired, true);
    await runtime.invoke('workspace.upgrade', { confirm: 'backup-and-upgrade' });
    const base = { projectPath: context.source, profileId: context.fake, tokenBudget: 200000 };
    await coordinate(runtime, detail, base, 'v2 coordinated');
    const sender = await chat(runtime, detail, { ...base, title: 'v2 channel sender' }, ['/channel-demo Hello team from v2']);
    const peer = await chat(runtime, detail, { ...base, title: 'v2 channel peer' }, ['Ready to receive']);
    await runtime.invoke('channel.send', { taskId: peer.id, requestId: randomUUID(), recipientTaskId: sender.id, content: 'Direct reply from the peer' });
    const compacted = await chat(runtime, detail, { ...base, title: 'v2 compacted chat' }, ['alpha '.repeat(40).trim(), 'beta '.repeat(40).trim(), 'gamma '.repeat(40).trim()]);
    await runtime.invoke('task.compact', { taskId: compacted.id, keepRecent: 2 });
    await runtime.invoke('mcp.save', { id: '00000000-0000-4000-8000-0000000000e2', key: 'fixture', name: 'Fixture server', command: process.execPath, arguments: [context.mcpServer], cwd: '', environment: { MCP_FIXTURE_NOTES: join(root, 'notes.txt') }, enabled: true, readOnlyTools: ['echo'], callTimeoutMs: 30000 });
    const mcp = await runtime.invoke('task.create', { ...base, title: 'v2 MCP demo', mode: 'coding' });
    await runtime.invoke('task.send', { taskId: mcp.id, content: '/mcp-demo' });
    await settle(runtime, detail, mcp.id, 'approve');
    const published = await chat(runtime, detail, { ...base, title: 'v2 published and retired' }, ['Prepare a commit']);
    await writeFile(join(published.worktreePath, 'fixture-note.txt'), 'committed from the v2 fixture\n');
    await runtime.invoke('task.commit', { taskId: published.id, message: 'Fixture commit' });
    await runtime.invoke('task.retire', { taskId: published.id, confirm: 'retire' });
  },
  async v3(runtime, context) {
    const detail = legacyDetail(runtime);
    await runtime.invoke('workspace.upgrade', { confirm: 'backup-and-upgrade' });
    const project = await runtime.invoke('project.add', { path: context.source });
    const folder = await runtime.invoke('project.add', { path: context.plain });
    await runtime.invoke('project.update', { projectId: folder.id, name: 'Fixture notes', hidden: true });
    await runtime.invoke('project.update', { projectId: folder.id, hidden: false });
    for (const projectId of [project.id, folder.id, null]) {
      const task = await runtime.invoke('task.start', { requestId: randomUUID(), projectId, content: `v3 draft for ${projectId ?? 'no project'}`, profileId: context.fake, mode: 'chat', tokenBudget: 100000 });
      await settle(runtime, detail, task.id, 'approve');
    }
    await runtime.invoke('workspace.preferences.save', { profileId: context.fake, mode: 'coding', collapsedProjectIds: [folder.id] });
  },
  async v4(runtime, context) {
    const detail = legacyDetail(runtime);
    await runtime.invoke('workspace.upgrade', { confirm: 'backup-and-upgrade' });
    await runtime.invoke('profile.save', { id: PROFILE_ID, name: 'Azure fixture', apiKind: 'responses', endpoint: 'https://contoso.openai.azure.com', deployment: 'gpt-fixture', contextLimit: 128000, outputLimit: 4096, effort: 'low' });
    await chat(runtime, detail, { projectPath: context.source, profileId: context.fake, tokenBudget: 200000, title: 'v4 usage chat' }, ['First v4 request', 'Second v4 request']);
  },
  async v5(runtime, context, restart) {
    await runtime.invoke('workspace.upgrade', { confirm: 'backup-and-upgrade' });
    const { verifyExpansion } = await import(new URL('../expansion-smoke.mjs', import.meta.url).href);
    await verifyExpansion({ invoke: (method, params) => context.runtime.invoke(method, params), crashAndRestart: restart, source: context.source, directory: root, profileId: context.fake }); // directory is the parent of data, as packaged-smoke passes it
  },
};

/** Copy a stopped runtime's database, checkpointing a leftover WAL so ordinary fixtures are single files. */
async function snapshot(data, name, { keepWal = false } = {}) {
  const target = join(output, name);
  await rm(target, { recursive: true, force: true }); await mkdir(target, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(join(data, `workspace.db${suffix}`))) await copyFile(join(data, `workspace.db${suffix}`), join(target, `workspace.db${suffix}`));
  if (!keepWal && existsSync(join(target, 'workspace.db-wal'))) {
    const database = new Database(join(target, 'workspace.db')); database.pragma('wal_checkpoint(TRUNCATE)'); database.close();
    for (const suffix of ['-wal', '-shm']) await rm(join(target, `workspace.db${suffix}`), { force: true });
  }
}

/** Fail if any fixture byte sequence reveals the user name or profile path (UTF-8 or UTF-16LE). */
async function assertNoPersonalData() {
  const needles = [os.userInfo().username, process.env.USERPROFILE].filter(value => value && value.length >= 3).map(value => value.toLowerCase());
  for (const name of await readdir(output, { recursive: true })) {
    const path = join(output, name);
    if (!(await stat(path)).isFile()) continue;
    const bytes = await readFile(path);
    const views = [bytes.toString('latin1').toLowerCase(), bytes.toString('utf16le').toLowerCase()];
    for (const needle of needles) assert.ok(!views.some(view => view.includes(needle)), `${name} contains a personal path or user name.`);
  }
}

async function main() {
  if (existsSync(root) && !existsSync(join(root, MARKER))) throw new Error(`${root} exists and is not a fixture root; refusing to use it.`);
  await mkdir(root, { recursive: true }); await writeFile(join(root, MARKER), 'Scratch root for scripts/fixtures/generate-fixture-databases.mjs\n');
  for (const name of ['data', 'source', 'plain', 'expansion', 'tmp', 'profile']) await rm(join(root, name), { recursive: true, force: true });
  for (const name of ['tmp', 'profile', 'expansion', 'plain']) await mkdir(join(root, name), { recursive: true });
  const context = { source: join(root, 'source'), plain: join(root, 'plain'), mcpServer: join(root, 'mcp-fixture-server.mjs') };
  await copyFile(join(repository, 'tests', 'fixtures', 'mcp-fixture-server.mjs'), context.mcpServer);
  await writeFile(join(context.plain, 'notes.txt'), 'Fixture read-only folder.\n');
  execFileSync('git', ['init', '-q', '-b', 'main', context.source], { windowsHide: true });
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['core.autocrlf', 'false']]) git(context.source, 'config', key, value);
  await writeFile(join(context.source, 'README.md'), '# Fixture project\n');
  for (const name of ['alpha', 'beta', 'gamma']) await writeFile(join(context.source, `${name}.txt`), `${name} fixture\n`);
  git(context.source, 'add', '.'); git(context.source, 'commit', '-qm', 'Fixture');

  const data = join(root, 'data');
  for (const era of ERAS) {
    const built = await buildEra(era);
    console.log(`\n=== ${era.name} (${built.commit.slice(0, 7)}) ===`);
    context.runtime = startRuntime(built.runtime, data);
    const restart = async () => { await context.runtime.kill(); context.runtime = startRuntime(built.runtime, data); await until('the runtime to reopen', async () => context.runtime.invoke(era.name === 'v5' ? 'workspace.summary' : 'workspace.snapshot', {}).then(() => true, () => false)); };
    await scenarios[era.name](context.runtime, context, restart);
    assert.equal(await context.runtime.stop(), 0, context.runtime.errors());
    await snapshot(data, era.name);
  }
  // The last fixture continues v5 and stops abruptly: committed but uncheckpointed WAL pages and a response still marked
  // running, which the next open must recover.
  const latest = await buildEra(ERAS.at(-1));
  const runtime = startRuntime(latest.runtime, data);
  const task = await runtime.invoke('task.create', { title: 'v5 interrupted chat', projectPath: context.source, profileId: context.fake, mode: 'chat', tokenBudget: 100000 });
  await runtime.invoke('task.send', { taskId: task.id, content: 'Interrupted while streaming' });
  await runtime.kill();
  await snapshot(data, 'v5-wal', { keepWal: true });
  await assertNoPersonalData();
  console.log(`\nWrote fixtures to ${output}. Regenerate expected-after-open.json with UPDATE_GOLDEN=1 (tests/golden/fixture-databases.test.ts).`);
}

await main();
