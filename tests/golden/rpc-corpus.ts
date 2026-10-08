import { z } from 'zod';
import {
  RpcMethods, RpcRequestSchema, RpcResponseSchema, BrowserCommandSchema,
  BrowserHostCallSchema, BrowserHostReplySchema, BrowserInvalidationSchema
} from '../../packages/protocol/src/index';
import { EventSchema } from '../../apps/desktop/src/main/supervisor';
import { encode, type Tagged } from './encoding';

/**
 * Inputs the C# validators must accept or reject exactly as zod does, with zod's normalized output for accepted
 * inputs. zod is the oracle until cutover (docs/wpf-webview2-migration.md, P1 exit gate).
 */

// entry.ts:39 and the main-process IPC handlers (index.ts:115,159) declare these inline. Neither module can be
// imported by a test (entry.ts starts the runtime and index.ts starts Electron), so they are mirrored here.
const RuntimeCredentialFrame = z.object({ jsonrpc: z.literal('2.0'), id: z.string(), method: z.literal('runtime.credential'), params: z.object({ id: z.string().uuid(), value: z.string().min(4).max(8192), binding: z.string().max(4096) }).strict() }).strict();
const SaveCredentialArguments = z.object({ profileId: z.string().uuid(), value: z.string().min(4).max(8192) }).strict();
const NotificationArgument = z.object({ enabled: z.boolean() }).strict();

export const CorpusSchemas: Record<string, z.ZodType> = {
  ...Object.fromEntries(Object.entries(RpcMethods).map(([method, schema]) => [`rpc ${method}`, schema as z.ZodType])),
  'bridge workspace:browser': BrowserCommandSchema,
  'bridge workspace:save-credential': SaveCredentialArguments,
  'bridge workspace:set-notifications': NotificationArgument,
  'frame rpc request': RpcRequestSchema,
  'frame rpc response': RpcResponseSchema,
  'frame runtime.credential': RuntimeCredentialFrame,
  'frame browser.host': BrowserHostCallSchema,
  'frame browser.host.result': BrowserHostReplySchema,
  'frame browser.invalidated': BrowserInvalidationSchema,
  'frame workspace.event': EventSchema,
};

type JsonSchema = {
  type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema | JsonSchema[]; prefixItems?: JsonSchema[];
  enum?: unknown[]; const?: unknown; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; allOf?: JsonSchema[]; $ref?: string; $defs?: Record<string, JsonSchema>;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number;
  minItems?: number; pattern?: string; format?: string;
};

const UUID = '00000000-0000-4000-8000-000000000001';
const PATTERN_SAMPLES = ['09:30', '2026-10-08', 'fixture', 'origin', 'SETTING', 'u:', '0'.repeat(40), '0'.repeat(64), 'x', 'A', '0'];

const resolveRef = (root: JsonSchema, ref: string): JsonSchema =>
  ref.replace(/^#\//, '').split('/').reduce<unknown>((node, part) => (node as Record<string, unknown>)[decodeURIComponent(part)], root) as JsonSchema;

function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  return schema.$ref ? deref(resolveRef(root, schema.$ref), root) : schema;
}

function sampleString(schema: JsonSchema): string {
  if (schema.format === 'uuid') return UUID;
  if (schema.format === 'date-time') return '2026-10-08T12:00:00.000Z';
  if (schema.pattern) {
    const pattern = new RegExp(schema.pattern);
    const candidate = PATTERN_SAMPLES.find(value => pattern.test(value));
    if (candidate) return candidate;
  }
  return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
}

function sampleNumber(schema: JsonSchema, integer: boolean): number {
  const value = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : Math.min(1, schema.maximum ?? 1));
  return integer ? Math.ceil(value) : value;
}

/** A value satisfying the JSON Schema shape. Refinements that JSON Schema cannot express are repaired per method. */
function sample(schema: JsonSchema, root: JsonSchema, full: boolean): unknown {
  schema = deref(schema, root);
  if ('const' in schema) return schema.const;
  if (schema.enum) return schema.enum[0];
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) return sample(branches.find(branch => deref(branch, root).type !== 'null') ?? branches[0]!, root, full);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map(part => sample(part, root, full) as object));
  const type = Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type;
  switch (type) {
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties ?? {})
        .filter(([key]) => full || schema.required?.includes(key))
        .map(([key, property]) => [key, sample(property, root, full)]));
    case 'array': {
      const tuple = Array.isArray(schema.items) ? schema.items : schema.prefixItems;
      if (tuple) return tuple.map(item => sample(item, root, full));
      return Array.from({ length: Math.max(schema.minItems ?? 0, full ? 1 : 0) }, () => sample((schema.items as JsonSchema | undefined) ?? {}, root, full));
    }
    case 'string': return sampleString(schema);
    case 'integer': return sampleNumber(schema, true);
    case 'number': return sampleNumber(schema, false);
    case 'boolean': return full;
    case 'null': return null;
    default: return full ? {} : null;
  }
}

// Seeds for refinements and transforms JSON Schema cannot express; applied only when the sampled seed fails.
const usageRepair = (seed: Record<string, unknown>): Record<string, unknown> => ({
  ...seed,
  ...(seed.filters && typeof seed.filters === 'object' && 'from' in seed.filters ? { filters: { ...seed.filters, from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' } } : {}),
  ...('timeZone' in seed ? { timeZone: 'UTC' } : {}),
});
const SEED_REPAIRS: Record<string, (seed: Record<string, unknown>) => Record<string, unknown>> = {
  'rpc profile.save': seed => ({ ...seed, apiKind: 'responses', ...('effort' in seed ? { effort: 'low' } : {}) }),
  'rpc usage.summary': usageRepair,
  'rpc usage.breakdown': usageRepair,
  'rpc usage.requests': usageRepair,
  'bridge workspace:browser': seed => (seed.kind === 'navigate' ? { ...seed, url: 'https://example.com/' } : seed),
  'frame browser.host.result': seed => { const { error: _error, ...rest } = seed; return { ...rest, result: null }; },
};

type Case = { name: string; input: Tagged; accepted: boolean; output?: Tagged; issues?: string[] };

function verdict(schema: z.ZodType, name: string, input: unknown): Case {
  const result = schema.safeParse(input);
  return result.success
    ? { name, input: encode(input), accepted: true, output: encode(result.data) }
    : { name, input: encode(input), accepted: false, issues: result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.code}`) };
}

function* mutations(seed: Record<string, unknown>, properties: Record<string, JsonSchema>, root: JsonSchema, thorough: boolean): Generator<[string, unknown]> {
  yield ['unknown property', { ...seed, unexpected: true }];
  for (const key of Object.keys(seed)) {
    const { [key]: _removed, ...rest } = seed;
    yield [`without ${key}`, rest];
    if (!thorough) continue;
    for (const [label, value] of [['null', null], ['boolean', true], ['number', 0], ['empty string', ''], ['array', []], ['object', {}]] as const) {
      if (!Object.is(value, seed[key])) yield [`${key} as ${label}`, { ...seed, [key]: value }];
    }
    const property = properties[key] ? deref(properties[key], root) : {};
    const type = Array.isArray(property.type) ? property.type.find(item => item !== 'null') : property.type;
    if (type === 'string' && !property.pattern && !property.format) {
      if (property.maxLength !== undefined) {
        yield [`${key} at maximum length`, { ...seed, [key]: 'x'.repeat(property.maxLength) }];
        yield [`${key} over maximum length`, { ...seed, [key]: 'x'.repeat(property.maxLength + 1) }];
      }
      if ((property.minLength ?? 0) > 1) yield [`${key} under minimum length`, { ...seed, [key]: 'x'.repeat(property.minLength! - 1) }];
      yield [`${key} padded with spaces`, { ...seed, [key]: `  ${String(seed[key])}  ` }];
      yield [`${key} only spaces`, { ...seed, [key]: '   ' }];
    }
    if (property.format === 'uuid') {
      yield [`${key} uppercase uuid`, { ...seed, [key]: UUID.toUpperCase() }];
      yield [`${key} uuid without hyphens`, { ...seed, [key]: UUID.replaceAll('-', '') }];
      yield [`${key} nil uuid`, { ...seed, [key]: '00000000-0000-0000-0000-000000000000' }];
      yield [`${key} uuid with wrong variant`, { ...seed, [key]: '00000000-0000-4000-0000-000000000001' }];
    }
    if (type === 'integer' || type === 'number') {
      yield [`${key} fractional`, { ...seed, [key]: 1.5 }];
      yield [`${key} negative zero`, { ...seed, [key]: -0 }];
      yield [`${key} unsafe integer`, { ...seed, [key]: 2 ** 53 }];
      if (property.minimum !== undefined) yield [`${key} below minimum`, { ...seed, [key]: property.minimum - 1 }];
      if (property.maximum !== undefined) yield [`${key} above maximum`, { ...seed, [key]: property.maximum + 1 }];
    }
    if (property.enum) yield [`${key} unknown enum value`, { ...seed, [key]: 'not-a-listed-value' }];
    if ('const' in property) yield [`${key} wrong literal`, { ...seed, [key]: 'not-the-literal' }];
  }
}

export type CorpusEntry = { schema: string; cases: Case[] };

export function rpcCorpus(): { entries: CorpusEntry[]; unseeded: string[] } {
  const entries: CorpusEntry[] = [];
  const unseeded: string[] = [];
  for (const [name, schema] of Object.entries(CorpusSchemas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const root = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
    const top = deref(root, root);
    const shapes = top.anyOf ?? top.oneOf ?? [top];
    const cases: Case[] = [];
    shapes.forEach((shape, index) => {
      const branch = shapes.length > 1 ? ` [variant ${index + 1}]` : '';
      for (const full of [false, true]) {
        let seed = sample(shape, root, full);
        if (!schema.safeParse(seed).success && SEED_REPAIRS[name] && seed && typeof seed === 'object') seed = SEED_REPAIRS[name](seed as Record<string, unknown>);
        if (!schema.safeParse(seed).success) { unseeded.push(`${name}${branch} (${full ? 'full' : 'minimal'})`); continue; }
        const label = `${full ? 'full' : 'minimal'} seed${branch}`;
        cases.push(verdict(schema, label, seed));
        const properties = deref(shape, root).properties;
        if (seed && typeof seed === 'object' && !Array.isArray(seed) && properties) {
          for (const [mutation, input] of mutations(seed as Record<string, unknown>, properties, root, full)) cases.push(verdict(schema, `${label}: ${mutation}`, input));
        }
      }
    });
    entries.push({ schema: name, cases });
  }
  return { entries, unseeded };
}

/**
 * JSON text where JSON.parse and a strict host parser can disagree. "host" is the decided host behavior:
 * the plan fixes duplicate-key, depth and unknown-property rejection; the remaining cases are decided in spike S8.
 */
export function wireCases() {
  const id = '00000000-0000-4000-8000-0000000000d1';
  const other = '00000000-0000-4000-8000-0000000000d2';
  const deep = `${'{"a":'.repeat(40)}1${'}'.repeat(40)}`;
  const cases: { name: string; text: string; host: 'reject' | 'accept' | 'decide in S8'; basis: string }[] = [
    { name: 'duplicate key inside params', text: `{"jsonrpc":"2.0","id":"1","method":"task.cancel","params":{"taskId":"${id}","taskId":"${other}"}}`, host: 'reject', basis: 'plan: duplicate keys rejected' },
    { name: 'duplicate method in envelope', text: `{"jsonrpc":"2.0","id":"1","method":"task.cancel","method":"task.retire","params":{"taskId":"${id}"}}`, host: 'reject', basis: 'plan: duplicate keys rejected' },
    { name: '__proto__ property', text: `{"jsonrpc":"2.0","id":"1","method":"task.cancel","params":{"taskId":"${id}","__proto__":{"admin":true}}}`, host: 'reject', basis: 'strict objects reject unknown properties' },
    { name: 'nesting deeper than 32 levels', text: `{"jsonrpc":"2.0","id":"1","method":"task.cancel","params":${deep}}`, host: 'reject', basis: 'plan: MaxDepth 32' },
    { name: 'integer written with a fraction', text: `{"jsonrpc":"2.0","id":"1","method":"task.compact","params":{"taskId":"${id}","keepRecent":4.0}}`, host: 'decide in S8', basis: 'zod sees the integer 4' },
    { name: 'integer written with an exponent', text: `{"jsonrpc":"2.0","id":"1","method":"task.compact","params":{"taskId":"${id}","keepRecent":4e0}}`, host: 'decide in S8', basis: 'zod sees the integer 4' },
    { name: 'integer beyond 2^53', text: `{"jsonrpc":"2.0","id":"1","method":"task.compact","params":{"taskId":"${id}","keepRecent":9007199254740993}}`, host: 'reject', basis: 'outside the declared range in either reading' },
    { name: 'lone surrogate escape in free text', text: `{"jsonrpc":"2.0","id":"1","method":"task.send","params":{"taskId":"${id}","content":"broken \\ud800 text"}}`, host: 'decide in S8', basis: 'JSON.parse keeps a lone surrogate; strict UTF-16 readers reject it' },
    { name: 'escaped characters in the method name', text: `{"jsonrpc":"2.0","id":"1","method":"task\\u002ecancel","params":{"taskId":"${id}"}}`, host: 'accept', basis: 'both parsers decode escapes before comparison' },
    { name: 'numeric id', text: `{"jsonrpc":"2.0","id":1,"method":"task.cancel","params":{"taskId":"${id}"}}`, host: 'reject', basis: 'ids are strings' },
    { name: 'byte order mark before the message', text: `\uFEFF{"jsonrpc":"2.0","id":"1","method":"task.cancel","params":{"taskId":"${id}"}}`, host: 'reject', basis: 'JSON.parse rejects a leading BOM' },
    { name: 'trailing comma', text: `{"jsonrpc":"2.0","id":"1","method":"task.cancel","params":{"taskId":"${id}",}}`, host: 'reject', basis: 'not JSON' },
    { name: 'comment', text: `{"jsonrpc":"2.0","id":"1","method":"task.cancel",/* x */"params":{"taskId":"${id}"}}`, host: 'reject', basis: 'not JSON' },
    { name: 'NaN literal', text: `{"jsonrpc":"2.0","id":"1","method":"task.compact","params":{"taskId":"${id}","keepRecent":NaN}}`, host: 'reject', basis: 'not JSON' },
    { name: 'top-level array', text: `[{"jsonrpc":"2.0","id":"1","method":"task.cancel","params":{"taskId":"${id}"}}]`, host: 'reject', basis: 'batches are not part of the protocol' },
  ];
  return cases.map(item => {
    let parsed: unknown; let parseError: string | null = null;
    try { parsed = JSON.parse(item.text); } catch (error) { parseError = error instanceof Error ? error.name : 'Error'; }
    let zod: { envelope: boolean; params?: boolean } | null = null;
    if (parseError === null) {
      const envelope = RpcRequestSchema.safeParse(parsed);
      zod = { envelope: envelope.success };
      if (envelope.success) zod.params = (RpcMethods as Record<string, z.ZodType>)[envelope.data.method]!.safeParse(envelope.data.params).success;
    }
    return { ...item, jsonParse: parseError === null ? { value: encode(parsed) } : { error: parseError }, zod };
  });
}
