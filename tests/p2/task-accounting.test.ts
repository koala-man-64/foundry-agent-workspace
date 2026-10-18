import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { legacyHooks, type ReservationHandle } from '../../packages/runtime/src/agent-loop';
import { admitRequest, measuredUsage } from '../../packages/runtime/src/usage-accounting';
import type { ModelProfile, ProviderEvent, ProviderRequest, Task } from '../../packages/protocol/src/index';
import { regenerating } from './oracle-node.mjs';

const ids = vi.hoisted(() => ({ next: 1 }));
vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(),
  randomUUID: () => `44444444-0000-4000-8000-${String(ids.next++).padStart(12, '0')}` as ReturnType<typeof import('node:crypto').randomUUID> }));
const timestamp = '2026-01-02T03:04:05.678Z';
const task = { id: '44444444-0000-4000-8000-999999999999', title: 'Atomic usage', workspaceKind: 'none', mode: 'chat', profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: timestamp, updatedAt: timestamp, tokenBudget: 5000, usedTokens: 3, future: { keep: true } } as Task;
const profile = { id: FAKE_PROFILE_ID, name: 'Offline demo', apiKind: 'fake', endpoint: '', deployment: 'deterministic-fixture', contextLimit: 10000, outputLimit: 16 } as ModelProfile;
const request = { profile, messages: [{ role: 'user', content: 'abc 😀' }] };
const operations = [
  { kind: 'admit', key: 'a' }, { kind: 'attempt', key: 'a' },
  { kind: 'settle', key: 'a', outcome: 'completed', detail: { type: 'usage', inputTokens: 7, outputTokens: 5 } },
  { kind: 'settle', key: 'a', outcome: 'completed', detail: { type: 'usage', inputTokens: 100, outputTokens: 100 } },
  { kind: 'admit', key: 'b' },
  { kind: 'settle', key: 'b', outcome: 'cancelled', reason: 'cancelled with measured usage', detail: { type: 'usage', inputTokens: 10, outputTokens: 4, cacheReadTokens: 8, cacheCreationTokens: 5, reasoningTokens: 3 }, metadata: { reportedModel: 'fixture-model', responseId: 'fixture-response' } },
  { kind: 'admit', key: 'c' }, { kind: 'settle', key: 'c', outcome: 'failed', reason: 'unknown usage' },
  { kind: 'admit', key: 'd' }, { kind: 'settle', key: 'd', outcome: 'failed', detail: { type: 'usage', inputTokens: -1, outputTokens: 2 } },
  { kind: 'admit', key: 'context', contextLimit: 1 },
  { kind: 'patch', usedTokens: 4999 }, { kind: 'admit', key: 'budget' }, { kind: 'patch', usedTokens: 2000 },
  { kind: 'admit', key: 'pending' }
] as Array<{ kind: string; key?: string; contextLimit?: number; usedTokens?: number; outcome?: string; reason?: string; detail?: unknown; metadata?: { reportedModel?: string; responseId?: string } }>;

it('pins single-task reservation and terminal accounting against shipping hooks and Store mutations', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      vi.setSystemTime(new Date(timestamp));
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-task-accounting-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db')))
          copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        let store = new Store(join(scratch, 'workspace.db'));
        try {
          store.saveTask(task); ids.next = 1;
          const handles = new Map<string, ReservationHandle>();
          const schema = Number(store.db.pragma('user_version', { simple: true }));
          const snapshot = () => ({ task: store.task(task.id),
            requests: schema >= 4 ? store.db.prepare("SELECT rowid AS _rowid,* FROM provider_requests WHERE request_id LIKE '44444444-%' ORDER BY rowid").all() : [],
            legacy: store.db.prepare("SELECT rowid AS _rowid,* FROM usage_records WHERE request_id LIKE '44444444-%' ORDER BY rowid").all(),
            events: store.db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY sequence').all(task.id)
          });
          const hooks = () => legacyHooks(store);
          // This is the terminal transaction from AgentLoop.run, using the actual
          // Store and legacy hooks. It does not claim a complete runtime trace.
          const settle = (handle: ReservationHandle, operation: typeof operations[number]) => store.transaction(() => {
            const usage = operation.detail ? measuredUsage(operation.detail as Extract<ProviderEvent, { type: 'usage' }>) : undefined;
            if (schema >= 4) {
              if (!store.finishUsage(handle.requestId!, usage, operation.outcome as 'completed' | 'failed' | 'cancelled', operation.reason, operation.metadata)) return false;
            } else {
              if (store.hasUsage(handle.requestId!)) return false;
              store.saveUsageRecord({ id: `44444444-0000-4000-8000-${String(ids.next++).padStart(12, '0')}`, taskId: task.id, requestId: handle.requestId!, reservedTokens: handle.amount, promptTokens: usage?.inputTokens ?? null, completionTokens: usage?.outputTokens ?? null, cacheReadTokens: usage?.cacheReadTokens ?? null, cacheCreationTokens: usage?.cacheCreationTokens ?? null, usageKnown: usage !== undefined, reason: operation.reason ?? null, createdAt: new Date().toISOString() });
            }
            hooks().settle(task, handle, usage ? usage.inputTokens + usage.outputTokens : undefined, operation.reason); return true;
          });
          const steps = operations.map((operation, index) => {
            vi.setSystemTime(new Date(Date.parse(timestamp) + index * 1000));
            let value: unknown = null; let error: string | null = null;
            try {
              if (operation.kind === 'admit') {
                const input = { ...request, profile: { ...profile, ...(operation.contextLimit !== undefined ? { contextLimit: operation.contextLimit } : {}) }, signal: new AbortController().signal } as ProviderRequest;
                const handle = admitRequest(store, task, input, hooks()); handles.set(operation.key!, handle); value = handle;
              } else if (operation.kind === 'attempt') store.attemptUsage(handles.get(operation.key!)!.requestId!);
              else if (operation.kind === 'settle') value = settle(handles.get(operation.key!)!, operation);
              else store.saveTask({ ...store.task(task.id), usedTokens: operation.usedTokens! });
            } catch (cause) { error = (cause as Error).message; }
            return { operation, expected: { value, error, ...snapshot() } };
          });
          store.close(); vi.setSystemTime(new Date(Date.parse(timestamp) + 60000)); store = new Store(join(scratch, 'workspace.db'));
          const recovered = snapshot();
          const settledAfterRecovery = settle(handles.get('pending')!, { kind: 'settle', outcome: 'cancelled', reason: 'after restart' });
          return { era, steps, recovered, settledAfterRecovery, afterRecoverySettlement: snapshot() };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    const corpus = { task, request, cases };
    if (regenerating('P2_WRITE_TASK_ACCOUNTING')) writeFileSync('tests/p2/task-accounting-vectors.json', JSON.stringify(corpus, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/task-accounting-vectors.json', 'utf8'))).toEqual(corpus);
  } finally { vi.useRealTimers(); }
});
