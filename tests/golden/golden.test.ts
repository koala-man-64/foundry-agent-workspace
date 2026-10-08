import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsJsonVectors, manifestVectors, mcpConfigVectors, profileFingerprintVectors, redactionVectors, scheduleVectors } from './vectors';
import { rpcCorpus, wireCases } from './rpc-corpus';

// The checked-in vectors pin TypeScript behavior while it remains the authority. Regenerate deliberately with
// UPDATE_GOLDEN=1 pnpm vitest run --project unit tests/golden, then review the diff like any behavior change.
const directory = fileURLToPath(new URL('./data', import.meta.url));
const update = process.env.UPDATE_GOLDEN === '1';
const generator = { node: process.versions.node, icu: process.versions.icu, tz: process.versions.tz, unicode: process.versions.unicode };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRecordList = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.length > 0 && value.every(isRecord);

/** One compact line per record, nesting only where a record holds a list of records: small files, reviewable diffs. */
function format(value: unknown, indent = ''): string {
  const inner = `${indent}  `;
  if (isRecordList(value)) {
    const lines = value.map(item => inner + (Object.values(item).some(isRecordList) ? format(item, inner) : JSON.stringify(item)));
    return `[\n${lines.join(',\n')}\n${indent}]`;
  }
  if (isRecord(value) && Object.values(value).some(item => isRecord(item) || isRecordList(item))) {
    const lines = Object.entries(value).map(([key, item]) => `${inner}${JSON.stringify(key)}: ${format(item, inner)}`);
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function golden(name: string, content: unknown): void {
  const path = join(directory, `${name}.json`);
  if (update) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, `${format({ generator, content })}\n`);
    return;
  }
  expect(existsSync(path), `${name}.json is missing; regenerate the golden vectors`).toBe(true);
  // Generator versions are recorded for diagnosis only; the content is the contract.
  const stored = JSON.parse(readFileSync(path, 'utf8')) as { content: unknown };
  expect(stored.content).toEqual(JSON.parse(JSON.stringify(content)));
}

describe('golden vectors for the WPF migration', () => {
  it('pins JSON.stringify output and hashes', () => golden('jsjson', jsJsonVectors()));
  it('pins both profile fingerprint variants', () => golden('profile-fingerprint', profileFingerprintVectors()));
  it('pins handoff manifest ordering and hashes', () => golden('manifest', manifestVectors()));
  it('pins schedule wall-clock resolution', () => golden('schedules', scheduleVectors()));
  it('pins redaction output', () => golden('redaction', redactionVectors()));
  it('pins MCP configuration admission', () => golden('mcp-config', mcpConfigVectors()));
  it('seeds every protocol schema and pins zod verdicts', () => {
    const { entries, unseeded } = rpcCorpus();
    expect(unseeded).toEqual([]);
    golden('rpc-corpus', entries);
  });
  it('pins wire-level parser cases', () => golden('rpc-wire', wireCases()));
});
