import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../../packages/runtime/src/store';
import { WorkspaceQueries } from '../../packages/runtime/src/workspace-queries';
import { Redactor } from '../../packages/runtime/src/redaction';

type Statement = { sql: string; values: unknown[] };
const insert = (table: string, id: string, data: unknown): Statement => ({ sql: `INSERT INTO ${table}(id,data) VALUES($p0,$p1)`, values: [id, JSON.stringify(data)] });
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const profile = (index: number, extra?: unknown) => ({ id: uuid(index), name: 'Fixture ' + index, apiKind: 'fake', endpoint: '', deployment: 'fixture', contextLimit: 32000, outputLimit: 2048, ...(extra ? { retained: extra } : {}) });
const populated = Array.from({ length: 30 }, (_, index) => insert('profiles', uuid(index + 2), profile(index + 2)));
const scenarios: { name: string; era?: string; setup: Statement[] }[] = [
  ...[undefined, 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => ({ name: era ?? 'fresh', era, setup: [] })),
  { name: 'item-limit', setup: populated },
  { name: 'byte-limit-unicode', setup: [insert('profiles', uuid(2), profile(2, '😀\\"'.repeat(10000))), insert('profiles', uuid(3), profile(3, 'é'.repeat(16000)))] },
  { name: 'oversized-first-profile', setup: [{ sql: 'DELETE FROM profiles', values: [] }, insert('profiles', uuid(2), profile(2, 'fixture'.repeat(20000)))] },
  { name: 'preferences-and-sequence', setup: [
    { sql: 'INSERT INTO workspace_preferences(id,data) VALUES(1,$p0)', values: [JSON.stringify({ profileId: uuid(1), mode: 'chat', collapsedProjectIds: [uuid(2)], retained: { unknown: true } })] },
    { sql: "INSERT INTO events(type,data,created_at) VALUES('fixture','{}','2026-01-01T00:00:00.000Z')", values: [] }
  ] },
  { name: 'network-project', setup: [{ sql: 'INSERT INTO projects(id,path_key,data) VALUES($p0,$p1,$p2)', values: [uuid(2), 'fixture-network', JSON.stringify({ id: uuid(2), path: '/\\fixture.invalid/share', name: 'fixture', kind: 'folder', hidden: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', retained: true })] }] }
];

it('pins summary results to the shipping TypeScript queries on disposable data', () => {
  const cases = scenarios.map(scenario => {
    const scratch = mkdtempSync(join(tmpdir(), 'foundry-p1-summary-'));
    try {
      if (scenario.era) for (const file of readdirSync(`tests/fixtures/databases/${scenario.era}`).filter(file => file.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${scenario.era}/${file}`, join(scratch, file));
      const store = new Store(join(scratch, 'workspace.db'));
      try {
        // Keep fixture paths out of machine-global directories. Only disposable
        // copies change; wire expectations retain the committed original paths.
        const projectPaths = new Map<string, string>();
        const scratchCanonical = realpathSync.native(scratch);
        if (scenario.era && store.schemaVersion >= 3) {
          for (const row of store.db.prepare('SELECT id,data FROM projects').all() as { id: string; data: string }[]) {
            const project = JSON.parse(row.data) as { path: string };
            const relativePath = join('projects', String(projectPaths.size));
            const folder = join(scratch, relativePath);
            mkdirSync(folder, { recursive: true });
            const canonical = realpathSync.native(folder);
            expect(relative(scratchCanonical, canonical)).toBe(relativePath);
            projectPaths.set(canonical, project.path);
            project.path = canonical;
            store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project), row.id);
          }
        }
        for (const statement of scenario.setup) store.db.prepare(statement.sql).run(Object.fromEntries(statement.values.map((value, index) => [`p${index}`, value])));
        const queries = new WorkspaceQueries(store, new Redactor());
        let expected: { projects: { path: string }[] };
        try { expected = queries.dispatch('workspace.summary', {}) as typeof expected; }
        catch (error) { if (!(error instanceof Error)) throw error; return { ...scenario, error: error.message }; }
        for (const project of expected.projects) project.path = projectPaths.get(project.path) ?? project.path;
        const missing = projectPaths.keys().next().value;
        if (missing !== undefined) {
          expect(relative(scratchCanonical, missing)).toBe(join('projects', '0'));
          rmSync(missing, { recursive: true });
          const unavailable = (queries.dispatch('workspace.summary', {}) as { projects: { path: string; kind: string; unavailableReason?: string }[] }).projects.find(project => project.path === missing);
          expect(unavailable).toMatchObject({ kind: 'unavailable', unavailableReason: 'Folder is unavailable.' });
        }
        return { ...scenario, expected };
      } finally { store.close(); }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
  const path = 'tests/p1/summary-vectors.json';
  if (process.env.P1_WRITE_SUMMARY === '1') writeFileSync(path, JSON.stringify(cases, null, 2) + '\n');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(cases);
});
