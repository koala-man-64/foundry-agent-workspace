import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Store } from '../../packages/runtime/src/store';

/**
 * The contract for opening an adopted database (docs/wpf-webview2-migration.md, "Data compatibility"): what the current
 * TypeScript Store changes when it opens each era's fixture. That covers the user_version stamp, the DDL re-run on every
 * open, and recover()'s row transitions. The C# Store must produce the same differences. Regenerate deliberately with
 * UPDATE_GOLDEN=1 after regenerating the fixtures (scripts/fixtures/generate-fixture-databases.mjs).
 */
const fixtures = fileURLToPath(new URL('../fixtures/databases', import.meta.url));
const update = process.env.UPDATE_GOLDEN === '1';
const scratch: string[] = [];

type Row = Record<string, unknown>;
type Dump = { userVersion: number; schema: string[]; tables: Record<string, Map<number, Row>> };

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\b/g;

function copyFixture(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `foundry-fixture-${name}-`));
  scratch.push(directory);
  for (const file of readdirSync(join(fixtures, name)).filter(item => item.startsWith('workspace.db'))) copyFileSync(join(fixtures, name, file), join(directory, file));
  return join(directory, 'workspace.db');
}

/** Logical content: ordinary and virtual tables by rowid, skipping FTS shadow tables and SQLite internals. */
function dump(path: string): Dump {
  const database = new Database(path);
  try {
    const objects = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { type: string; name: string; sql: string | null }[];
    const virtual = objects.filter(item => item.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(item.sql ?? '')).map(item => item.name);
    const shadow = (name: string) => virtual.some(base => name.startsWith(`${base}_`));
    const tables: Dump['tables'] = {};
    for (const { name } of objects.filter(item => item.type === 'table' && !shadow(item.name))) {
      const rows = database.prepare(`SELECT rowid AS __rowid, * FROM "${name}" ORDER BY rowid`).all() as Row[];
      tables[name] = new Map(rows.map(({ __rowid, ...row }) => [Number(__rowid), row]));
    }
    return {
      userVersion: Number(database.pragma('user_version', { simple: true })),
      schema: objects.map(item => `${item.type} ${item.name}: ${(item.sql ?? '').replace(/\s+/g, ' ').trim()}`),
      tables,
    };
  } finally { database.close(); }
}

/** Mask identifiers and timestamps that did not exist before opening: recovery mints them from the clock and randomness. */
function maskerFor(before: Dump): (value: unknown) => unknown {
  const known = new Set<string>();
  for (const rows of Object.values(before.tables)) for (const row of rows.values()) for (const value of Object.values(row)) {
    if (typeof value === 'string') for (const match of value.matchAll(UUID)) known.add(match[0].toLowerCase());
    if (typeof value === 'string') for (const match of value.matchAll(TIMESTAMP)) known.add(match[0]);
  }
  const minted = new Map<string, string>();
  return value => typeof value !== 'string' ? value : value
    .replace(UUID, match => known.has(match.toLowerCase()) ? match : (minted.get(match) ?? (minted.set(match, `<new-id-${minted.size + 1}>`), minted.get(match)!)))
    .replace(TIMESTAMP, match => known.has(match) ? match : '<recovered-at>');
}

function differences(before: Dump, after: Dump) {
  const mask = maskerFor(before);
  const maskRow = (row: Row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, mask(value)]));
  const changes: Record<string, { added: Row[]; removed: Row[]; changed: { rowid: number; before: Row; after: Row }[] }> = {};
  for (const name of new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])) {
    const old = before.tables[name] ?? new Map<number, Row>(); const next = after.tables[name] ?? new Map<number, Row>();
    const added = [...next].filter(([rowid]) => !old.has(rowid)).map(([rowid, row]) => ({ rowid, ...maskRow(row) }));
    const removed = [...old].filter(([rowid]) => !next.has(rowid)).map(([rowid, row]) => ({ rowid, ...row }));
    const changed = [...next].filter(([rowid, row]) => old.has(rowid) && JSON.stringify(old.get(rowid)) !== JSON.stringify(row))
      .map(([rowid, row]) => {
        const previous = old.get(rowid)!;
        const keys = Object.keys({ ...previous, ...row }).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(row[key]));
        return { rowid, before: Object.fromEntries(keys.map(key => [key, previous[key]])), after: Object.fromEntries(keys.map(key => [key, mask(row[key])])) };
      });
    if (added.length || removed.length || changed.length) changes[name] = { added, removed, changed };
  }
  return { userVersion: { before: before.userVersion, after: after.userVersion }, schemaAfter: after.schema, changes };
}

afterEach(() => { while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true }); });

const names = existsSync(fixtures) ? readdirSync(fixtures).filter(name => existsSync(join(fixtures, name, 'workspace.db'))).sort() : [];

describe('fixture databases for the WPF migration', () => {
  it('finds every generated era', () => expect(names).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal']));

  // Opening a WAL database, even read-only, creates or rewrites -wal and -shm files. Fixtures must stay the bytes the
  // eras wrote, so only v5-wal may carry a WAL pair; inspect copies, never the fixtures themselves.
  it('keeps ordinary fixtures as single files and the WAL fixture as a WAL pair', () => {
    for (const name of names) {
      const sidecars = readdirSync(join(fixtures, name)).filter(file => file === 'workspace.db-wal' || file === 'workspace.db-shm').sort();
      expect(sidecars, name).toEqual(name === 'v5-wal' ? ['workspace.db-shm', 'workspace.db-wal'] : []);
    }
  });

  for (const name of names) {
    it(`pins what opening the ${name} fixture changes`, () => {
      const path = copyFixture(name);
      const before = dump(copyFixture(name)); // A separate copy: reading it must not disturb the one the Store opens.
      new Store(path).close();
      const result = JSON.parse(JSON.stringify(differences(before, dump(path)))) as unknown;
      const expected = join(fixtures, name, 'expected-after-open.json');
      if (update) { writeFileSync(expected, `${JSON.stringify(result, null, 1)}\n`); return; }
      expect(result).toEqual(JSON.parse(readFileSync(expected, 'utf8')));
    });
  }
});
