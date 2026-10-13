import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ORCHESTRATION_LIMITS } from '../../packages/protocol/src/limits';
import { assertAcyclic, covers, inScope, normalizeScope, normalizeScopePath, ordered, scopesOverlap } from '../../packages/runtime/src/scope';
import { isNetworkOrDevicePath } from '../../packages/runtime/src/network-path';

type Input = { operation: string; arguments: unknown[] };
const inputs: Input[] = [];
const add = (operation: string, ...args: unknown[]) => inputs.push({ operation, arguments: args });
const paths: (string | null)[] = [null, '', '/', '\\', '////', 'src\\feature\\', 'src///', '../x', 'a/../b', './a', 'a//b', '/abs', 'C:/x', 'C:x', 'é:/x', 'src2/file', '文件/é.txt', '😀/x', 'src/İ', 'src/K', 'src/ſ', ' leading', 'trailing ', 'trailing.', 'a:stream', '.git', '.GIT/config', 'src/.GIT/x', '.gitmodules', '.gitattributes', 'config/.env', 'keys/id_rsa', 'a\u2028.pem', '.env.\u2028', '.env\u2029', 'KEY', 'ſecret', 'secret.' + '😀'.repeat(40)];
const names = ['.env', '.envrc', '.npmrc', '.pypirc', '.netrc', '.pgpass', '.terraformrc', '.ssh', '.aws', '.azure', '.kube', '.docker', '.gnupg', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credential', 'credentials', 'secret', 'secrets', 'cert.pem', 'cert.key', 'cert.p12', 'cert.pfx', 'con', 'prn', 'aux', 'nul', ...Array.from({ length: 10 }, (_, i) => 'com' + i), ...Array.from({ length: 10 }, (_, i) => 'lpt' + i)];
for (const name of names) paths.push(name, name.toUpperCase(), 'src/' + name, name + '.bak', name + '.\u2028');
for (const character of ['\0', '\t', '\n', '\r', '\u001f', '*', '?', '"', '<', '>', '|']) paths.push('src/a' + character + 'b');
for (const path of paths) for (const allowRoot of [false, true]) add('normalizePath', path, allowRoot);
for (const values of [[], ['src', 'src'], ['src', 'SRC'], ['İ', 'i\u0307'], ['K', 'K'], ['ſ', 's'], ['😀', '\ue000', 'A', 'a'], ['', 'src'], Array.from({ length: ORCHESTRATION_LIMITS.maxScopePaths }, (_, i) => 'file' + i), Array.from({ length: ORCHESTRATION_LIMITS.maxScopePaths + 1 }, (_, i) => 'file' + i)]) for (const allowRoot of [false, true]) add('normalize', values, allowRoot);
for (const scope of ['', 'src', 'src/a.ts', 'src/a', 'docs', 'İ', 'K']) for (const candidate of ['src/a.ts', 'SRC/A.ts', 'src2/a.ts', 'src/a.ts.bak', 'src\\a.ts', '../x', '.env', 'docs/.env', 'docs/../secrets.txt', 'docs/guide.md', 'i\u0307/file', 'k/file']) {
  add('covers', scope, candidate); add('inScope', [scope], candidate);
}
for (const [left, right] of [[['src'], ['src/a.ts']], [['src/a.ts'], ['SRC']], [['src/a'], ['src/ab']], [[], ['src']], [[''], ['docs']], [['K'], ['k/file']]]) add('overlap', left, right);
const graphs: [string, string[]][][] = [[], [['a', []]], [['a', ['a']]], [['a', ['b']], ['b', ['a']]], [['a', ['missing']]], [['a', []], ['b', ['a']], ['c', ['b']], ['d', []]], [['a', ['b', 'c']], ['b', ['d']], ['c', ['d']], ['d', []]]];
for (const graph of graphs) {
  add('acyclic', graph);
  for (const [a, b] of [['a', 'a'], ['a', 'b'], ['a', 'c'], ['b', 'c'], ['a', 'd'], ['missing', 'a']]) add('ordered', graph, a, b);
}
for (const value of ['\\\\server\\share\\project', '//server/share/project', '\\/server/share', '/\\server/share', '\\\\?\\UNC\\server\\share', '\\\\?\\C:\\local', '\\\\.\\pipe\\name', '\\\\.\\C:\\local', '\\\\.\\UNC\\server\\share', '\\\\;LanmanRedirector\\;Z:0\\server\\share', '\\\\host@SSL\\DavWWWRoot\\project', '\\??\\UNC\\server\\share', '\\??\\C:\\local', '/??/UNC/server/share', '\\??/C:/local', 'C:\\projects\\app', 'c:/projects/app', '\\projects\\app', '/projects/app', 'relative\\path', 'C:relative', '', ' \\\\server\\share', '?\\??\\x']) add('network', value);

function evaluate(input: Input): unknown {
  const [a, b, c] = input.arguments;
  const edges = () => new Map(a as [string, string[]][]);
  switch (input.operation) {
    case 'normalizePath': return normalizeScopePath(a as string, b as boolean);
    case 'normalize': return normalizeScope(a as string[], b as boolean);
    case 'covers': return covers(a as string, b as string);
    case 'inScope': return inScope(a as string[], b as string);
    case 'overlap': return scopesOverlap(a as string[], b as string[]);
    case 'acyclic': assertAcyclic(edges()); return null;
    case 'ordered': return ordered(edges(), b as string, c as string);
    case 'network': return isNetworkOrDevicePath(a as string);
    default: throw new Error('Unknown security operation');
  }
}
it('pins all P2 policy outcomes to the shipping Node authority without ordinary regeneration', () => {
  const cases = inputs.map((input, index) => {
    let expected;
    try { expected = { value: evaluate(input) }; }
    catch (error) { if (!(error instanceof Error)) throw error; expected = { error: error.message }; }
    return { name: `${input.operation}:${index}`, ...input, expected };
  });
  const path = 'tests/p2/security-vectors.json';
  if (process.env.P2_WRITE_SECURITY === '1') writeFileSync(path, JSON.stringify(cases, null, 2) + '\n');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(cases);
});
