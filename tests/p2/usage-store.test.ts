import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store } from '../../packages/runtime/src/store';
import type { ModelProfile, ProviderEvent, Task } from '../../packages/protocol/src/index';

const timestamp = '2026-01-02T03:04:05.678Z';
const root = { id: '22222222-root', title: 'Root 😀', profileId: 'fixture', status: 'idle', createdAt: timestamp, updatedAt: timestamp, tokenBudget: 4096, usedTokens: 0 } as Task;
const child = { ...root, id: '22222222-child', title: 'Child', rootTaskId: root.id, parentTaskId: root.id, role: 'child' } as Task;
const profile = { id: 'fixture', name: 'Fixture 😀', apiKind: 'fake', deployment: 'fixture', endpoint: '', contextLimit: 32000, outputLimit: 2048 } as ModelProfile;
const operations = [
  { kind: 'has', id: 'probe' },
  { kind: 'begin', id: 'probe', reserved: 12, purpose: 'probe' },
  { kind: 'has', id: 'probe' },
  { kind: 'attempt', id: 'probe' },
  { kind: 'attempt', id: 'probe' },
  { kind: 'finish', id: 'probe', outcome: 'failed', reason: 'offline failure' },
  { kind: 'finish', id: 'probe', outcome: 'completed', detail: { type: 'usage', inputTokens: 8, outputTokens: 3 } },
  { kind: 'attempt', id: 'probe' },
  { kind: 'begin', id: 'probe', reserved: 12, purpose: 'probe' },
  { kind: 'begin', id: 'negative', reserved: -1, purpose: 'probe' },
  { kind: 'begin', id: 'fraction', reserved: 1.5, purpose: 'probe' },
  { kind: 'begin', id: 'unsafe', reserved: 9007199254740992, purpose: 'probe' },
  { kind: 'begin', id: 'root', task: root, reserved: 0, purpose: 'conversation' },
  { kind: 'begin', id: 'child', task: child, reserved: 9007199254740991, purpose: 'conversation', effort: 'high' },
  { kind: 'attempt', id: 'child' },
  { kind: 'finish', id: 'child', outcome: 'cancelled', reason: '', detail: { type: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: 10, reasoningTokens: 15 }, metadata: { reportedModel: 'fixture-model', responseId: 'fixture-response' } },
  { kind: 'finish', id: 'root', outcome: 'completed', detail: { type: 'usage', inputTokens: 0, outputTokens: 0 }, metadata: { reportedModel: '', responseId: '' } },
  { kind: 'begin', id: 'orphan', task: { ...child, rootTaskId: 'missing' }, reserved: 7, purpose: 'conversation' },
  { kind: 'begin', id: 'self', task: { ...root, rootTaskId: root.id }, reserved: 7, purpose: 'conversation' },
  { kind: 'begin', id: 'empty-root', task: { ...child, rootTaskId: '' }, reserved: 7, purpose: 'conversation' },
  { kind: 'begin', id: 'null-root', task: { ...child, rootTaskId: null }, reserved: 7, purpose: 'conversation' },
  { kind: 'attempt', id: 'orphan' },
  { kind: 'attempt', id: 'missing' },
  { kind: 'finish', id: 'missing', outcome: 'interrupted' },
  { kind: 'has', id: 'missing' },
  { kind: 'has', id: 'legacy' }
] as Array<{ kind: string; id: string; reserved?: number; purpose?: string; task?: unknown; effort?: string; outcome?: string; reason?: string; detail?: unknown; metadata?: unknown }>;

it('pins usage admission, first attempt, terminal settlement and restart on disposable era copies', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp));
  try {
    const cases = ['fresh', 'v1', 'v2', 'v3', 'v4', 'v5', 'v5-wal'].map(era => {
      const scratch = mkdtempSync(join(tmpdir(), 'foundry-p2-usage-'));
      try {
        if (era !== 'fresh') for (const file of readdirSync(`tests/fixtures/databases/${era}`).filter(file => file.startsWith('workspace.db')))
          copyFileSync(`tests/fixtures/databases/${era}/${file}`, join(scratch, file));
        let store = new Store(join(scratch, 'workspace.db'));
        try {
          store.saveTask(root); store.saveTask(child);
          store.saveUsageRecord({ id: '22222222-legacy-row', taskId: root.id, requestId: '22222222-legacy', reservedTokens: 12, promptTokens: null, completionTokens: null, cacheReadTokens: null, cacheCreationTokens: null, usageKnown: false, reason: 'retained legacy unknown', createdAt: timestamp });
          const schema = Number(store.db.pragma('user_version', { simple: true }));
          const rows = () => schema >= 4 ? store.db.prepare("SELECT rowid AS _rowid,* FROM provider_requests WHERE request_id LIKE '22222222-%' ORDER BY rowid").all() : [];
          const steps = operations.map((operation, index) => {
            vi.setSystemTime(new Date(Date.parse(timestamp) + index * 1000));
            const id = `22222222-${operation.id}`;
            let value: unknown = null; let error: string | null = null;
            try {
              if (operation.kind === 'begin') store.beginUsage(id, operation.task as Task | undefined, { ...profile, ...(operation.effort ? { effort: operation.effort } : {}) } as ModelProfile, operation.reserved!, operation.purpose as 'probe' | 'conversation');
              else if (operation.kind === 'attempt') store.attemptUsage(id);
              else if (operation.kind === 'finish') value = store.finishUsage(id, operation.detail as Extract<ProviderEvent, { type: 'usage' }> | undefined, operation.outcome as 'completed' | 'failed' | 'cancelled' | 'interrupted', operation.reason, operation.metadata as { reportedModel?: string; responseId?: string } | undefined);
              else value = store.hasUsage(id);
            } catch (cause) { error = operation.id === 'probe' ? 'duplicate' : (cause as Error).message; }
            return { operation, expected: { value, error, rows: rows() } };
          });
          store.close(); vi.setSystemTime(new Date(Date.parse(timestamp) + 60000)); store = new Store(join(scratch, 'workspace.db'));
          return { era, steps, recovered: rows() };
        } finally { store.close(); }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
    if (process.env.P2_WRITE_USAGE === '1') writeFileSync('tests/p2/usage-store-vectors.json', JSON.stringify(cases, null, 2) + '\n');
    expect(JSON.parse(readFileSync('tests/p2/usage-store-vectors.json', 'utf8'))).toEqual(cases);
  } finally { vi.useRealTimers(); }
});
