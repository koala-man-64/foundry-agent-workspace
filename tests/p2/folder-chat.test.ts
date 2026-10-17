import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { RpcMethod, WorkspaceEvent } from '../../packages/protocol/src/index';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { FAKE_PROFILE_ID, Store } from '../../packages/runtime/src/store';
import { build, committed, file, normalize, sha256File, withIsolatedGit } from './repository-fixture';

// Project-backed task.start in a saved folder that is not a Git repository, through the shipping RuntimeService with the
// offline provider: every step's value or refusal, then the task, message, request, start, event and project rows and
// the notifications so far. Identities and the clock are deterministic, as in development-chat.test.ts. The C# suite
// (FolderChatTests) replays every step through DevelopmentChat with the same identities and clock and must reproduce
// each snapshot, except where a step names an approved native difference: then native must refuse it and leave the
// previous snapshot unchanged. Placeholders: {scratch} {scratch/} {scratch-lower}; in parameters, {task} is the task the
// latest successful task.start returned and {git-project} the Git project added last.
const ids = vi.hoisted(() => ({ next: 1 }));
vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(), randomUUID: () => `77777777-0000-4000-8000-${String(ids.next++).padStart(12, '0')}` as ReturnType<typeof import('node:crypto').randomUUID> }));
const timestamp = '2026-01-02T03:04:05.678Z';
const project = '77777777-0000-4000-8000-000000000001';
const start = (requestId: number, extra: Record<string, unknown> = {}) => ({ requestId: `77777777-0000-4000-8000-9999999999${String(requestId).padStart(2, '0')}`, projectId: project, content: 'Hello folder', profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000, ...extra });
const GIT_CHAT = 'Chats in Git projects need the native tool loop, which a later runtime slice ports.';

type Step = { method: RpcMethod | 'wait' | 'rename'; params: Record<string, unknown>; native?: { error: string; difference: string } };
const steps: Step[] = [
  { method: 'project.add', params: { path: '{scratch}\\work\\plain' } },
  { method: 'task.start', params: start(1) },
  { method: 'wait', params: { taskId: '{task}' } },
  { method: 'task.read', params: { taskId: '{task}' } },
  { method: 'files.list', params: { taskId: '{task}', path: '' } },
  { method: 'task.start', params: start(1) },
  { method: 'task.send', params: { taskId: '{task}', content: 'second' } },
  { method: 'wait', params: { taskId: '{task}' } },
  { method: 'task.start', params: start(2, { mode: 'coding' }) },
  { method: 'task.start', params: start(3, { coordination: { childProfileIds: [], requiredValidation: { command: 'pnpm check', cwd: '', timeoutMs: 600000 } } }) },
  { method: 'project.update', params: { projectId: project, hidden: true } },
  { method: 'task.start', params: start(4) },
  { method: 'project.update', params: { projectId: project, hidden: false } },
  { method: 'task.start', params: start(5, { projectId: '77777777-0000-4000-8000-000000000999' }) },
  { method: 'rename', params: { from: 'work/plain', to: 'work/moved' } },
  { method: 'task.start', params: start(6) },
  { method: 'rename', params: { from: 'work/moved', to: 'work/plain' } },
  { method: 'task.start', params: start(7, { content: 'Back again' }) },
  { method: 'wait', params: { taskId: '{task}' } },
  { method: 'project.add', params: { path: '{scratch}\\work\\repo' } },
  { method: 'task.start', params: start(8, { projectId: '{git-project}' }), native: { error: GIT_CHAT, difference: 'Chats in Git projects advertise project-channel tools, which need the native tool loop of a later slice; native refuses them before any reservation.' } },
];

it('pins project-backed folder chats through the shipping Node authority without ordinary regeneration', async () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'foundry-p2-folder-chat-')));
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  // Projects live beside, not inside, the data folder's chain: the native Store pins that chain against renames.
  build(scratch, home, [{ dir: 'work/plain/sub' }, file('work/plain/a.txt', 'a\n'), ...committed([], 'work/repo')]);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp)); ids.next = 1;
  const data = path.join(scratch, 'data'); fs.mkdirSync(data);
  const store = new Store(path.join(data, 'workspace.db'));
  const events: WorkspaceEvent[] = [];
  const service = new RuntimeService(store, new RepositoryService(path.join(data, 'wt')), event => events.push(event));
  const expanded: Record<string, string> = {};
  const expand = (value: unknown): unknown => {
    if (typeof value === 'string') return Object.entries(expanded).reduce((text, [name, replacement]) => text.replaceAll(name, replacement), value.replaceAll('{scratch}', scratch));
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    return value;
  };
  try {
    const recorded: (Step & { expected: unknown })[] = [];
    const snapshot = () => normalize({
      tasks: store.db.prepare("SELECT rowid AS _rowid,* FROM tasks WHERE id LIKE '77777777-%' ORDER BY rowid").all(),
      messages: store.db.prepare("SELECT rowid AS _rowid,* FROM messages WHERE id LIKE '77777777-%' ORDER BY ordinal").all(),
      requests: store.db.prepare("SELECT rowid AS _rowid,* FROM provider_requests WHERE request_id LIKE '77777777-%' ORDER BY rowid").all(),
      starts: store.db.prepare("SELECT * FROM task_starts WHERE request_id LIKE '77777777-%' ORDER BY rowid").all(),
      events: store.db.prepare("SELECT * FROM events WHERE task_id LIKE '77777777-%' OR type = 'projects.changed' ORDER BY sequence").all(),
      projects: store.db.prepare('SELECT rowid AS _rowid,* FROM projects ORDER BY rowid').all(),
      notifications: [...events],
    }, scratch);
    await withIsolatedGit(home, async () => {
      for (const step of steps) {
        let value: unknown = null; let error: string | null = null;
        try {
          if (step.method === 'wait') {
            const taskId = expand(step.params.taskId) as string;
            for (let n = 0; store.task(taskId).status === 'running'; n++) { if (n > 2000) throw new Error('Oracle did not complete.'); await new Promise(resolve => setTimeout(resolve, 1)); }
          } else if (step.method === 'rename') fs.renameSync(path.join(scratch, step.params.from as string), path.join(scratch, step.params.to as string));
          else value = await service.dispatch(step.method, expand(step.params));
          if (step.method === 'project.add' && (value as { kind?: string }).kind === 'git') expanded['{git-project}'] = (value as { id: string }).id;
          if (step.method === 'task.start') expanded['{task}'] = (value as { id: string }).id;
        } catch (cause) { error = normalize((cause as Error).message, scratch) as string; }
        recorded.push({ ...step, expected: { value: normalize(value, scratch), error, ...(snapshot() as object) } });
      }
    });
    const corpus = {
      schemaVersion: 1, timestamp,
      oracle: { sources: ['packages/runtime/src/service.ts', 'packages/runtime/src/repository.ts', 'packages/runtime/src/agent-loop.ts', 'packages/runtime/src/store.ts'].map(source => ({ path: source, sha256: sha256File(source) })) },
      steps: recorded,
    };
    const target = 'tests/p2/folder-chat-vectors.json';
    if (process.env.P2_WRITE_FOLDER_CHAT === '1') fs.writeFileSync(target, JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(corpus);
  } finally {
    await service.shutdown(); vi.useRealTimers();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
