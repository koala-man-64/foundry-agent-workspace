import { expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Checked-in vectors pin TypeScript behavior while it remains the authority. Regenerate deliberately with
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

/** Write (UPDATE_GOLDEN=1) or compare tests/golden/data/<name>.json. Generator versions are recorded, never compared. */
export function golden(name: string, content: unknown): void {
  const path = join(directory, `${name}.json`);
  if (update) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, `${format({ generator, content })}\n`);
    return;
  }
  expect(existsSync(path), `${name}.json is missing; regenerate the golden vectors`).toBe(true);
  const stored = JSON.parse(readFileSync(path, 'utf8')) as { content: unknown };
  expect(stored.content).toEqual(JSON.parse(JSON.stringify(content)));
}
