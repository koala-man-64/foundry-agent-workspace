import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';
import console from 'node:console';

{
  assert.equal(process.platform, 'win32', 'The portable smoke test requires Windows');
  const script = fileURLToPath(import.meta.url);
  const root = resolve(dirname(script), '..');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const executable = join(root, 'release', `Foundry-Agent-Workspace-Portable-${manifest.version}-x64.exe`);
  await access(executable);
  const directory = await mkdtemp(join(tmpdir(), 'foundry-portable-smoke-'));
  const result = join(directory, 'result.json');
  const probe = join(directory, 'probe.cjs');
  // Start only the verification script in bundled Electron, with isolated extraction and no app profile.
  const environment = { ELECTRON_RUN_AS_NODE: '1', TEMP: directory, TMP: directory, FOUNDRY_PORTABLE_SMOKE_RESULT: result };
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'LOCALAPPDATA', 'USERPROFILE']) if (process.env[key]) environment[key] = process.env[key];
  try {
    // Report probe failures through a file because the Windows launcher does not relay stderr.
    await writeFile(probe, `
const assert = require('node:assert/strict');
const { dirname, join } = require('node:path');
const { writeFileSync, accessSync } = require('node:fs');
const { createRequire } = require('node:module');
try {
  assert.ok(process.versions.electron, 'The launcher must run bundled Electron');
  assert.ok(process.env.PORTABLE_EXECUTABLE_FILE, 'Portable launcher identity is missing');
  const archive = join(dirname(process.execPath), 'resources', 'app.asar');
  accessSync(join(archive, 'package.json'));
  const Database = createRequire(join(archive, 'package.json'))('better-sqlite3');
  const database = new Database(':memory:');
  try { assert.equal(database.prepare('SELECT 42 AS answer').get().answer, 42); }
  finally { database.close(); }
  writeFileSync(process.env.FOUNDRY_PORTABLE_SMOKE_RESULT, JSON.stringify({ electron: process.versions.electron, platform: process.platform, arch: process.arch, sqlite: true }));
} catch (error) {
  writeFileSync(process.env.FOUNDRY_PORTABLE_SMOKE_RESULT, JSON.stringify({ error: error.stack }));
  process.exitCode = 1;
}
`);
    try {
      await promisify(execFile)(executable, [probe], { cwd: directory, env: environment, windowsHide: true, timeout: 120000 });
    } catch (error) {
      const detail = await readFile(result, 'utf8').catch(() => 'No diagnostic was written by the extracted application.');
      throw new Error(`Portable launcher failed: ${detail}`, { cause: error });
    }
    assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), { electron: manifest.devDependencies.electron, platform: 'win32', arch: 'x64', sqlite: true });
    console.log(`PASS: portable EXE extracts and launches bundled Electron ${manifest.devDependencies.electron} with working SQLite on Windows x64.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
