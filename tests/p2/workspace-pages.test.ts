import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { WorkspaceQueries } from '../../packages/runtime/src/workspace-queries';
import { Redactor } from '../../packages/runtime/src/redaction';
import type { ModelProfile, Task } from '../../packages/protocol/src/index';
import type { TaskPage, WorkspaceMethod } from '../../packages/protocol/src/workspace';

const timestamp = '2026-01-02T03:04:05.678Z';
const id = (n: number) => `66666666-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tasks = Array.from({ length: 12 }, (_, index) => {
  const n = index + 1;
  return { id: id(n), title: `Page ${n}`, profileId: FAKE_PROFILE_ID, status: n % 3 === 0 ? 'failed' : 'idle',
    createdAt: `2026-01-0${1 + n % 3}T03:04:05.678Z`, updatedAt: `2026-01-0${4 + n % 3}T03:04:05.678Z`, tokenBudget: 100000, usedTokens: 0,
    mode: n % 4 === 0 ? 'coordinated' : n % 2 === 0 ? 'coding' : 'chat', workspaceKind: 'none', projectPath: n % 2 === 0 ? 'C:\\fixture-pages' : '',
    ...(n % 2 === 0 ? { projectId: id(80) } : {}), ...(n % 5 === 0 ? { archivedAt: timestamp } : n === 6 ? { archivedAt: '' } : {}),
    ...(n === 11 ? { parentTaskId: id(4), rootTaskId: id(4) } : n === 12 ? { parentTaskId: '' } : {}),
    future: { kept: n } };
});
const largeTasks = [13, 14, 15, 16].map(n => ({ ...tasks[0]!, id: id(n), status: 'retired', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', projectId: id(n === 16 ? 81 : 82), future: { kept: n, opaque: 'x'.repeat(n === 16 ? 256 * 1024 : 100 * 1024) } }));
const mixedCaseTasks = ['aaaaaaaa-0000-4000-8000-000000000001', 'AAAAAAAA-0000-4000-8000-000000000001'].map(key => ({ ...tasks[0]!, id: key, projectId: id(83) }));
const boundaryTasks = [18, 19].map(n => {
  const task = { ...tasks[0]!, id: id(n), projectId: id(n + 66), future: { kept: n, opaque: '' } };
  task.future.opaque = 'x'.repeat(256 * 1024 - 1024 - Buffer.byteLength(JSON.stringify({ tasks: [task] })) + (n === 19 ? 1 : 0));
  return task;
});
const allTasks = [...tasks, ...largeTasks, ...mixedCaseTasks, ...boundaryTasks];
const profiles = [90, 91, 92].map(n => ({ id: id(n), name: `Page profile ${n}`, apiKind: 'fake', endpoint: '', deployment: 'fixture', contextLimit: 32000, outputLimit: 2048, future: { opaque: 'x'.repeat(n === 90 ? 270 * 1024 : 70 * 1024) } }));
for (const n of [93, 94]) {
  const profile = { ...profiles[0]!, id: id(n), future: { opaque: '' } };
  profile.future.opaque = 'x'.repeat(128 * 1024 - Buffer.byteLength(JSON.stringify({ profiles: [profile], nextAfter: profile.id })) + (n === 94 ? 1 : 0));
  profiles.push(profile);
}
const eventRows = [
  { type: 'fixture.normal', taskId: id(4), data: JSON.stringify({ hello: '😀', future: { kept: true } }) },
  { type: 'fixture.child', taskId: id(11), data: JSON.stringify({ child: true }) },
  { type: 'fixture.secret', taskId: id(1), data: JSON.stringify({ text: 'api_key=fixture-secret-value' }) },
  { type: 'fixture.malformed', taskId: null, data: '{bad' },
  { type: 'fixture.large', taskId: id(1), data: JSON.stringify({ text: 'x'.repeat(4096) }) }
];

it('pins read-only workspace pages, task cursors and legacy/runtime event projections in every era', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-pages-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db'))) copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        const store = new Store(join(scratch, 'workspace.db'));
        try {
          const projectPaths = new Map<string, string>(); const scratchCanonical = realpathSync(scratch);
          if (store.schemaVersion >= 3) for (const row of store.db.prepare('SELECT id,data FROM projects').all() as { id: string; data: string }[]) {
            const project = JSON.parse(row.data) as { path: string };
            const relativePath = join('projects', String(projectPaths.size)); const folder = join(scratch, relativePath);
            mkdirSync(folder, { recursive: true }); const canonical = realpathSync(folder);
            expect(relative(scratchCanonical, canonical)).toBe(relativePath);
            projectPaths.set(canonical, project.path); project.path = canonical;
            store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project), row.id);
          }
          for (const task of allTasks) store.saveTask(task as Task);
          for (const profile of profiles) store.saveProfile(profile as ModelProfile);
          for (const row of eventRows) store.db.prepare('INSERT INTO events(type,task_id,data,created_at) VALUES(?,?,?,?)').run(row.type, row.taskId, row.data, timestamp);
          const query = new WorkspaceQueries(store, new Redactor());
          const steps: Array<{ method: WorkspaceMethod; params: unknown; value: unknown; error: string | null }> = [];
          const snapshot = () => JSON.stringify({ tasks: store.db.prepare('SELECT * FROM tasks ORDER BY rowid').all(), events: store.db.prepare('SELECT * FROM events ORDER BY sequence').all(), profiles: store.db.prepare('SELECT * FROM profiles ORDER BY rowid').all() });
          const before = snapshot();
          const act = (method: WorkspaceMethod, params: unknown): unknown => {
            let value: unknown = null; let error: string | null = null;
            try { value = query.dispatch(method, params); } catch (cause) { error = (cause as Error).message; }
            if (method === 'workspace.projects' && value) for (const project of (value as { projects: { path: string }[] }).projects) project.path = projectPaths.get(project.path) ?? project.path;
            steps.push({ method, params, value, error }); expect(snapshot()).toBe(before); return value;
          };
          act('workspace.profiles', { limit: 1 }); act('workspace.profiles', { after: FAKE_PROFILE_ID, limit: 1 });
          act('profile.read', { profileId: FAKE_PROFILE_ID }); act('profile.read', { profileId: id(99) }); act('workspace.projects', { limit: 2 });
          act('profile.read', { profileId: id(90) }); act('workspace.profiles', { after: id(89), limit: 50 });
          act('workspace.profiles', { after: id(90), limit: 50 }); act('workspace.profiles', { after: id(91), limit: 50 });
          act('workspace.profiles', { after: id(92), limit: 1 }); act('workspace.profiles', { after: id(93), limit: 1 });
          for (const visibility of ['active', 'archived', 'all']) for (const sort of ['created', 'recent']) for (const filter of [{}, { mode: 'chat' }, { projectPath: 'C:\\fixture-pages', projectId: id(80) }, { status: 'failed' }, { from: '2026-01-02T00:00:00.000Z', to: '2026-01-03T23:59:59.999Z' }]) {
            const p = { visibility, sort, limit: 2, ...filter };
            const page = act('workspace.tasks', p) as TaskPage;
            if (page?.nextCursor) { act('workspace.tasks', { ...p, cursor: page.nextCursor }); act('workspace.tasks', { ...p, cursor: { ...page.nextCursor, filterHash: '0'.repeat(64) } }); act('workspace.tasks', { ...p, sort: 'recent', cursor: page.nextCursor }); }
          }
          act('workspace.tasks', { visibility: 'all', projectId: id(81), limit: 50 });
          const partial = act('workspace.tasks', { visibility: 'all', projectId: id(82), limit: 50 }) as TaskPage;
          if (partial.nextCursor) act('workspace.tasks', { visibility: 'all', projectId: id(82), limit: 50, cursor: partial.nextCursor });
          act('workspace.tasks', { visibility: 'all', projectId: id(83), limit: 50 });
          act('workspace.tasks', { visibility: 'all', projectId: id(84), limit: 50 }); act('workspace.tasks', { visibility: 'all', projectId: id(85), limit: 50 });
          let next = 0;
          for (let n = 0; n < 20; n++) { const page = act('workspace.events', { after: next, limit: 2 }) as { nextAfter: number | null }; if (page.nextAfter === null) break; next = page.nextAfter; }
          act('workspace.events', { taskId: id(1), limit: 50 }); act('workspace.events', { taskId: id(99), limit: 50 });
          act('task.timeline', { taskId: id(4), limit: 2 }); act('task.timeline', { taskId: id(4), before: 1, limit: 50 });
          act('task.timeline', { taskId: id(1), limit: 50 }); act('task.timeline', { taskId: id(99), limit: 50 });
          const missing = projectPaths.keys().next().value;
          if (missing !== undefined) {
            expect(relative(scratchCanonical, missing)).toBe(join('projects', '0')); rmSync(missing, { recursive: true });
            const page = query.dispatch('workspace.projects', { limit: 50 }) as { projects: { path: string; kind: string; unavailableReason?: string }[] };
            expect(page.projects.find(project => project.path === missing)).toMatchObject({ kind: 'unavailable', unavailableReason: 'Folder is unavailable.' });
            expect(snapshot()).toBe(before);
          }
          return { era, steps };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { timestamp, tasks: allTasks, profiles, eventRows, cases };
    if (process.env.P2_WRITE_PAGES === '1') writeFileSync('tests/p2/workspace-page-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/workspace-page-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});
