import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CorpusSchemas } from '../golden/rpc-corpus';

function operation(fn: unknown): string {
  const source = String(fn);
  if (source.includes('input.trim()')) return 'trim';
  if (source.includes('new Date(value).toISOString()')) return 'iso';
  if (source.includes('Date.parse(value.from)')) return 'date-range';
  if (source.includes('parsed.toISOString().slice(0, 10)')) return 'calendar-date';
  if (source.includes('Intl.DateTimeFormat')) return 'time-zone';
  if (source.includes('new URL(value)')) return 'http-url';
  if (source.includes('CHANNEL_LIMITS.messageBytes')) return 'channel-bytes';
  if (source.includes('supportedEfforts')) return 'effort';
  if (source.includes('value.result') && source.includes('value.error')) return 'reply-exclusive';
  throw new Error(`Unmapped contract operation: ${source}`);
}

// Build-time metadata only. The runtime never executes zod, JS, or corpus inputs.
function rule(schema: unknown): unknown {
  const node = schema as { _zod: { def: Record<string, unknown> } };
  const d = node._zod.def;
  const out: Record<string, unknown> = { type: d.type };
  for (const key of ['innerType', 'element', 'keyType', 'valueType', 'in', 'out']) if (d[key]) out[key] = rule(d[key]);
  if (d.type === 'object') { out.shape = Object.fromEntries(Object.entries(d.shape as Record<string, unknown>).map(([k, v]) => [k, rule(v)])); out.strict = !!d.catchall && (d.catchall as typeof node)._zod.def.type === 'never'; }
  if (d.options) out.options = (d.options as unknown[]).map(rule);
  if (d.entries) out.values = Object.values(d.entries as object);
  if (d.values) out.values = d.values;
  if (d.type === 'default' || d.type === 'prefault') out.defaultValue = d.defaultValue;
  if (d.type === 'transform') out.transform = operation(d.transform);
  if (d.checks) out.checks = (d.checks as typeof node[]).map(c => Object.fromEntries(Object.entries(c._zod.def).filter(([k]) => !['when', 'error', 'abort'].includes(k)).map(([k, v]) => [k, v instanceof RegExp ? v.source : typeof v === 'function' ? operation(v) : v])));
  for (const key of ['format', 'pattern', 'minLength', 'maxLength']) if (d[key] !== undefined) out[key] = d[key] instanceof RegExp ? (d[key] as RegExp).source : d[key];
  return out;
}

describe('P1 protocol metadata', () => {
  it('is deterministic and covers every frozen contract', () => {
    const generated = Object.fromEntries(Object.entries(CorpusSchemas).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, schema]) => [name, rule(schema)]));
    const path = resolve('src/Foundry.Protocol/Contracts.json');
    if (process.env.P1_WRITE_CONTRACTS === '1') writeFileSync(path, JSON.stringify(generated, null, 2) + '\n');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(generated);
    // The approved plan's 86 count predates three existing contracts; freeze the actual surface.
    expect(Object.keys(generated).filter(name => name.startsWith('rpc '))).toHaveLength(89);
    expect(Object.keys(generated).filter(name => name.startsWith('frame ') && !['frame rpc request', 'frame rpc response'].includes(name))).toHaveLength(5);
  });
});
