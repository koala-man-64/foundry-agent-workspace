import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathKey as runtimePathKey } from '../../packages/runtime/src/store';
import { pathKey as mirroredPathKey } from '../../scripts/golden-path-key.mjs';

// path_key values are machine-dependent, so they are compared live rather than checked in. The C# port runs
// scripts/golden-path-key.mjs on the same tree; this test proves that script still matches the runtime.
const script = fileURLToPath(new URL('../../scripts/golden-path-key.mjs', import.meta.url));
let root = '';
let paths: string[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'foundry-path-key-'));
  const mixed = join(root, 'Mixed Case Dir');
  mkdirSync(join(mixed, 'Nested'), { recursive: true });
  writeFileSync(join(mixed, 'File.TXT'), 'fixture');
  mkdirSync(join(root, 'Ünïcödé'));
  mkdirSync(join(root, 'İstanbul'));
  symlinkSync(mixed, join(root, 'junction'), 'junction');
  paths = [
    root, mixed, join(mixed, 'File.TXT'), join(root, 'mixed case dir', 'file.txt'), join(root, 'junction'), join(root, 'junction', 'Nested'),
    join(root, 'Ünïcödé'), join(root, 'İstanbul'), join(mixed, 'Nested', '..', 'File.TXT'),
    `${mixed.replaceAll('\\', '/')}/Nested`, join(root, 'missing', 'Child'), `${join(mixed, 'Nested')}\\`,
  ];
});

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('path_key mirror for the WPF migration', () => {
  it('matches the runtime pathKey for every probed path', () => {
    for (const path of paths) expect(mirroredPathKey(path), path).toBe(runtimePathKey(path));
  });

  it('matches the runtime pathKey through its command interface', () => {
    const output = JSON.parse(execFileSync(process.execPath, [script], { input: JSON.stringify(paths), encoding: 'utf8', windowsHide: true })) as { input: string; key: string }[];
    expect(output.map(item => item.input)).toEqual(paths);
    for (const item of output) expect(item.key, item.input).toBe(runtimePathKey(item.input));
  });
});
