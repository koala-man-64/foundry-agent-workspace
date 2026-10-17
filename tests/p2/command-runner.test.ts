import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CommandPreflightError, CommandRunner, type PreparedCommand } from '../../packages/runtime/src/command-runner';
import { build, committed, file, git, normalize, sha256File, type Step, withIsolatedGit } from './repository-fixture';

// The approved-command runner of the shipping TypeScript runtime (command-runner.ts and its job-runner.ps1 helper),
// driven directly over disposable Git worktrees with real Windows PowerShell 5.1 runs. The C# suite (CommandRunnerTests)
// rebuilds every tree, replays every step through the native CommandRunner and must reproduce each outcome or its named
// difference. Prepared fingerprints are compared only by identity within a case (group numbers in order of first
// appearance): they are session-scoped and their preimage holds machine-specific state. Node's raw errors are recorded
// as { systemError } and native refuses them with its own fixed message. Placeholders: {scratch} {shell} {SystemRoot}.
type Text = string | { repeat: [string, number] };
type Prepare = { op: 'prepare'; as?: string; root?: string; command: Text; cwd?: string; environment?: [string, string][]; timeoutMs?: number; processEnv?: Record<string, string | null> };
type Op =
  | Prepare
  | { op: 'execute'; prepared: string; tamper?: [keyof PreparedCommand, unknown]; abort?: 'before' | { afterFile: string } }
  | { op: 'executeTwice'; prepared: string }
  | { op: 'discard'; prepared: string }
  | { op: 'write'; file: string; text: Text }
  | { op: 'touch'; file: string }
  | { op: 'mkdir'; dir: string }
  | { op: 'junction'; link: string; target: string }
  | { op: 'unlink'; link: string }
  | { op: 'git'; args: string[] }
  | { op: 'fill'; dir: string; count: number; prefix: string }
  | { op: 'wait'; ms: number }
  | { op: 'exists'; file: string }
  | { op: 'read'; file: string };
type Outcome = Record<string, unknown>;
type Case = { name: string; tree: Step[]; steps: Op[] };

const run = (command: Text, extra: Partial<Prepare> = {}): Prepare => ({ op: 'prepare', as: 'p', command, ...extra });
const exec = (prepared = 'p', extra: Partial<Extract<Op, { op: 'execute' }>> = {}): Op => ({ op: 'execute', prepared, ...extra });
const refused = (extra: Partial<Prepare>): Prepare => ({ op: 'prepare', command: "Write-Output 'never'", ...extra });
// Commands use .NET calls and keywords only: a cmdlet makes PowerShell write "Preparing modules for first use" progress
// records to standard error, and how many it writes depends on timing. Non-ASCII text appears only in the cases about it.
const bytes = (stream: 'Output' | 'Error', expression: string) =>
  `$s = [Console]::OpenStandard${stream}(); $b = [Text.Encoding]::UTF8.GetBytes(${expression}); $s.Write($b, 0, $b.Length); $s.Flush()`;
const say = (text: string) => `[Console]::Out.WriteLine('${text}')`;
// A PowerShell grandchild that inherits the pipes, marks its start, then outlives the step unless the job ends it.
const child = (started: string) => `$a = '-NoProfile -NonInteractive -Command "[IO.File]::WriteAllText(''${started}'', ''x''); [Threading.Thread]::Sleep(6000); [IO.File]::WriteAllText(''orphan.txt'', ''x'')"'; `
  + `$i = [Diagnostics.ProcessStartInfo]::new("$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", $a); $i.UseShellExecute = $false; $i.CreateNoWindow = $true; `
  + `[void][Diagnostics.Process]::Start($i); while (-not [IO.File]::Exists('${started}')) { [Threading.Thread]::Sleep(50) }`;
const repository = (extra: Step[] = []) => committed([file('repo/.gitignore', '*.log\n'), file('repo/src/sub/c.ts', 'c\n'), ...extra]);

const cases: Case[] = [
  { name: 'validates the request before touching the root', tree: repository(), steps: [
    refused({ command: '' }), refused({ command: ' \u00a0\ufeff\n\t' }), refused({ command: { repeat: ['a', 65537] } }), refused({ command: 'a\0b' }),
    refused({ timeoutMs: 0 }), refused({ timeoutMs: 600001 }), refused({ timeoutMs: 1.5 }), refused({ command: '', timeoutMs: 0 }),
    refused({ environment: Array.from({ length: 65 }, (_, index) => [`V${index}`, 'x'] as [string, string]) }),
    ...['1A', 'A-B', '', 'Path', 'PSModulePath', 'COMSPEC', 'windir', 'PathExt', 'SystemRoot', 'MY_TOKEN', 'OPENAI_API_KEY', 'APIKEY', 'node_options', 'HTTPS_PROXY', 'Cookie_Jar', 'db_password', 'AUTHORIZATION', 'gh_secret', 'Credential']
      .map(name => refused({ environment: [[name, 'x']] })),
    refused({ environment: [['OK', 'a\0b']] }), refused({ environment: [['OK', 'x'.repeat(4097)]] }),
    refused({ environment: [['FIRST', 'a\0b'], ['MY_TOKEN', 'x']] }), refused({ environment: [['MY_TOKEN', 'x'], ['FIRST', 'a\0b']] }),
    run({ repeat: ['#', 65536] }, { as: undefined }), refused({ environment: [['OK', 'x'.repeat(4096)]], timeoutMs: 600000 }), refused({ timeoutMs: 1 }),
  ] },
  // Links are made after the commit, so Git never records them.
  { name: 'admits the root and the working directory', tree: [...repository(), { dir: 'plain' }, file('plain/x.txt', 'x\n'), { dir: 'outside' }, { junction: 'repo/inner', target: 'repo/src' },
    { junction: 'repo/outer', target: 'outside' }, { dir: 'unborn' }, git('-C', 'unborn', 'init', '-q')], steps: [
    refused({ root: '' }), refused({ root: 'relative' }), refused({ root: 'repo/README.md' }), refused({ root: 'absent' }), refused({ root: 'plain' }), refused({ root: 'unborn' }),
    ...['', 'src', './src/', 'src\\sub', 'SRC', '.git', 'src.', 'src ', 'inner', 'outer', 'missing', 'README.md', '..', 'src/../..', 'src/..', '/src', 'C:\\src', 'c:src', '\\\\server\\share', 'a\0b']
      .map(cwd => refused({ cwd })),
  ] },
  { name: 'composes the minimal environment', tree: repository(), steps: [
    refused({ environment: [['zeta', 'z'], ['TEST_APPROVED', 'yes'], ['Alpha', 'a'], ['_under', 'u'], ['TEMP', 'override'], ['b2', 'x'], ['B1', 'y']] }),
    refused({ processEnv: { TEMP: null } }), refused({ processEnv: { TEMP: null, TMP: null } }), refused({ processEnv: { USERPROFILE: null } }),
    refused({ processEnv: { SystemRoot: null, WINDIR: null } }),
  ] },
  { name: 'fingerprints the reviewed worktree state', tree: repository(), steps: [
    refused({}), refused({}), { op: 'touch', file: 'repo/README.md' }, refused({}), { op: 'write', file: 'repo/README.md', text: 'hello\n' }, refused({}),
    { op: 'write', file: 'repo/README.md', text: 'HELLO\n' }, refused({}), { op: 'write', file: 'repo/x.log', text: 'ignored\n' }, refused({}),
    { op: 'mkdir', dir: 'repo/emptydir' }, refused({}), { op: 'write', file: 'repo/.git/description', text: 'changed\n' }, refused({}),
    { op: 'git', args: ['-C', 'repo', 'add', '-A'] }, { op: 'git', args: ['-C', 'repo', 'commit', '-qm', 'second'] }, refused({}),
    { op: 'junction', link: 'repo/lnk', target: 'repo/src' }, refused({}), { op: 'unlink', link: 'repo/lnk' }, { op: 'junction', link: 'repo/lnk', target: 'repo/docs' }, refused({}),
    { op: 'unlink', link: 'repo/lnk' }, refused({}),
    refused({ timeoutMs: 9999 }), refused({ cwd: 'src' }), refused({ environment: [['A', '1']] }), refused({ command: "Write-Output 'other'" }),
  ] },
  { name: 'refuses to fingerprint more than 10,000 files', tree: committed(), steps: [
    { op: 'fill', dir: 'repo/bulk', count: 9997, prefix: 'f' }, refused({}), { op: 'write', file: 'repo/bulk/extra.txt', text: 'x' }, refused({}),
  ] },
  { name: 'refuses to fingerprint more than 64 MiB', tree: committed(), steps: [
    { op: 'write', file: 'repo/big.bin', text: { repeat: ['a', 64 * 1024 * 1024 - 30] } }, refused({}), { op: 'write', file: 'repo/one.bin', text: 'a' }, refused({}),
  ] },
  { name: 'refuses a status larger than the Git output limit', tree: committed(), steps: [
    { op: 'fill', dir: 'repo', count: 6000, prefix: 'untracked-entry-with-a-deliberately-long-name-' }, refused({}),
  ] },
  { name: 'runs exactly the approved command', tree: repository(), steps: [
    run(`${say('out')}; [Console]::Error.WriteLine('err'); [Console]::Out.WriteLine([Environment]::GetEnvironmentVariable('TEST_APPROVED')); `
      + "[Console]::Out.WriteLine($null -eq [Environment]::GetEnvironmentVariable('FOUNDRY_P2_CANARY')); [Console]::Out.WriteLine([Environment]::CurrentDirectory)",
    { cwd: 'src', environment: [['TEST_APPROVED', 'yes']] }), exec(),
    run("$k = @([Environment]::GetEnvironmentVariables().Keys); [Array]::Sort($k, [StringComparer]::OrdinalIgnoreCase); [Console]::Out.WriteLine(($k -join ','))", { environment: [['TEST_APPROVED', 'yes']] }), exec(),
    run(`${say('no')}; exit 7`), exec(), run('exit -1'), exec(),
    // Output is encoded by PowerShell in the console's code page and decoded as UTF-8, in both runtimes.
    run('[Console]::Out.WriteLine([string][char]0x00e9 + [char]0x6771)'), exec(),
    // Non-ASCII command text: TypeScript's helper decodes its stdin spec in the console code page before encoding it.
    run("[IO.File]::WriteAllText('quoted.txt', 'it''s \"double\" caf\u00e9 \u6771\u4eac \ud83d\ude00 `n', [Text.UTF8Encoding]::new($false))"), exec(), { op: 'read', file: 'repo/quoted.txt' },
    run(say('caf\u00e9 \u6771\u4eac')), exec(),
  ] },
  { name: 'bounds each output stream', tree: repository(), steps: [
    run(bytes('Output', "('a' * 65535)")), exec(), run(bytes('Output', "('a' * 65536)")), exec(), run(bytes('Output', "('a' * 70000)")), exec(),
    run(bytes('Output', '([string][char]0x20ac * 40000)')), exec(), run(bytes('Output', "('aa' + [string][char]0x20ac * 30000)")), exec(),
    run(bytes('Error', "('e' * 70000)")), exec(), run(bytes('Output', `('a' * ${1024 * 1024})`)), exec(),
  ] },
  { name: 'ends the whole tree on timeout, cancellation and a normal exit', tree: repository(), steps: [
    run('[Threading.Thread]::Sleep(30000)', { timeoutMs: 1500 }), exec(),
    run(`${child('cancel-started.txt')}; [Threading.Thread]::Sleep(30000)`, { timeoutMs: 60000 }), exec('p', { abort: { afterFile: 'repo/cancel-started.txt' } }),
    { op: 'wait', ms: 7000 }, { op: 'exists', file: 'repo/orphan.txt' },
    run(child('background-started.txt')), exec(), { op: 'wait', ms: 7000 }, { op: 'exists', file: 'repo/background-started.txt' }, { op: 'exists', file: 'repo/orphan.txt' },
    run("[IO.File]::WriteAllText('never.txt', 'x')"), exec('p', { abort: 'before' }), { op: 'exists', file: 'repo/never.txt' },
  ] },
  { name: 'consumes each prepared command once', tree: repository(), steps: [
    run(say('once'), { as: 'a' }), exec('a'), exec('a'),
    run(`[Threading.Thread]::Sleep(300); ${say('once')}`, { as: 'b' }), { op: 'executeTwice', prepared: 'b' },
    run(say('tampered'), { as: 'c' }), exec('c', { tamper: ['command', say('other')] }), exec('c', { tamper: ['cwd', '{scratch}\\repo\\src'] }),
    exec('c', { tamper: ['shell', '{scratch}\\repo\\powershell.exe'] }), exec('c', { tamper: ['timeoutMs', 9999] }), exec('c', { tamper: ['environment', { A: '1' }] }),
    exec('c', { tamper: ['fingerprint', '0'.repeat(64)] }), exec('c'),
    run(say('discarded'), { as: 'd' }), { op: 'discard', prepared: 'd' }, exec('d'),
    run(say('stale'), { as: 'e' }), { op: 'write', file: 'repo/changed.txt', text: 'changed\n' }, exec('e'), exec('e'), run(say('stale'), { as: 'e' }), exec('e'),
    run(say('twin'), { as: 'f' }), run(say('twin'), { as: 'g' }), exec('g'), exec('f'),
  ] },
  { name: 'accepts environment names that native refuses', tree: repository(), steps: [
    ...['DOTNET_ROOT', 'dotnet_gcHeapHardLimit', 'COMPlus_EnableDiagnostics', 'COR_PROFILER', 'CORECLR_PROFILER_PATH', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'PYTHONPATH', 'PythonStartup', 'PERL5OPT', 'RUBYOPT', '__COMPAT_LAYER']
      .map(name => refused({ environment: [[name, 'x']] })),
    run(say('case'), { environment: [['temp', 'x']] }), exec(), refused({ environment: [['Tmp', 'x']] }), refused({ environment: [['UserProfile', 'x']] }),
    refused({ environment: [['SAME', '1'], ['same', '2']] }), refused({ environment: [['TEMP', 'x'], ['TMP', 'y'], ['USERPROFILE', 'z']] }),
  ] },
  { name: 'refuses a command line beyond the Windows limit only when launching', tree: repository(), steps: [
    run(`${say('long')} # ${'a'.repeat(13000)}`), exec(),
  ] },
];

const expandText = (value: Text): string => typeof value === 'string' ? value : value.repeat[0].repeat(value.repeat[1]);
const waitForFile = async (target: string): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(target)) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${target}.`); await new Promise(resolve => setTimeout(resolve, 50)); }
};

it('pins the approved-command runner of the shipping Node authority', async () => {
  const systemRoot = process.env.SystemRoot!;
  const shell = fs.realpathSync.native(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const recorded: (Case & { steps: (Op & { expected: Outcome })[] })[] = [];
  for (const item of cases) {
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-command-')));
    const home = path.join(scratch, 'home'); const temp = path.join(scratch, 'tmp'); const profile = path.join(scratch, 'profile');
    for (const directory of [home, temp, profile]) fs.mkdirSync(directory);
    const machine = (value: unknown): unknown => {
      if (typeof value === 'string') return value.replaceAll(shell, '{shell}').replaceAll(systemRoot, '{SystemRoot}');
      if (Array.isArray(value)) return value.map(machine);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, machine(inner)]));
      return value;
    };
    const clean = (value: unknown) => normalize(machine(value), scratch);
    const outcome = (error: unknown): Outcome => {
      if (!(error instanceof Error)) throw error;
      const preflight = error instanceof CommandPreflightError;
      const code = (error as NodeJS.ErrnoException).code ?? /^(E[A-Z]+): /.exec(error.message)?.[1];
      if (/^Command failed: /.test(error.message)) return { systemError: 'git', preflight };
      if (error.message.startsWith('Command helper exited without a verified result')) return { helperFailure: true, preflight };
      if (typeof code === 'string') return { systemError: code, preflight };
      return { error: clean(error.message), preflight };
    };
    const saved = Object.fromEntries(['TEMP', 'TMP', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'FOUNDRY_P2_CANARY'].map(name => [name, process.env[name]]));
    Object.assign(process.env, { TEMP: temp, TMP: temp, USERPROFILE: profile, FOUNDRY_P2_CANARY: 'canary-is-not-inherited' });
    try {
      build(scratch, home, item.tree);
      const runner = new CommandRunner();
      const prepared = new Map<string, PreparedCommand>();
      const groups = new Map<string, number>();
      const steps: (Op & { expected: Outcome })[] = [];
      await withIsolatedGit(home, async () => {
        for (const step of item.steps) {
          let result: Outcome;
          try {
            if (step.op === 'prepare') {
              const changed = Object.keys(step.processEnv ?? {}).map(name => [name, process.env[name]] as const);
              for (const [name, value] of Object.entries(step.processEnv ?? {})) { if (value === null) delete process.env[name]; else process.env[name] = value; }
              try {
                const root = step.root === undefined ? path.join(scratch, 'repo') : step.root && step.root !== 'relative' ? path.join(scratch, step.root) : step.root;
                const value = await runner.prepare(root, { command: expandText(step.command), cwd: step.cwd ?? '', environment: Object.fromEntries(step.environment ?? []), timeoutMs: step.timeoutMs ?? 10_000 });
                if (step.as) prepared.set(step.as, value);
                if (!groups.has(value.fingerprint)) groups.set(value.fingerprint, groups.size + 1);
                const { fingerprint, environment, ...fields } = value;
                result = { prepared: clean({ ...fields, environment: Object.entries(environment) }), fingerprint: groups.get(fingerprint)! };
              } finally { for (const [name, value] of changed) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
            } else if (step.op === 'execute') {
              const original = prepared.get(step.prepared)!;
              const target = step.tamper ? { ...original, [step.tamper[0]]: typeof step.tamper[1] === 'string' ? step.tamper[1].replaceAll('{scratch}', scratch) : step.tamper[1] } : original;
              const controller = new AbortController();
              if (step.abort === 'before') controller.abort();
              const running = runner.execute(target, controller.signal);
              if (step.abort && step.abort !== 'before') {
                await Promise.race([waitForFile(path.join(scratch, step.abort.afterFile)), running]);
                controller.abort();
              }
              result = { result: clean(await running) };
            } else if (step.op === 'executeTwice') {
              const value = prepared.get(step.prepared)!; const signal = new AbortController().signal;
              const settled = await Promise.allSettled([runner.execute(value, signal), runner.execute(value, signal)]);
              result = { fulfilled: settled.filter(entry => entry.status === 'fulfilled').length, rejected: settled.flatMap(entry => entry.status === 'rejected' ? [outcome(entry.reason)] : []) };
            } else if (step.op === 'discard') { runner.discard(prepared.get(step.prepared)!); result = {}; }
            else if (step.op === 'write') { fs.writeFileSync(path.join(scratch, step.file), expandText(step.text)); result = {}; }
            else if (step.op === 'touch') { const later = new Date(Date.now() + 3_600_000); fs.utimesSync(path.join(scratch, step.file), later, later); result = {}; }
            else if (step.op === 'mkdir') { fs.mkdirSync(path.join(scratch, step.dir)); result = {}; }
            else if (step.op === 'junction') { fs.symlinkSync(path.join(scratch, step.target), path.join(scratch, step.link), 'junction'); result = {}; }
            else if (step.op === 'unlink') { fs.rmdirSync(path.join(scratch, step.link)); result = {}; }
            else if (step.op === 'git') { build(scratch, home, [git(...step.args)]); result = {}; }
            else if (step.op === 'fill') {
              fs.mkdirSync(path.join(scratch, step.dir), { recursive: true });
              for (let index = 0; index < step.count; index++) fs.writeFileSync(path.join(scratch, step.dir, `${step.prefix}${String(index).padStart(5, '0')}.txt`), 'x');
              result = {};
            } else if (step.op === 'wait') { await new Promise(resolve => setTimeout(resolve, step.ms)); result = {}; }
            else if (step.op === 'exists') result = { exists: fs.existsSync(path.join(scratch, step.file)) };
            else result = { text: clean(fs.readFileSync(path.join(scratch, step.file), 'utf8')) };
          } catch (error) { result = outcome(error); }
          steps.push({ ...step, expected: result });
        }
      });
      recorded.push({ ...item, steps });
    } finally {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      for (const link of ['repo/inner', 'repo/outer', 'repo/lnk']) { try { fs.rmdirSync(path.join(scratch, link)); } catch { /* absent */ } }
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
  const corpus = {
    schemaVersion: 1,
    oracle: { sources: ['packages/runtime/src/command-runner.ts', 'packages/runtime/src/job-runner.ps1'].map(source => ({ path: source, sha256: sha256File(source) })) },
    cases: recorded,
  };
  const target = 'tests/p2/command-runner-vectors.json';
  if (process.env.P2_WRITE_COMMAND_RUNNER === '1') fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(corpus);
}, 900_000);
