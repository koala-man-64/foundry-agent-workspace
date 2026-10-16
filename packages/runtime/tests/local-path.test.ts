import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLocalPath } from '../src/repository.js';

const DIFFERENT = 'The saved folder now resolves to a different location.';
const scratches: string[] = [];

function scratch(): string {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-local-path-')));
  scratches.push(directory);
  return directory;
}

/** The 8.3 spelling Windows generated for an existing entry, or the long name when the volume has short names disabled. */
function shortName(entry: string): string {
  // Verbatim, so cmd receives the quoted path and %~sI unescaped.
  const result = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${entry}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  if (result.status !== 0) throw new Error(`Short-name lookup failed: ${result.stderr}`);
  return result.stdout.trim();
}

afterEach(() => {
  for (const directory of scratches.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('resolveLocalPath approved spelling', () => {
  it('accepts an 8.3 or case spelling of the approved folder when no link is traversed', context => {
    const long = path.join(scratch(), 'foundry long project name');
    fs.mkdirSync(path.join(long, 'nested folder name'), { recursive: true });
    const short = shortName(long);
    if (short.toLowerCase() === long.toLowerCase()) context.skip('8.3 short names are disabled on this volume.');
    const nestedShort = shortName(path.join(long, 'nested folder name'));
    expect(resolveLocalPath(short, short)).toBe(long);
    expect(resolveLocalPath(long, short)).toBe(long);
    expect(resolveLocalPath(short, long)).toBe(long);
    expect(resolveLocalPath(long.toUpperCase(), long.toUpperCase())).toBe(long);
    expect(resolveLocalPath(nestedShort, nestedShort)).toBe(path.join(long, 'nested folder name'));
  });

  it('still refuses an approved spelling that reaches its folder through a junction', context => {
    const base = scratch();
    const target = path.join(base, 'actual target folder');
    const link = path.join(base, 'replaced junction name');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'junction');
    const short = shortName(link);
    if (short.toLowerCase() === link.toLowerCase()) context.skip('8.3 short names are disabled on this volume.');
    expect(() => resolveLocalPath(short, short)).toThrow(DIFFERENT);
    expect(() => resolveLocalPath(link, link)).toThrow(DIFFERENT);
    // A short spelling under a junction ancestor is an alias even when the leaf is a real folder.
    fs.mkdirSync(path.join(target, 'inner folder name'));
    const innerShort = shortName(path.join(link, 'inner folder name'));
    expect(() => resolveLocalPath(innerShort, innerShort)).toThrow(DIFFERENT);
    fs.rmSync(link);
  });

  it('refuses an approved short spelling of a different real folder', context => {
    const base = scratch();
    const approved = path.join(base, 'approved project folder');
    const other = path.join(base, 'other project folder');
    fs.mkdirSync(approved); fs.mkdirSync(other);
    const short = shortName(approved);
    if (short.toLowerCase() === approved.toLowerCase()) context.skip('8.3 short names are disabled on this volume.');
    expect(() => resolveLocalPath(other, short)).toThrow(DIFFERENT);
    expect(() => resolveLocalPath(shortName(other), short)).toThrow(DIFFERENT);
    expect(() => resolveLocalPath(approved, path.join(base, 'missing project folder'))).toThrow(DIFFERENT);
  });
});
