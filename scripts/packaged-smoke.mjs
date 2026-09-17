import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import console from 'node:console';

const directory = await mkdtemp(join(tmpdir(), 'foundry-package-smoke-'));
const executable = resolve('release/win-unpacked/Foundry Agent Workspace.exe');
const runtime = resolve('release/win-unpacked/resources/app.asar/out/main/runtime.js');
const environment = { ELECTRON_RUN_AS_NODE: '1', FOUNDRY_WORKSPACE_DATA: directory };
for (const key of ['SystemRoot', 'PATH', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE']) if (process.env[key]) environment[key] = process.env[key];
let child;
try {
  await stat(executable);
  child = spawn(executable, [runtime], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 'smoke', method: 'workspace.snapshot', params: {} }) + '\n');
  const exit = await new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged runtime timed out.')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); accept(code); });
  });
  assert.equal(exit, 0, errors);
  const response = output.trim().split('\n').map(line => JSON.parse(line)).find(value => value.id === 'smoke');
  assert.equal(response?.result?.runtime, 'ready', output);
  assert.equal(response.result.profiles[0]?.apiKind, 'fake');
  assert.ok((await stat(join(directory, 'workspace.db'))).size > 0);
  console.log('PASS: packaged Electron launches the stdio runtime, loads bundled SQLite, and persists a snapshot.');
} finally { if (child && child.exitCode === null) child.kill(); await rm(directory, { recursive: true, force: true }); }
