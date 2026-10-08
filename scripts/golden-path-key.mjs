// Mirrors pathKey in packages/runtime/src/store.ts for cross-language tests: the C# FinalPath port compares its
// keys with this script's on the same machine. tests/golden/path-key.test.ts guards the mirror against drift.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const canonicalPath = path => { const absolute = resolve(path); try { return realpathSync.native(absolute); } catch { return absolute; } };
export const pathKey = path => process.platform === 'win32' ? canonicalPath(path).toLocaleLowerCase('en-US') : canonicalPath(path);

// As a command: reads a JSON array of paths on stdin and writes [{ input, canonical, key }] to stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  const paths = JSON.parse(text);
  process.stdout.write(JSON.stringify(paths.map(path => ({ input: path, canonical: canonicalPath(path), key: pathKey(path) }))));
}
