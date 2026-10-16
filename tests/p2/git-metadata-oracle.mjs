// Pure lexical oracle. --write updates only this script's adjacent, committed test corpus.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { log } from 'node:console';

const root = new URL('../../', import.meta.url);
const corpusPath = new URL('git-metadata-vectors.json', import.meta.url);
const sourcePaths = ['packages/runtime/src/repository.ts', 'packages/runtime/src/network-path.ts'];
const sourceBytes = sourcePaths.map(path => readFileSync(new URL(path, root)));
const [repository, network] = sourceBytes.map(bytes => bytes.toString('utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pointerPattern = repository.match(/const gitdir = (\/.*\/)\.exec\(metadata\(gitDirectory\)\);/)?.[1];
const networkPattern = network.match(/const NETWORK_OR_DEVICE = (\/.*\/);/)?.[1];
const maximumBytes = Number(repository.match(/statSync\(safe\)\.size > (\d+)/)?.[1]);
assert.ok(pointerPattern && networkPattern && maximumBytes === 16_384, 'Oracle source anchors changed.');
assert.ok(repository.includes("return fsSync.readFileSync(safe, 'utf8').trim();"));
assert.ok(repository.includes('const pointer = localExists(common) ? metadata(common) : undefined;'));
assert.ok(repository.includes('if (pointer && isNetworkOrDevicePath(pointer))'));
const pointerSyntax = new RegExp(pointerPattern.slice(1, -1));
const networkSyntax = new RegExp(networkPattern.slice(1, -1));
const invalidMetadata = 'Invalid Git project metadata.';
const networkError = 'Projects on network shares are not supported.';

function evaluate(kind, input) {
  if (input.length > maximumBytes) return { error: invalidMetadata };
  const text = input.toString('utf8').trim();
  let reference;
  if (kind === 'gitdir') {
    const match = pointerSyntax.exec(text);
    if (!match) return { error: invalidMetadata };
    reference = match[1];
  } else {
    reference = text || null;
  }
  if (reference && networkSyntax.test(reference)) return { error: networkError };
  return { value: reference };
}

const vectors = [];
function add(name, kind, input) {
  const bytes = Buffer.concat(input.map(part => part.text !== undefined ? Buffer.from(part.text, 'utf8')
    : Buffer.from(part.hex.repeat(part.count ?? 1), 'hex')));
  vectors.push({ name, kind, input, expected: evaluate(kind, bytes) });
}
function textCase(name, kind, text) { add(name, kind, [{ text }]); }
for (const kind of ['gitdir', 'commondir']) {
  const prefix = kind === 'gitdir' ? 'gitdir: ' : '';
  for (const [name, text] of [
    ['relative', '../shared/.git'], ['drive-absolute', 'C:\\local repo\\.git'],
    ['drive-relative', 'C:relative'], ['root-relative', '\\relative'], ['forward-root-relative', '/relative'],
    ['unicode', '../日本語 😀/repo'], ['dot-segments', '../a/../b'], ['uri-looking', 'file://host/path'],
    ['extra-space', ' leading'], ['interior-bom', 'a\ufeffb'], ['interior-nul', 'a\0b'],
    ['interior-tab', 'a\tb'], ['interior-cr', 'a\rb'], ['interior-lf', 'a\nb'],
    ['interior-ls', 'a\u2028b'], ['interior-ps', 'a\u2029b'], ['non-ecma-trim', '\u0085x\u0085'],
  ]) textCase(`${kind}-${name}`, kind, prefix + text);
  textCase(`${kind}-lf`, kind, prefix + '../git\n');
  textCase(`${kind}-crlf`, kind, prefix + '../git\r\n');
  textCase(`${kind}-whole-bom`, kind, '\ufeff' + prefix + '../git\ufeff');
  textCase(`${kind}-captured-bom`, kind, prefix + '\ufeff../git');
  const whitespace = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  for (const [index, char] of [...whitespace].entries()) textCase(`${kind}-trim-${index}`, kind, char + prefix + '../git' + char);
  for (const first of ['\\', '/']) for (const second of ['\\', '/']) {
    textCase(`${kind}-unc-${first.charCodeAt(0)}-${second.charCodeAt(0)}`, kind, prefix + first + second + 'server/share');
    textCase(`${kind}-device-${first.charCodeAt(0)}-${second.charCodeAt(0)}`, kind, prefix + first + second + '.\\pipe\\name');
    textCase(`${kind}-extended-${first.charCodeAt(0)}-${second.charCodeAt(0)}`, kind, prefix + first + second + '?\\C:\\local');
    textCase(`${kind}-nt-${first.charCodeAt(0)}-${second.charCodeAt(0)}`, kind, prefix + first + '??' + second + 'C:\\local');
  }
  for (const text of ['', ' ', '\t\r\n', '\ufeff', '\u0085']) textCase(`${kind}-empty-${JSON.stringify(text)}`, kind, text);
  // Every single byte, plus invalid/truncated multi-byte sequences, is compared with actual Buffer decoding.
  for (let byte = 0; byte < 256; byte++) add(`${kind}-byte-${byte}`, kind, [{ text: prefix + 'a' }, { hex: byte.toString(16).padStart(2, '0') }, { text: 'b' }]);
  for (const hex of ['c0af', 'c1bf', 'e080af', 'eda080', 'edbfbf', 'f08080af', 'f4908080', 'f5808080', 'e282', 'f09f92', 'e228a1', 'f0288cbc', '80bf', 'efbbbf'])
    add(`${kind}-utf8-${hex}`, kind, [{ text: prefix + 'a' }, { hex }, { text: 'b' }]);
  const prefixBytes = Buffer.byteLength(prefix);
  add(`${kind}-limit`, kind, [{ text: prefix }, { hex: '78', count: maximumBytes - prefixBytes }]);
  add(`${kind}-over-limit`, kind, [{ text: prefix }, { hex: '78', count: maximumBytes - prefixBytes + 1 }]);
  add(`${kind}-multibyte-limit`, kind, [{ text: prefix }, { hex: 'c3a9', count: (maximumBytes - prefixBytes) / 2 }]);
  add(`${kind}-bom-limit`, kind, [{ hex: 'efbbbf' }, { text: prefix }, { hex: '78', count: maximumBytes - prefixBytes - 3 }]);
  add(`${kind}-truncated-limit`, kind, [{ text: prefix }, { hex: '78', count: maximumBytes - prefixBytes - 2 }, { hex: 'e282' }]);
}
for (const text of ['GITDIR: x', 'Gitdir: x', 'gitdir:x', 'gitdir:\tx', 'gitdir: ', 'gitdir: \r\n', 'prefix gitdir: x', 'gitdir: x\ny', 'gitdir: x\ry', 'gitdir: x\u2028y', 'gitdir: x\u2029y'])
  textCase(`gitdir-syntax-${JSON.stringify(text)}`, 'gitdir', text);
textCase('commondir-no-pointer-grammar', 'commondir', 'gitdir: ../git');
textCase('commondir-leading-nel-before-unc', 'commondir', '\u0085\\\\server\\share');
textCase('gitdir-captured-space-before-unc', 'gitdir', 'gitdir:  \\\\server\\share');

const sources = sourcePaths.map((path, index) => ({ path, sha256: sha256(sourceBytes[index]) }));
const oracle = { nodeVersion: process.version, sources, pointerPattern, networkPattern, maximumBytes };
assert.equal(new Set(vectors.map(item => item.name)).size, vectors.length);
if (process.argv.length === 3 && process.argv[2] === '--write') {
  writeFileSync(corpusPath, JSON.stringify({ schemaVersion: 1, oracle, vectors }, null, 2) + '\n');
} else {
  assert.equal(process.argv.length, 2, 'Use no arguments to verify, or --write to regenerate.');
  const committed = JSON.parse(readFileSync(corpusPath, 'utf8'));
  assert.equal(committed.schemaVersion, 1);
  const { nodeVersion: generatedWith, ...committedOracle } = committed.oracle;
  const { nodeVersion: currentNode, ...currentOracle } = oracle;
  assert.deepEqual(committedOracle, currentOracle);
  assert.deepEqual(committed.vectors, vectors);
  log(JSON.stringify({ nodeVersion: currentNode, generatedWith, vectors: vectors.length, corpusSha256: sha256(readFileSync(corpusPath)), scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), sources }));
}
