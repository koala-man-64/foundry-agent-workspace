import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Approval, BrowserAction, BrowserHost, BrowserHostRequest, BrowserHostResult, Task, ToolCall } from '../../protocol/src/index';
import { BrowserHostError } from '../../protocol/src/index';
import { BrowserTools, hasBlockingUnknown } from '../src/browser-tools';
import { Store, FAKE_PROFILE_ID } from '../src/store';
import { Redactor } from '../src/redaction';
import { prepareRequest } from '../src/agent-loop';

describe('browser tool approvals', () => {
  let directory: string; let store: Store; let tool: BrowserTools; let approval: Approval | undefined;
  let decide: (approved: boolean) => void;
  let execute = vi.fn(async (_input: BrowserHostRequest) => ({ status: 'dispatched' as const, detail: 'Clicked.' }));
  let inspect = vi.fn(async () => ({ tabId, generation: 2, origin: 'https://example.test', inspectedAt: new Date().toISOString() }));
  const taskId = randomUUID(), tabId = randomUUID(), snapshotId = randomUUID(), preparedId = randomUUID(), attachmentId = randomUUID();
  const action: BrowserAction = { kind: 'click', tabId, snapshotId, nodeId: 'button-1' };
  const task = { id: taskId, mode: 'chat' } as Task;
  const call = (name: string, args: unknown): ToolCall => ({ id: randomUUID(), name, arguments: args });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foundry-browser-tools-')); store = new Store(join(directory, 'state.db')); approval = undefined;
    execute = vi.fn(async (_input: BrowserHostRequest) => ({ status: 'dispatched' as const, detail: 'Clicked.' }));
    inspect = vi.fn(async () => ({ tabId, generation: 2, origin: 'https://example.test', inspectedAt: new Date().toISOString() }));
    const host: BrowserHost = { request: async (input: BrowserHostRequest): Promise<BrowserHostResult> => {
      if (input.kind === 'tabs') return [{ id: tabId, title: 'Fixture', url: 'https://example.test/', loading: false, canGoBack: false, canGoForward: false, generation: 1, attachedTaskId: taskId, authorizedOrigin: 'https://example.test', sharing: true, error: null }];
      if (input.kind === 'snapshot') return { id: snapshotId, tabId, generation: 1, origin: 'https://example.test', url: 'https://example.test/', text: 'Untrusted page text', nodes: [{ id: 'button-1', role: 'button', name: 'Continue' }], truncated: false };
      if (input.kind === 'prepare') return { id: preparedId, taskId, tabId, attachmentId, generation: 1, origin: 'https://example.test', action, summary: 'Click Continue on https://example.test/', createdAt: new Date().toISOString() };
      if (input.kind === 'execute') return execute(input);
      if (input.kind === 'inspect') return inspect();
      return null;
    } };
    tool = new BrowserTools(store, host, new Redactor(), {
      requestApproval: async (item: Approval) => { approval = item; store.saveApproval(item); return new Promise<boolean>(resolve => { decide = resolve; }); },
      saveApproval: (item: Approval) => store.saveApproval(item)
    });
  });
  afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });

  it('returns only attached tab data and a bounded snapshot without approval', async () => {
    expect((await tool.execute(task, call('browser_tabs', {}), new AbortController().signal)).content).toContain('Fixture');
    expect((await tool.execute(task, call('browser_snapshot', { tabId }), new AbortController().signal)).content).toContain('Untrusted page text');
    expect(approval).toBeUndefined();
  });

  it('advertises only browser tools to an ordinary chat with an attached tab', () => {
    const profile = store.profile(FAKE_PROFILE_ID)!;
    const request = prepareRequest(store, task, profile, 'test-fingerprint', 'Inspect the page', undefined, new AbortController().signal, undefined, [], undefined, true);
    expect(request.tools?.map(item => item.name)).toEqual(['browser_tabs', 'browser_snapshot', 'browser_action']);
    expect(request.tools?.some(item => item.name === 'read_file')).toBe(false);
    expect(prepareRequest(store, { ...task, mode: undefined } as Task, profile, 'test-fingerprint', 'Inspect', undefined, new AbortController().signal, undefined, [], undefined, true).tools?.map(item => item.name)).toEqual(['browser_tabs', 'browser_snapshot', 'browser_action']);
  });

  it('persists exact intent and never dispatches a rejected action', async () => {
    const pending = tool.execute(task, call('browser_action', action), new AbortController().signal);
    await vi.waitFor(() => expect(approval?.state).toBe('awaiting-approval'));
    expect(approval?.browser?.prepared.action).toEqual(action);
    expect(execute).not.toHaveBeenCalled();
    decide(false); expect((await pending).isError).toBe(true); expect(execute).not.toHaveBeenCalled();
  });

  it('marks dispatch intent before execution and retains an unknown result until inspected', async () => {
    execute.mockImplementation(async () => {
      expect(store.approval(approval!.id).state).toBe('executing');
      throw new BrowserHostError('unknown', 'Connection lost after dispatch.');
    });
    const pending = tool.execute(task, call('browser_action', action), new AbortController().signal);
    await vi.waitFor(() => expect(approval).toBeDefined()); decide(true);
    expect((await pending).isError).toBe(true);
    expect(store.approval(approval!.id).state).toBe('unknown');
    expect(hasBlockingUnknown(store, taskId)).toBe(true);
    await tool.acknowledgeUnknown(taskId, approval!.id);
    expect(store.approval(approval!.id).state).toBe('unknown');
    expect(hasBlockingUnknown(store, taskId)).toBe(false);
  });

  it('treats a stale prepared target as revoked', async () => {
    execute.mockRejectedValue(new BrowserHostError('stale', 'Document changed.'));
    const pending = tool.execute(task, call('browser_action', action), new AbortController().signal);
    await vi.waitFor(() => expect(approval).toBeDefined()); decide(true);
    expect((await pending).isError).toBe(true);
    expect(store.approval(approval!.id).state).toBe('revoked');
  });

  it('allows explicit acknowledgment after the original tab closes but keeps the action unknown', async () => {
    execute.mockRejectedValue(new BrowserHostError('unknown', 'Connection lost.'));
    const pending = tool.execute(task, call('browser_action', action), new AbortController().signal);
    await vi.waitFor(() => expect(approval).toBeDefined()); decide(true); await pending;
    inspect.mockRejectedValue(new BrowserHostError('stale', 'Tab closed.'));
    const acknowledged = await tool.acknowledgeUnknown(taskId, approval!.id);
    expect(acknowledged.state).toBe('unknown');
    expect(acknowledged.browser?.acknowledgment).toMatchObject({ tabId, generation: 1, tabAvailable: false });
  });
});
