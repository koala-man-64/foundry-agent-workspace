import { createHash } from 'node:crypto';
import { ScheduleSchema, type ModelProfile, type McpServerConfig } from '../../packages/protocol/src/index';
import { profileFingerprint as runtimeProfileFingerprint } from '../../packages/runtime/src/profile-fingerprint';
import { profileFingerprint as providerProfileFingerprint } from '../../packages/providers/src/index';
import { GitOperations } from '../../packages/runtime/src/git-operations';
import { scheduleInternals } from '../../packages/runtime/src/automation';
import { Redactor } from '../../packages/runtime/src/redaction';
import { checkMcpConfig } from '../../packages/runtime/src/mcp-config';
import { build, encode, type Tagged } from './encoding';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const failure = (error: unknown): { error: string } => ({ error: error instanceof Error ? error.message : String(error) });

/** JSON.stringify exactly as the runtime hashes it: key order, undefined omission, escaping and numbers. */
export function jsJsonVectors() {
  const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join('');
  const inputs: [string, Tagged][] = [
    ['null', null], ['true', true], ['false', false],
    ['zero', 0], ['negative zero', { $number: '-0' }], ['one', 1], ['minus one', -1], ['one and a half', 1.5],
    ['binary fraction sum', 0.1 + 0.2], ['one hundred', 100], ['1e20', 1e20], ['1e21', 1e21], ['1e-6', 0.000001], ['1e-7', 1e-7],
    ['1.23e-18', 1.23e-18], ['max safe integer', Number.MAX_SAFE_INTEGER], ['2^53', 2 ** 53], ['2^64', 2 ** 64],
    ['max value', Number.MAX_VALUE], ['min positive value', Number.MIN_VALUE], ['NaN', { $number: 'NaN' }],
    ['Infinity', { $number: 'Infinity' }], ['-Infinity', { $number: '-Infinity' }],
    ['empty string', ''], ['plain string', 'plain'], ['quote and backslash', '"\\'], ['C0 controls', controls], ['DEL', '\u007f'],
    ['line and paragraph separators', '\u2028\u2029'], ['HTML-sensitive characters', "<>&'"], ['Latin-1', 'é ñ ü ß'], ['CJK', '日本語'],
    ['astral emoji', '\u{1F600}'], ['byte order mark', '\uFEFF'], ['lone high surrogate', { $utf16: [0xD800] }],
    ['lone low surrogate', { $utf16: [0xDC00] }], ['reversed surrogate pair', { $utf16: [0xDC00, 0xD800] }],
    ['high surrogate at end', { $utf16: [0x61, 0xD83D] }],
    ['empty array', []], ['nested arrays', [1, [2, [3, []]]]], ['undefined in array', [{ $undefined: true }, 1]], ['NaN in array', [{ $number: 'NaN' }]],
    ['empty object', { $object: [] }], ['insertion order kept', { $object: [['b', 1], ['a', 2]] }],
    ['array-index keys move first', { $object: [['b', 1], ['2', 'x'], ['1', 'y'], ['a', 'z']] }],
    ['non-index numeric keys keep order', { $object: [['b', 1], ['01', 'x'], ['1.5', 'y'], ['-1', 'z'], ['4294967295', 'w'], ['4294967294', 'v']] }],
    ['undefined property omitted', { $object: [['a', { $undefined: true }], ['b', 1]] }], ['null property kept', { $object: [['a', null]] }],
    ['NaN property becomes null', { $object: [['a', { $number: 'NaN' }]] }],
    ['keys needing escapes', { $object: [['quo"te', 1], ['new\nline', 2], ['\u{1F600}', 3], ['\u2028', 4]] }],
    ['nested objects and arrays', { $object: [['outer', { $object: [['z', [{ $object: [['k', 'v']] }]], ['a', { $undefined: true }]] }], ['n', -0.5]] }],
    ['top-level undefined', { $undefined: true }],
  ];
  return inputs.map(([name, input]) => {
    const output = JSON.stringify(build(input)) as string | undefined;
    return { name, input, output: output ?? null, sha256: output === undefined ? null : sha256(output) };
  });
}

/** Both fingerprint variants: the runtime hashes the raw endpoint; providers hash the WHATWG-normalized URL. */
export function profileFingerprintVectors() {
  const base: ModelProfile = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Fixture', apiKind: 'responses', endpoint: 'https://contoso.openai.azure.com', deployment: 'gpt-fixture', contextLimit: 128000, outputLimit: 4096 };
  const variants: [string, Partial<ModelProfile>][] = [
    ['base', {}], ['with effort', { effort: 'medium' }], ['with credential reference', { credentialRef: 'credential-1' }],
    ['uppercase host and trailing slash', { endpoint: 'https://CONTOSO.openai.azure.com/' }], ['explicit default port', { endpoint: 'https://contoso.openai.azure.com:443' }],
    ['path segment', { endpoint: 'https://contoso.openai.azure.com/openai' }], ['AI services host', { endpoint: 'https://contoso.services.ai.azure.com' }],
    ['internationalized host', { endpoint: 'https://b\u00fccher.openai.azure.com' }], ['non-Azure host', { endpoint: 'https://example.com' }],
    ['chat completions', { apiKind: 'chat-completions' }], ['anthropic', { apiKind: 'anthropic', endpoint: 'https://contoso.services.ai.azure.com' }],
    ['offline fixture keeps raw endpoint', { apiKind: 'fake', endpoint: 'offline://Demo/' }],
  ];
  return variants.map(([name, change]) => {
    const profile: ModelProfile = { ...base, ...change };
    let provider: string | { error: string };
    try { provider = providerProfileFingerprint(profile); } catch (error) { provider = failure(error); }
    return { name, profile: encode(profile), runtime: runtimeProfileFingerprint(profile), provider };
  });
}

/** Coordinated-handoff manifests: entries sorted by UTF-8 bytes, then hashed. Persisted and recompared after restart. */
export function manifestVectors() {
  const prototype = GitOperations.prototype as unknown as {
    sortByPathBytes<T extends { path: string }>(items: T[]): T[];
    hashManifestEntries(entries: unknown[]): string;
  };
  const entry = (path: string, status = 'M') => ({ path, status, oldMode: '100644', newMode: '100644', oldBlob: 'a'.repeat(40), newBlob: 'b'.repeat(40) });
  const sets: [string, ReturnType<typeof entry>[]][] = [
    ['single entry', [entry('README.md')]],
    ['uppercase sorts before lowercase', [entry('a.txt'), entry('B.txt')]],
    ['hyphen sorts before slash', [entry('dir/a'), entry('dir-a', 'A')]],
    ['non-ASCII sorts after ASCII', [entry('\u00e9.txt'), entry('z.txt')]],
    ['UTF-8 order differs from UTF-16 order', [entry('\u{1F600}.txt'), entry('\uE000.txt')]],
    ['all statuses', [entry('d', 'D'), entry('t', 'T'), entry('a', 'A'), entry('m', 'M')]],
  ];
  return sets.map(([name, entries]) => {
    const sorted = prototype.sortByPathBytes(entries);
    return { name, entries, sorted, sha256: prototype.hashManifestEntries(sorted) };
  });
}

/** Wall-clock schedule resolution, including gaps, folds and half-hour zones. Depends on ICU time zone data. */
export function scheduleVectors() {
  const { scheduleFormatter, localStamp, resolveLocalInstant, dueOccurrence } = scheduleInternals;
  const walls: [string, string, string][] = [
    ['UTC', '2026-06-15', '09:00'], ['UTC', '2026-12-31', '23:59'],
    ['America/New_York', '2026-03-08', '02:30'], ['America/New_York', '2026-11-01', '01:30'], ['America/New_York', '2026-06-15', '09:00'], ['America/New_York', '2026-01-01', '00:00'],
    ['Europe/London', '2026-03-29', '01:30'], ['Europe/London', '2026-10-25', '01:30'], ['Europe/Dublin', '2026-03-29', '01:30'], ['Europe/Dublin', '2026-10-25', '01:30'],
    ['Australia/Lord_Howe', '2026-04-05', '01:45'], ['Australia/Lord_Howe', '2026-10-04', '02:15'],
    ['Asia/Kolkata', '2026-06-15', '09:00'], ['Asia/Kathmandu', '2026-06-15', '09:00'],
    ['Pacific/Apia', '2026-06-15', '09:00'], ['Pacific/Apia', '2011-12-30', '12:00'],
    ['Africa/Casablanca', '2026-02-15', '02:30'], ['Africa/Casablanca', '2026-03-22', '02:30'], ['America/Sao_Paulo', '2026-06-15', '09:00'],
  ];
  const resolved = walls.map(([timeZone, date, time]) => {
    try {
      const instant = resolveLocalInstant(scheduleFormatter(timeZone), date, time);
      return { timeZone, date, time, instant: new Date(instant).toISOString(), stamp: localStamp(scheduleFormatter(timeZone), instant) };
    } catch (error) { return { timeZone, date, time, ...failure(error) }; }
  });
  const stampDays: [string, string][] = [['America/New_York', '2026-03-08'], ['America/New_York', '2026-11-01'], ['Australia/Lord_Howe', '2026-04-05'], ['Australia/Lord_Howe', '2026-10-04'], ['Europe/Dublin', '2026-10-25'], ['Africa/Casablanca', '2026-02-15']];
  const stamps = stampDays.flatMap(([timeZone, day]) => {
    const formatter = scheduleFormatter(timeZone);
    const start = Date.parse(`${day}T00:00:00Z`) - 12 * 3_600_000;
    return Array.from({ length: 96 }, (_, step) => { const instant = start + step * 30 * 60_000; return { timeZone, instant: new Date(instant).toISOString(), stamp: localStamp(formatter, instant) }; });
  });
  // Built through the protocol schema so every sample is a schedule the runtime could have stored.
  const schedule = (cadence: 'once' | 'daily' | 'weekly', timeZone: string, localTime: string, startAt: string, extra: Record<string, unknown> = {}) => ScheduleSchema.parse({
    id: '00000000-0000-4000-8000-0000000000b1', name: 'Fixture', enabled: true, projectPath: null, taskId: null, kind: 'reminder', title: 'Fixture', body: '',
    cadence, localTime, timeZone, startAt, weekDay: null, ...extra,
  });
  const schedules = [
    schedule('daily', 'America/New_York', '09:00', '2026-01-01T00:00:00.000Z'),
    schedule('weekly', 'Europe/London', '08:30', '2026-01-01T00:00:00.000Z', { weekDay: 1 }),
    schedule('once', 'America/New_York', '02:30', '2026-03-01T00:00:00.000Z', { startDate: '2026-03-08' }),
    schedule('daily', 'Australia/Lord_Howe', '02:15', '2026-09-01T00:00:00.000Z'),
  ];
  const nows = ['2025-12-31T23:00:00.000Z', '2026-03-08T06:59:00.000Z', '2026-03-08T07:30:00.000Z', '2026-03-09T13:59:00.000Z', '2026-03-09T14:00:00.000Z', '2026-10-04T15:30:00.000Z', '2026-10-05T16:00:00.000Z'];
  const due = schedules.flatMap(item => nows.map(now => {
    try { return { schedule: item, now, due: dueOccurrence(item, new Date(now)) }; }
    catch (error) { return { schedule: item, now, ...failure(error) }; }
  }));
  let unknownZone: { error: string } | null = null;
  try { scheduleFormatter('Mars/Olympus_Mons'); } catch (error) { unknownZone = failure(error); }
  return { resolved, stamps, due, unknownZone };
}

/** Redactor output, including the JavaScript regex edges a .NET port must reproduce (ASCII \b and \w, Unicode \s). */
export function redactionVectors() {
  const secrets = ['hunter2-correct-horse', 'quote"back\\slash\nnewline-secret', '\u00fcn\u00efc\u00f8d\u00e9-s\u00ebcret'];
  const redactor = new Redactor();
  for (const secret of secrets) redactor.add(secret);
  const escapedOnce = JSON.stringify(secrets[1]).slice(1, -1);
  const token = 'abcdefghijklmnop';
  const texts = [
    `before ${secrets[0]} after`, `json ${escapedOnce}`, `json twice ${JSON.stringify(escapedOnce).slice(1, -1)}`, `unicode ${secrets[2]}`, 'too short abc',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY----- tail', '-----BEGIN PRIVATE KEY-----\nunterminated to end of input',
    `sk-${token}`, `sk-${token.slice(1)}`, `\u00e9sk-${token}`, `_sk-${token}`, `sk-${token}\u00e9`, `x sk-${token}-_ y`,
    `ghp_${token}abcd`, `gho_${token}abcd`, `ghu_${token}abcd`, `ghs_${token}abcd`, `ghr_${token}abcd`, `ghx_${token}abcd`, `github_pat_${token}abcd`,
    'Authorization: Bearer abc.def', 'authorization=bearer  xyz', 'AUTHORIZATION:token123', 'Authorization:\u00a0Bearer\u00a0nbsp-token',
    'Authorization:\uFEFFbom-token', 'Authorization:\u0085nel-token', 'Authorization:\u2028ls-token',
    'api_key=abc', 'api-key: abc', 'apikey=abc', 'API_KEY = abc', 'password=hunter', 'Password=hunter', 'pAsSwOrD=hunter',
    'client_secret: shh', 'access_token=tok,next', 'password=value;next', 'password="quoted"', "password='single'", 'password=a b',
    'api_\u212Aey=kelvin', '\u00e9api_key=x', `bearer ${token}`, `Bearer ${token}==`, `bearer ${token.slice(1)}`, `bearer\u00a0${token}`,
  ];
  return { secrets, cases: texts.map(text => ({ input: encode(text), output: encode(redactor.text(text)) })) };
}

/** MCP configuration admission: forbidden and reserved environment names and secret-screened fields. */
export function mcpConfigVectors() {
  const base: McpServerConfig = { id: '00000000-0000-4000-8000-0000000000c1', key: 'fixture', name: 'Fixture', command: 'C:\\tools\\server.exe', arguments: [], cwd: '', environment: {}, enabled: true, readOnlyTools: [], callTimeoutMs: 60000 };
  const environmentNames = ['FOO', 'API_KEY', 'MY_TOKEN', 'AUTH', 'AUTHOR', 'OAUTH', 'GH_PAT', 'PATH', 'Path', 'NODE_OPTIONS', 'HTTP_PROXY', 'KEYS', 'MONKEY', 'SESSION_ID', 'SIGNING_CERT', 'PWD', 'PASSWD', 'COOKIE_JAR', 'PRIVATE_DIR', 'psmodulepath'];
  const redactor = new Redactor();
  redactor.add('registered-mcp-secret');
  const attempt = (name: string, config: unknown) => {
    try { checkMcpConfig(config, redactor); return { name, config: encode(config), accepted: true }; }
    catch (error) { return { name, config: encode(config), accepted: false, ...failure(error) }; }
  };
  return [
    ...environmentNames.map(key => attempt(`environment name ${key}`, { ...base, environment: { [key]: 'value' } })),
    attempt('plain argument', { ...base, arguments: ['--port', '8080'] }),
    attempt('token-like argument', { ...base, arguments: ['--token=sk-abcdefghijklmnop'] }),
    attempt('token after non-ASCII letter', { ...base, arguments: ['\u00e9sk-abcdefghijklmnop'] }),
    attempt('NUL in argument', { ...base, arguments: ['a\0b'] }),
    attempt('registered secret in cwd', { ...base, cwd: 'C:\\registered-mcp-secret' }),
    attempt('labelled secret in environment value', { ...base, environment: { SETTING: 'password=hunter' } }),
    attempt('unknown property', { ...base, extra: true }),
  ];
}
