import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID, pathKey } from '../../packages/runtime/src/store';
import type { ModelProfile, Project, WorkspacePreferences } from '../../packages/protocol/src/index';
import { regenerating } from './oracle-node.mjs';

const ids = vi.hoisted(() => ({ next: 2 }));
vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(ids.next++).padStart(12, '0')}` as ReturnType<typeof import('node:crypto').randomUUID> }));

it('pins workspace persistence results and exact stored JSON to the shipping Store', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-workspace-'));
  const directory = join(scratch, 'Project'); mkdirSync(directory);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z')); ids.next = 2;
  const store = new Store(join(scratch, 'workspace.db'));
  const steps: unknown[] = [];
  const record = (name: string, value: unknown) => steps.push({ name, value: value ?? null,
    profiles: store.db.prepare('SELECT rowid AS _rowid,id,data FROM profiles ORDER BY rowid').all(),
    projects: store.db.prepare('SELECT rowid AS _rowid,id,path_key,data FROM projects ORDER BY rowid').all(),
    preferences: store.db.prepare('SELECT rowid AS _rowid,id,data FROM workspace_preferences ORDER BY rowid').all(),
    starts: store.db.prepare('SELECT rowid AS _rowid,* FROM task_starts ORDER BY rowid').all() });
  try {
    record('defaults', store.preferences());
    record('missing-profile', store.profile('missing'));
    const profile = { ...store.profile(FAKE_PROFILE_ID)!, opaque: { future: [1, null, 'keep'] } };
    store.saveProfile(profile as ModelProfile); record('save-profile', store.profile(FAKE_PROFILE_ID));
    record('missing-project', store.project('missing'));
    const project = store.insertProject(directory); record('insert-project', project);
    record('path-alias', store.projectByPath(directory.toUpperCase()));
    const updated = { ...project, name: 'Renamed', hidden: true, future: { keep: true } };
    record('save-project', store.saveProject(updated as Project));
    record('list-projects', store.projects());
    record('save-preferences', store.savePreferences({ ...store.preferences(), mode: 'coding', collapsedProjectIds: [project.id], future: [true, null] } as WorkspacePreferences));
    store.reserveTaskStart('request-1', 'hash-1', 'task-1'); record('reserve', store.taskStart('request-1'));
    store.finishTaskStart('request-1', 'failed'); record('failed', store.taskStart('request-1'));
    store.clearTaskStart('request-1'); record('retain-failed', store.taskStart('request-1'));
    store.finishTaskStart('request-1', 'pending'); store.clearTaskStart('request-1'); record('clear-pending', store.taskStart('request-1'));
    store.reserveTaskStart('request-2', 'hash-2', 'task-2'); store.finishTaskStart('request-2', 'complete'); record('complete', store.taskStart('request-2'));
    store.reserveTaskStart('request-3', 'hash-3', 'task-3'); store.finishTaskStart('request-3', 'unknown'); store.clearTaskStart('request-3'); record('retain-unknown', store.taskStart('request-3'));
    record('events', store.db.prepare('SELECT COUNT(*) AS count FROM events').get());
    const corpus = JSON.parse(JSON.stringify(steps, (_key, value: unknown) => typeof value === 'string'
      ? value.replaceAll(directory, '$project').replaceAll(JSON.stringify(directory).slice(1, -1), '$project')
        .replaceAll(pathKey(directory), '$project-key').replaceAll(JSON.stringify(pathKey(directory)).slice(1, -1), '$project-key') : value));
    if (regenerating('P2_WRITE_WORKSPACE')) writeFileSync('tests/p2/workspace-store-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/workspace-store-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { store.close(); vi.useRealTimers(); rmSync(scratch, { recursive: true, force: true }); }
});
