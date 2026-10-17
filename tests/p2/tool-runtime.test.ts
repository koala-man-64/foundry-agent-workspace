import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Task, ToolCall } from '../../packages/protocol/src/index';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { TOOL_DEFINITIONS, ToolArguments, type ToolName } from '../../packages/runtime/src/tool-definitions';
import type { ToolRuntime } from '../../packages/runtime/src/tool-runtime';
import { build, committed, file, sha256File, type Step, withIsolatedGit } from './repository-fixture';

// The coding tools of the shipping TypeScript runtime (tool-definitions.ts, tool-runtime.ts and repository.ts search),
// pinned for the C# port (ToolRuntimeTests): the advertised definitions byte for byte; zod's parse of every tool's
// arguments, with its exact issue text; search over disposable trees; and tool calls of ordinary tasks through the
// shipping RuntimeService's ToolRuntime, with their one-shot decisions, cancellations, approval rows and events, over
// disposable Git repositories with real Windows PowerShell 5.1 commands. Values written as { $repeat: [text, count] }
// expand to text repeated. Outputs are cleaned in one pass: scratch paths become {scratch} placeholders, the shell and
// SystemRoot become {shell} and {SystemRoot}, each approval fingerprint becomes {fingerprint:N} (an edit's hashes its
// absolute root and a command's is session-scoped; existing-file-edit.test.ts pins the edit formula),
// each random UUID becomes {uuid:N}, numbered in order of first appearance, and each timestamp becomes {time} (the clock
// is real: the command helper checks its parent's start time); then a string over 4,096 units becomes its length and
// SHA-256. Node's raw filesystem errors are recorded as { systemError }: native refuses with its own fixed message.
const stamp = '2026-01-02T03:04:05.678Z';
const id = (n: number) => `14141414-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rep = (text: string, count: number) => ({ $repeat: [text, count] });
const systemError = (message: string) => /^(E[A-Z]+): /.exec(message)?.[1];
const expand = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    const repeat = (value as { $repeat?: [string, number] }).$repeat;
    if (repeat) return repeat[0].repeat(repeat[1]);
    // JSON.parse keeps a "__proto__" key as an own property, as a provider's parsed arguments do.
    return JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]))));
  }
  return value;
};
const pin = (value: unknown): unknown => {
  if (typeof value === 'string') return value.length > 4096 ? { length: value.length, sha256: createHash('sha256').update(value, 'utf8').digest('hex') } : value;
  if (Array.isArray(value)) return value.map(pin);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pin(item)]));
  return value;
};

// Section 2: arguments. Each input is parsed by its tool's schema; the vector holds the parsed value or zod's message.
const hash = 'a'.repeat(64);
const strings = (field: string, extra: Record<string, unknown>, min: number | null, max: number) => [
  ...[null, true, 7, [], {}].map(bad => ({ ...extra, [field]: bad })),
  ...(min ? [{ ...extra, [field]: '' }, { ...extra, [field]: '\ud800' }] : [{ ...extra, [field]: '' }]),
  { ...extra, [field]: rep('x', max) }, { ...extra, [field]: rep('x', max + 1) },
  { ...extra, [field]: rep('\u{1F600}', max / 2) }, { ...extra, [field]: rep('\u{1F600}', max / 2 + 1) }, { ...extra, [field]: rep('\u{1F600}', max) }, { ...extra, [field]: rep('\u{1F600}', max + 1) },
  { ...extra, [field]: rep('\ud800', max) }, { ...extra, [field]: rep('\ud800', max + 1) }, { ...extra, [field]: rep('\udc00\ud800', max / 2 + 1) },
  { ...extra, [field]: rep('é', max / 2 + 1) },
];
const objects = [null, true, 3, 'x', [], [1]];
const argumentCases: { tool: ToolName; input: unknown }[] = [
  ...(Object.keys(ToolArguments) as ToolName[]).flatMap(tool => [...objects, {}].map(input => ({ tool, input }))),
  ...strings('path', {}, null, 4096).map(input => ({ tool: 'list_directory' as const, input })),
  ...strings('path', {}, 1, 4096).map(input => ({ tool: 'read_file' as const, input })),
  // zod's length checks run after a type issue on any value with a length, comparing it with JavaScript coercion.
  ...[[1, 2], Array.from({ length: 4097 }, () => 0), { length: 5 }, { length: 5000 }, { length: 0 }, { length: null }, { length: true }, { length: 'x' }, { length: ' 12 ' }, { length: '0x10' }, { length: '1e9' },
    { length: '' }, { length: [] }, { length: [5000] }, { length: [1, 2] }, { length: {} }, { length: '-Infinity' }].map(path => ({ tool: 'read_file' as const, input: { path } })),
  ...[[], { length: 2001 }, Array.from({ length: 2001 }, () => 'q')].map(query => ({ tool: 'search_text' as const, input: { query } })),
  ...[[], { length: 0 }].map(expectedHash => ({ tool: 'write_file' as const, input: { path: 'a', expectedHash, content: 'x' } })),
  { tool: 'run_command' as const, input: { command: 'c', environment: { A: [], B: { length: 4097 } } } },
  ...[{ path: 'a', b: 1 }, { path: 'a', b: 1, a: 2 }, { b: 1, 10: 2, 2: 3, path: 'a' }, JSON.parse('{"__proto__": 1, "path": "a"}'), { constructor: 1, path: 'a' }, { 'q"u\\o\nte': 1, path: 'a' }, { 'é': 1, path: 7 }, { path: 'src/a.ts' }]
    .map(input => ({ tool: 'read_file' as const, input })),
  ...strings('query', { path: '' }, 1, 2000).map(input => ({ tool: 'search_text' as const, input })),
  ...[{ query: 'q' }, { query: 'q', path: null }, { query: 'q', path: 'src' }, { path: 'src' }].map(input => ({ tool: 'search_text' as const, input })),
  ...['', hash.toUpperCase(), 'a'.repeat(63), 'a'.repeat(65), `${hash}\n`, `\n${hash}`, 'g'.repeat(64), '١'.repeat(64), 7, null].map(expectedHash => ({ tool: 'write_file' as const, input: { path: 'a', expectedHash, content: 'x' } })),
  ...strings('content', { path: 'a', expectedHash: hash }, null, 65536).map(input => ({ tool: 'write_file' as const, input })),
  ...[{ path: '', expectedHash: 'z', content: 5 }, { path: 'a', expectedHash: hash, content: 'x', extra: true }].map(input => ({ tool: 'write_file' as const, input })),
  ...strings('oldText', { path: 'a', expectedHash: hash, newText: 'n' }, 1, 65536).map(input => ({ tool: 'replace_text' as const, input })),
  ...strings('newText', { path: 'a', expectedHash: hash, oldText: 'o' }, null, 65536).map(input => ({ tool: 'replace_text' as const, input })),
  ...[{ path: 'a', expectedHash: 'A'.repeat(64), oldText: '', newText: 'x' }, { path: 'a', expectedHash: hash, oldText: 'o' }].map(input => ({ tool: 'replace_text' as const, input })),
  ...strings('command', {}, 1, 16384).map(input => ({ tool: 'run_command' as const, input })),
  ...strings('cwd', { command: 'c' }, null, 4096).map(input => ({ tool: 'run_command' as const, input })),
  ...[[], null, 'x', 5, { A: 'v', b_2: '', _: 'u' }, { '1A': 'v' }, { 'A-B': 'v' }, { '': 'v' }, { 'é': 'v' }, { '5': 'v' }, { A: 5 }, { A: null }, { A: rep('x', 4096) }, { A: rep('x', 4097) },
    { A: rep('\u{1F600}', 4096) }, { A: rep('\u{1F600}', 4097) }, { '1A': 5, ok: 7, b: rep('x', 5000), C: 'fine' }, JSON.parse('{"__proto__": "v", "A": "w"}'), JSON.parse('{"__proto__": 5}'),
    { 'A\n': 'v' }, { [`${'a'.repeat(64)}`]: 'v' }, { 10: 'x', 2: 'y', Z: 'z' }]
    .map(environment => ({ tool: 'run_command' as const, input: { command: 'c', environment } })),
  ...[99, 100, 600000, 600001, 50.5, -1.5, -0, 0, 1e20, -1e20, 9007199254740991, 9007199254740992, -9007199254740992, 1e-7, '5', null, true, [], {}]
    .map(timeoutMs => ({ tool: 'run_command' as const, input: { command: 'c', timeoutMs } })),
  ...[{ command: 'c', cwd: null, environment: null, timeoutMs: '5' }, { command: '', cwd: 7, environment: { '1A': 'v' }, timeoutMs: 1.5, z: 1 }, { command: 'c', cwd: 'src', environment: { A: 'b' }, timeoutMs: 1000 }]
    .map(input => ({ tool: 'run_command' as const, input })),
];

// Section 3: search. Trees are built with the shared fixture steps; { fill } adds count files of text to dir.
type Fill = { dir: string; count: number; text: string };
const searchTrees: { name: string; tree: Step[]; fills?: Fill[]; queries: { query: unknown; path?: string }[] }[] = [
  { name: 'walk', tree: [...committed(), file('repo/node_modules/x.js', 'export const x = 1;\n'), file('repo/dist/y.js', 'export y\n'), file('repo/out/z.txt', 'export z\n'), file('repo/coverage/c.txt', 'export c\n'),
    file('repo/.venv/v.txt', 'export v\n'), file('repo/Node_Modules/n.js', 'export n\n'), file('repo/src/node_modules/deep.js', 'export deep\n'), file('repo/src/dist.txt', 'export dist file\n'), file('repo/.env', 'export SECRET=1\n'),
    { file: 'repo/bin.dat', base64: 'ZXhwb3J0AGJpbmFyeQ==' }, { file: 'repo/big.txt', repeat: ['export ', 10000] }, file('repo/crlf.txt', 'export one\r\ntwo export\r\nlone\rexport cr\n\nexport last'),
    file('repo/long.txt', `${'x'.repeat(550)}export tail\n${'y'.repeat(499)}\u{1F600}export emoji\n`), file('repo/unicode/é.md', 'café export \u{1F600}\n'), file('repo/docs/nested/deeper/d.md', 'export deep doc\n')],
  queries: [{ query: 'export' }, { query: 'export', path: 'src' }, { query: 'export', path: 'docs' }, { query: 'nomatch' }, { query: '\r' }, { query: 'é' }, { query: '\u{1F600}' }, { query: '\ud83d' },
    { query: 'EXPORT' }, { query: 'export', path: 'missing' }, { query: 'export', path: 'README.md' }, { query: 'export', path: '../outside' }, { query: 'export', path: '.git' }, { query: 'export', path: 'node_modules' }] },
  { name: 'match limit', tree: [...committed(), file('repo/hits.txt', Array.from({ length: 150 }, (_, index) => `hit ${index}`).join('\n'))], queries: [{ query: 'hit' }, { query: 'hit 14' }] },
  { name: 'visit limit', tree: committed(), fills: [{ dir: 'repo/bulk', count: 2100, text: 'needle\n' }], queries: [{ query: 'needle' }, { query: 'absent' }, { query: 'needle', path: 'src' }] },
];

// Section 4: executions. Each step is one tool call of a task; decisions and changes apply while its proposal waits.
type Decision = { decide: 'approve' | 'reject'; nonce?: 'wrong'; taskId?: number; approvalId?: 'missing' } | { cancel: true } | { revoke: number };
type Call = { task: number; name: string; arguments: unknown; abort?: 'before'; whileWaiting?: (Step | Decision)[]; after?: Decision[]; read?: string };
const git = (n: number, extra: Partial<Task> = {}): Task => ({ id: id(n), title: `Task ${n}`, profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: stamp, updatedAt: stamp, tokenBudget: 100000, usedTokens: 0,
  mode: 'coding', workspaceKind: 'git', projectPath: '{scratch}\\repo', worktreePath: '{scratch}\\repo', branch: 'codex/tools', baseCommit: '0'.repeat(40), ...extra } as Task);
const tasks: Task[] = [git(1), git(2, { mode: 'chat' }), { ...git(3), workspaceKind: 'folder' } as Task, { ...git(4), workspaceKind: 'none' } as Task, (({ workspaceKind: _, ...rest }) => rest as Task)(git(5)), git(6)];
const fileHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const call = (name: string, args: unknown, extra: Partial<Call> = {}): Call => ({ task: 1, name, arguments: args, ...extra });
const say = (text: string) => `[Console]::Out.WriteLine('${text}')`;
const executions: { name: string; tree: Step[]; calls: Call[] }[] = [
  { name: 'reads and refusals', tree: [...committed(), file('repo/.env', 'X=1\n'), file('repo/notes.txt', 'token api_key=fixture-secret-value here\n'), file('repo/control.txt', '\u0001'.repeat(40000)), { dir: 'outside' }],
    calls: [
      call('list_directory', {}), call('list_directory', { path: 'src' }), call('list_directory', { path: 'missing' }), call('list_directory', { path: 'README.md' }),
      call('read_file', { path: 'README.md' }), call('read_file', { path: '.env' }), call('read_file', { path: '../outside/x' }), call('read_file', { path: 'notes.txt' }), call('read_file', { path: 'control.txt' }),
      call('search_text', { query: 'export' }), call('search_text', { query: 'x', path: 'missing' }), call('read_file', {}), call('read_file', { path: 'a', extra: 1 }), call('read_file', null),
      call('read_file', { path: 'api_key=fixture-secret-value' }), call('read_file', { path: 'x', note: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' }),
      call('delete_file', {}), call('mcp__fixture__write_note', {}), call('complete_task', {}), call('browser_tabs', {}), call('read_file', { path: 'README.md' }, { abort: 'before' }),
      call('read_file', { path: 'README.md' }, { task: 2 }), call('browser_tabs', {}, { task: 2 }), call('read_file', { path: 'README.md' }, { task: 3 }), call('read_file', { path: 'README.md' }, { task: 4 }),
      call('read_file', { path: 'README.md' }, { task: 5 }), call('list_directory', {}, { task: 5 }),
    ] },
  { name: 'edits', tree: [...committed(), file('repo/edit.txt', 'one two three\n'), file('repo/twice.txt', 'a a\n'), file('repo/overlap.txt', 'aaa\n'), file('repo/dollar.txt', 'cost: X\n'),
    file('repo/secret.md', 'api_key=fixture-secret-value\n'), file('repo/race.txt', 'before\n'), file('repo/cancel.txt', 'cancel\n'), file('repo/late.txt', 'late\n')],
    calls: [
      call('write_file', { path: 'edit.txt', expectedHash: fileHash('one two three\n'), content: 'replaced\n' }, { whileWaiting: [{ decide: 'approve' }], after: [{ decide: 'approve' }], read: 'edit.txt' }),
      call('write_file', { path: 'edit.txt', expectedHash: fileHash('replaced\n'), content: 'rejected\n' }, { whileWaiting: [{ decide: 'approve', nonce: 'wrong' }, { decide: 'approve', taskId: 6 }, { decide: 'approve', approvalId: 'missing' }, { decide: 'reject' }], read: 'edit.txt' }),
      call('write_file', { path: 'edit.txt', expectedHash: fileHash('stale\n'), content: 'x' }), call('write_file', { path: 'new.txt', expectedHash: fileHash(''), content: 'x' }),
      call('write_file', { path: 'edit.txt', expectedHash: fileHash('replaced\n'), content: 'api_key=fixture-secret-value' }),
      call('replace_text', { path: 'twice.txt', expectedHash: fileHash('a a\n'), oldText: 'a', newText: 'b' }),
      call('replace_text', { path: 'twice.txt', expectedHash: fileHash('a a\n'), oldText: 'zzz', newText: 'b' }),
      call('replace_text', { path: 'twice.txt', expectedHash: fileHash('changed'), oldText: 'a', newText: 'b' }),
      call('replace_text', { path: 'overlap.txt', expectedHash: fileHash('aaa\n'), oldText: 'aa', newText: 'b' }, { whileWaiting: [{ decide: 'approve' }], read: 'overlap.txt' }),
      call('replace_text', { path: 'dollar.txt', expectedHash: fileHash('cost: X\n'), oldText: 'X', newText: "$& $' $$ $1" }, { whileWaiting: [{ decide: 'approve' }], read: 'dollar.txt' }),
      call('replace_text', { path: 'secret.md', expectedHash: fileHash('api_key=fixture-secret-value\n'), oldText: 'api', newText: 'API' }),
      call('write_file', { path: 'race.txt', expectedHash: fileHash('before\n'), content: 'after\n' }, { whileWaiting: [file('repo/race.txt', 'changed\n'), { decide: 'approve' }], read: 'race.txt' }),
      call('write_file', { path: 'cancel.txt', expectedHash: fileHash('cancel\n'), content: 'never\n' }, { whileWaiting: [{ cancel: true }], after: [{ decide: 'approve' }], read: 'cancel.txt' }),
      call('write_file', { path: 'late.txt', expectedHash: fileHash('late\n'), content: 'never\n' }, { whileWaiting: [{ decide: 'approve' }, { cancel: true }], read: 'late.txt' }),
      call('write_file', { path: 'cancel.txt', expectedHash: fileHash('cancel\n'), content: 'never\n' }, { whileWaiting: [{ cancel: true }, { decide: 'approve' }], read: 'cancel.txt' }),
      call('write_file', { path: 'late.txt', expectedHash: fileHash('late\n'), content: 'never\n' }, { whileWaiting: [{ revoke: 6 }, { revoke: 1 }], after: [{ decide: 'approve' }], read: 'late.txt' }),
      call('write_file', { path: 'README.md', expectedHash: fileHash('hello\n'), content: 'chat\n' }, { task: 2 }),
    ] },
  { name: 'commands', tree: committed(),
    calls: [
      call('run_command', { command: say('ran') }, { whileWaiting: [{ decide: 'approve' }] }),
      call('run_command', { command: `${say('failing')}; exit 3`, cwd: 'src', environment: { FOUNDRY_P2_VALUE: 'v' }, timeoutMs: 30000 }, { whileWaiting: [{ decide: 'approve' }] }),
      call('run_command', { command: say('rejected') }, { whileWaiting: [{ decide: 'reject' }] }),
      call('run_command', { command: say('x'), cwd: 'missing' }), call('run_command', { command: say('x'), environment: { OPENAI_API_KEY: 'x' } }),
      call('run_command', { command: say('x'), environment: { VALUE: 'api_key=fixture-secret-value' } }),
      call('run_command', { command: say('raced') }, { whileWaiting: [file('repo/README.md', 'changed\n'), { decide: 'approve' }] }),
      call('run_command', { command: '[Threading.Thread]::Sleep(5000)', timeoutMs: 100 }, { whileWaiting: [{ decide: 'approve' }] }),
      call('run_command', { command: say('cancelled') }, { whileWaiting: [{ cancel: true }] }),
    ] },
];

type Row = Record<string, unknown>;
it('pins the coding tools: definitions, arguments, search and executions through the shipping Node authority', async () => {
  {
    const argumentsVectors = argumentCases.map(({ tool, input }) => {
      const parsed = ToolArguments[tool].safeParse(expand(input));
      return { tool, input, ...(parsed.success ? { value: pin(parsed.data) } : { error: parsed.error.message }) };
    });

    const searchVectors = [];
    for (const item of searchTrees) {
      const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-search-')));
      try {
        build(scratch, path.join(scratch, 'home'), item.tree);
        for (const fill of item.fills ?? []) for (let index = 0; index < fill.count; index++) {
          fs.mkdirSync(path.join(scratch, fill.dir), { recursive: true }); fs.writeFileSync(path.join(scratch, fill.dir, `f${String(index).padStart(5, '0')}.txt`), fill.text);
        }
        const repositories = new RepositoryService(path.join(scratch, 'wt'));
        const results = [];
        for (const query of item.queries) {
          try { results.push({ ...query, value: JSON.stringify(await repositories.search(path.join(scratch, 'repo'), expand(query.query) as string, query.path)) }); }
          catch (error) {
            const code = systemError((error as Error).message);
            results.push({ ...query, ...(code ? { systemError: code } : { error: (error as Error).message.replaceAll(scratch, '{scratch}') }) });
          }
        }
        searchVectors.push({ name: item.name, tree: item.tree, fills: item.fills ?? [], results });
      } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    }

    const executionVectors = [];
    for (const item of executions) {
      const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-tools-')));
      const home = path.join(scratch, 'home');
      const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE };
      try {
        for (const folder of ['tmp', 'profile', 'data']) fs.mkdirSync(path.join(scratch, folder));
        Object.assign(process.env, { TEMP: path.join(scratch, 'tmp'), TMP: path.join(scratch, 'tmp'), USERPROFILE: path.join(scratch, 'profile') });
        build(scratch, home, item.tree);
        const systemRoot = process.env.SystemRoot!;
        const shell = fs.realpathSync.native(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
        const store = new Store(path.join(scratch, 'data', 'workspace.db'));
        const service = new RuntimeService(store, new RepositoryService(path.join(scratch, 'data', 'wt')), () => {});
        const tools = (service as unknown as { tools: ToolRuntime }).tools;
        const uuids = new Map<string, string>(); const fingerprints = new Map<string, string>();
        const clean = (value: unknown): unknown => {
          if (typeof value === 'string') {
            let text = value;
            for (const [raw, name] of [[scratch, 'scratch'], [shell, 'shell'], [systemRoot, 'SystemRoot']] as const) text = text.replaceAll(raw.replaceAll('\\', '\\\\'), `{${name}-json}`).replaceAll(raw, `{${name}}`);
            for (const [raw, name] of fingerprints) text = text.replaceAll(raw, name);
            text = text.replace(/\b(?!14141414-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, match => {
              if (!uuids.has(match)) uuids.set(match, `{uuid:${uuids.size + 1}}`);
              return uuids.get(match)!;
            }).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '{time}');
            return pin(text);
          }
          if (Array.isArray(value)) return value.map(clean);
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clean(entry)]));
          return value;
        };
        const rows = () => store.db.prepare("SELECT rowid AS _rowid,* FROM intents WHERE kind='tool.approval' ORDER BY rowid").all() as Row[];
        const remember = () => {
          for (const row of rows()) {
            const data = JSON.parse(row.data as string) as { tool?: string; fingerprint?: string };
            if (data.fingerprint && !fingerprints.has(data.fingerprint)) fingerprints.set(data.fingerprint, `{fingerprint:${fingerprints.size + 1}}`);
          }
        };
        for (const task of tasks) store.saveTask(JSON.parse(JSON.stringify(task).replaceAll('{scratch}', scratch.replaceAll('\\', '\\\\'))) as Task);
        const steps: unknown[] = [];
        await withIsolatedGit(home, async () => {
          let position = 0;
          for (const step of item.calls) {
            const sequence = (store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM events').get() as { value: number }).value;
            const known = new Set(rows().map(row => row.id as string));
            const controller = new AbortController();
            if (step.abort === 'before') controller.abort();
            const callId = `call-${++position}`;
            const pending = tools.execute(store.task(id(step.task)), { id: callId, name: step.name, arguments: expand(step.arguments) } as ToolCall, controller.signal);
            let settled = false; void pending.finally(() => { settled = true; });
            const decisions: unknown[] = []; let proposal: Row | undefined;
            const fresh = () => rows().find(row => !known.has(row.id as string));
            const decide = (decision: Decision): unknown => {
              if ('cancel' in decision) { controller.abort(); return { cancelled: true }; }
              if ('revoke' in decision) { tools.revokeWaiting(id(decision.revoke)); return { revoked: decision.revoke }; }
              const approval = fresh()!; const data = JSON.parse(approval.data as string) as { nonce: string };
              try { return { value: tools.decide(id(decision.taskId ?? step.task), decision.approvalId === 'missing' ? id(999) : approval.id as string, decision.nonce === 'wrong' ? 'wrong-nonce' : data.nonce, decision.decide) }; }
              catch (error) { return { error: (error as Error).message }; }
            };
            if (step.whileWaiting) {
              for (let wait = 0; wait < 6000 && !settled && !fresh(); wait++) await new Promise(resolve => setTimeout(resolve, 5));
              proposal = fresh();
              for (const change of step.whileWaiting) {
                if ('decide' in change || 'cancel' in change || 'revoke' in change) decisions.push(decide(change));
                else build(scratch, home, [change]);
              }
            }
            const outcome = await pending;
            const code = systemError(outcome.content);
            const result = code ? { ...outcome, content: { systemError: code } } : outcome;
            const after = (step.after ?? []).map(decide);
            remember();
            const row = rows().find(entry => !known.has(entry.id as string)) ?? null;
            const events = store.db.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence').all(sequence);
            const read = step.read ? fs.readFileSync(path.join(scratch, 'repo', step.read), 'utf8') : undefined;
            steps.push(clean({ call: { ...step, id: callId }, result, ...(proposal ? { proposal } : {}), decisions, after, row, events, ...(read !== undefined ? { read } : {}) }));
          }
        });
        await service.shutdown();
        executionVectors.push({ name: item.name, tree: item.tree, steps });
      } finally {
        for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }

    const corpus = {
      schemaVersion: 1,
      oracle: { sources: ['packages/runtime/src/tool-definitions.ts', 'packages/runtime/src/tool-runtime.ts', 'packages/runtime/src/repository.ts', 'packages/runtime/src/command-runner.ts', 'packages/runtime/src/job-runner.ps1',
        'packages/runtime/src/redaction.ts', 'packages/runtime/src/store.ts', 'packages/runtime/src/service.ts', 'packages/runtime/src/execution-slots.ts'].map(source => ({ path: source, sha256: sha256File(source) })) },
      stamp, tasks, definitions: JSON.stringify(TOOL_DEFINITIONS), arguments: argumentsVectors, search: searchVectors, executions: executionVectors,
    };
    const target = 'tests/p2/tool-runtime-vectors.json';
    if (process.env.P2_WRITE_TOOL_RUNTIME === '1') fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(JSON.parse(JSON.stringify(corpus)));
  }
}, 600_000);
