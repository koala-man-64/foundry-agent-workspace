import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { RuntimeService } from '../../packages/runtime/src/service';
import { RepositoryService } from '../../packages/runtime/src/repository';
import type { RpcMethod, Task, WorkspaceEvent } from '../../packages/protocol/src/index';

const ids = vi.hoisted(() => ({ next: 1 }));
vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(), randomUUID: () => `77777777-0000-4000-8000-${String(ids.next++).padStart(12, '0')}` as ReturnType<typeof import('node:crypto').randomUUID> }));
const timestamp = '2026-01-02T03:04:05.678Z';
const parameters = { requestId: '77777777-0000-4000-8000-999999999999', projectId: null, content: 'Hello 😀', profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000 };

it('pins actual offline service chat execution, reads, idempotence and failures', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-service-oracle-'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp)); ids.next = 1;
  const store = new Store(join(scratch, 'workspace.db'));
  const events: WorkspaceEvent[] = [];
  const service = new RuntimeService(store, new RepositoryService(join(scratch, 'wt')), event => events.push(event));
  try {
    const steps: Array<{ method: RpcMethod | 'wait'; params: unknown; expected: unknown }> = [];
    const snapshot = () => ({ tasks: store.db.prepare("SELECT rowid AS _rowid,* FROM tasks WHERE id LIKE '77777777-%' ORDER BY rowid").all(), messages: store.db.prepare("SELECT rowid AS _rowid,* FROM messages WHERE id LIKE '77777777-%' ORDER BY ordinal").all(), requests: store.db.prepare("SELECT rowid AS _rowid,* FROM provider_requests WHERE request_id LIKE '77777777-%' ORDER BY rowid").all(), starts: store.db.prepare("SELECT * FROM task_starts WHERE request_id LIKE '77777777-%' ORDER BY rowid").all(), events: store.db.prepare("SELECT * FROM events WHERE task_id LIKE '77777777-%' ORDER BY sequence").all(), notifications: [...events] });
    const act = async (method: RpcMethod | 'wait', params: unknown) => {
      let value: unknown = null; let error: string | null = null;
      try {
        if (method === 'wait') { const taskId = (params as { taskId: string }).taskId; for (let n = 0; store.task(taskId).status === 'running'; n++) { if (n > 2000) throw new Error('Oracle did not complete.'); await new Promise(resolve => setTimeout(resolve, 1)); } }
        else value = await service.dispatch(method, params);
      } catch (cause) { error = (cause as Error).message; }
      steps.push({ method, params, expected: { value, error, ...snapshot() } }); return value;
    };
    const task = await act('task.start', parameters) as Task;
    await act('wait', { taskId: task.id });
    await act('task.read', { taskId: task.id });
    await act('task.messages', { taskId: task.id, limit: 50 });
    await act('task.start', parameters);
    await act('task.start', { ...parameters, content: 'different' });
    await act('task.send', { taskId: task.id, content: 'second' });
    await act('wait', { taskId: task.id });
    await act('task.cancel', { taskId: task.id });
    await act('task.start', { ...parameters, requestId: '77777777-0000-4000-8000-999999999998', tokenBudget: 1024 });
    const corpus = { timestamp, steps };
    if (process.env.P2_WRITE_EXECUTION === '1') writeFileSync('tests/p2/development-chat-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/development-chat-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { await service.shutdown(); vi.useRealTimers(); rmSync(scratch, { recursive: true, force: true }); }
});
