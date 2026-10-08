import { afterAll, describe, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { encode } from './encoding';
import { golden } from './golden-file';

/**
 * Spike S8 oracle (docs/wpf-webview2-migration.md): what better-sqlite3 13.0.3 returns for the SQL features the schema
 * and queries depend on, run against copies of every era fixture. The C# engine must return the same rows
 * (tests/Foundry.Runtime.Tests). Engine identity and compile options are recorded so differences are deliberate.
 */
const fixtures = fileURLToPath(new URL('../fixtures/databases', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'foundry-sqlite-engine-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Query = { id: string; sql: string; params?: unknown[]; when?: string };

// The real search statement from packages/runtime/src/workspace-queries.ts (search phase "messages"), with fixed arguments.
const SEARCH = `SELECT m.id, m.task_id, m.ordinal FROM messages_fts
  JOIN messages m ON m.rowid = messages_fts.rowid JOIN tasks t ON t.id = m.task_id
  JOIN tasks root ON root.id = COALESCE(t.parent_task_id, t.id)
  WHERE messages_fts MATCH ? AND m.ordinal <= ? AND m.ordinal < ? ORDER BY m.ordinal DESC LIMIT ?`;

const QUERIES: Query[] = [
  { id: 'integrity', sql: 'PRAGMA integrity_check' },
  { id: 'foreign keys', sql: 'PRAGMA foreign_key_check' },
  { id: 'user version', sql: 'PRAGMA user_version' },
  { id: 'schema objects', sql: "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name" },
  { id: 'autoincrement state', sql: 'SELECT name, seq FROM sqlite_sequence ORDER BY name' },
  { id: 'task documents', sql: "SELECT id, json_extract(data, '$.title'), json_extract(data, '$.status'), json_type(data, '$.mode'), json_valid(data) FROM tasks ORDER BY rowid" },
  { id: 'message order', sql: 'SELECT id, task_id, ordinal, length(data) FROM messages ORDER BY task_id, ordinal' },
  { id: 'events', sql: 'SELECT sequence, type, task_id, created_at FROM events ORDER BY sequence' },
  { id: 'intent task index', sql: "SELECT id, kind, state, json_extract(data, '$.taskId') FROM intents WHERE json_valid(data) ORDER BY rowid" },
  { id: 'intent index plan', sql: "EXPLAIN QUERY PLAN SELECT id FROM intents WHERE json_valid(data) AND json_extract(data, '$.taskId') = ?", params: ['00000000-0000-4000-8000-000000000000'], when: 'intents_task_json' },
  { id: 'root task paging', sql: 'SELECT id FROM tasks WHERE parent_task_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 5', when: 'tasks_root_created' },
  { id: 'root task paging plan', sql: 'EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE parent_task_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 5', when: 'tasks_root_created' },
  { id: 'provider requests', sql: 'SELECT * FROM provider_requests ORDER BY rowid' },
  { id: 'search demo', sql: SEARCH, params: ['"demo"', 1_000_000, 1_000_001, 20], when: 'messages_fts' },
  { id: 'search two tokens', sql: SEARCH, params: ['"Hello" AND "team"', 1_000_000, 1_000_001, 20], when: 'messages_fts' },
  { id: 'search CJK token', sql: SEARCH, params: ['"漢字"', 1_000_000, 1_000_001, 20], when: 'messages_fts' },
  { id: 'search accent folding', sql: SEARCH, params: ['"unicode"', 1_000_000, 1_000_001, 20], when: 'messages_fts' },
  { id: 'search prefix', sql: "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'interr*' ORDER BY rowid", when: 'messages_fts' },
  { id: 'built-in text functions', sql: "SELECT lower('ÄÖÉ'), upper('äöé'), 'a' = 'A', 'a' LIKE 'A', 'é' LIKE 'É', length('\u{1F600}'), instr('ab\u{1F600}c', 'c'), hex('é')" },
  { id: 'json functions', sql: `SELECT json_quote('é\u{1F600}'), json('{"b":1,"a":2}'), json_extract('{"n":1.0,"i":10}', '$.n'), json_extract('{"n":1.0}', '$.n') = 1, json_type('{"n":1.0}', '$.n'), json_valid('{"a":1,}'), json_array_length('[1,[2]]')` },
  { id: 'number formatting', sql: "SELECT printf('%.3f', 0.1 + 0.2), 0.1 + 0.2, 9007199254740993, CAST('4.0' AS INTEGER), CAST(4.5 AS INTEGER), 1e21, typeof(1e21)" },
  { id: 'date functions', sql: "SELECT datetime('2026-03-08T02:30:00Z'), strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-08 12:00:00.123'), julianday('2026-01-01'), unixepoch('2026-01-01T00:00:00Z')" },
  { id: 'double-quoted string literal', sql: 'SELECT "no_such_column_literal"' },
];

function run(database: Database.Database, query: Query) {
  try {
    const rows = database.prepare(query.sql).raw(true).all(...(query.params ?? [])) as unknown[][];
    // EXPLAIN QUERY PLAN ids depend on the engine build; keep the plan text, which names the index used.
    const result = query.sql.startsWith('EXPLAIN QUERY PLAN') ? rows.map(row => [row.at(-1)]) : rows;
    return { id: query.id, rows: encode(result) };
  } catch (error) {
    return { id: query.id, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Query a copy: opening a fixture in place would create -wal/-shm files beside it. */
function fixtureResults(name: string) {
  const copy = mkdtempSync(join(scratch, `${name}-`));
  for (const file of readdirSync(join(fixtures, name)).filter(item => item.startsWith('workspace.db'))) copyFileSync(join(fixtures, name, file), join(copy, file));
  const database = new Database(join(copy, 'workspace.db'));
  try {
    const objects = new Set((database.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map(row => row.name));
    return QUERIES.filter(query => !query.when || objects.has(query.when)).map(query => run(database, query));
  } finally { database.close(); }
}

describe('SQLite engine parity oracle for the WPF migration (spike S8)', () => {
  it('pins better-sqlite3 results for every era fixture', () => {
    const engine = new Database(':memory:');
    const identity = { version: engine.prepare('SELECT sqlite_version()').pluck().get(), compileOptions: engine.prepare('PRAGMA compile_options').pluck().all() };
    engine.close();
    const names = readdirSync(fixtures).filter(name => existsSync(join(fixtures, name, 'workspace.db'))).sort();
    golden('sqlite-engine', { engine: identity, queries: QUERIES.map(({ id, sql, params, when }) => ({ id, sql, params: params ? encode(params) : [], when: when ?? null })), fixtures: Object.fromEntries(names.map(name => [name, fixtureResults(name)])) });
  });
});
