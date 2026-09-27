import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ChannelView, ProviderAdapter, ProviderEvent, ProviderRequest, Task } from '../../packages/protocol/src/index';
import { createProvider } from '../../packages/providers/src/index';
import { FAKE_PROFILE_ID } from '../../packages/runtime/src/store';
import { createHarness, type Harness } from './orchestration-harness';

describe('project-channel provider delivery', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });
  const create = (title: string, mode: 'chat' | 'coding' = 'chat'): Promise<Task> => h!.runtime.dispatch('task.create', { title, mode, projectPath: h!.project, profileId: FAKE_PROFILE_ID, tokenBudget: 500000 }) as Promise<Task>;
  const done = (task: Task): Promise<void> => vi.waitFor(() => expect(h!.store.task(task.id).status).not.toBe('running'), { timeout: 15000 });
  const peerData = (request: ProviderRequest): string => request.messages.filter(message => message.content.startsWith('PROJECT_CHANNEL_DATA')).map(message => message.content).join('');
  const provider = (streamTurn: ProviderAdapter['streamTurn']): (() => ProviderAdapter) => () => ({ probe: profile => createProvider('fake').probe(profile), streamTurn });

  it('lets independent chat agents send, receive exactly once and retain channel history after restart', async () => {
    h = await createHarness(); const sender = await create('Sender'); const recipient = await create('Recipient');
    await h.runtime.dispatch('task.send', { taskId: sender.id, content: '/channel-demo Team finding' }); await done(sender);
    expect(h.store.task(sender.id).status).toBe('idle'); expect(h.store.task(recipient.id).status).toBe('idle');
    const view = await h.runtime.dispatch('channel.get', { taskId: recipient.id }) as ChannelView;
    expect(view.messages).toMatchObject([{ senderTaskId: sender.id, actor: 'agent', content: 'Team finding' }]);
    await h.runtime.dispatch('task.send', { taskId: recipient.id, content: 'Review teammate findings' }); await done(recipient);
    const delivered = h.requests.at(-1)!.request;
    expect(peerData(delivered)).toContain('Team finding');
    expect(delivered.tools!.map(tool => tool.name).sort()).toEqual(['list_project_agents', 'read_agent_messages', 'send_agent_message']);
    await h.runtime.dispatch('task.send', { taskId: recipient.id, content: 'Continue' }); await done(recipient);
    expect(peerData(h.requests.at(-1)!.request)).toBe('');
    await h.restart();
    expect((await h.runtime.dispatch('channel.get', { taskId: recipient.id }) as ChannelView).messages).toHaveLength(1);
    await h.runtime.dispatch('task.send', { taskId: recipient.id, content: 'Continue after restart' }); await done(recipient);
    expect(peerData(h.requests.at(-1)!.request)).toBe('');
  });

  it('injects a message arriving during a model request into the next native tool continuation', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false; const requests: ProviderRequest[] = [];
    h = await createHarness(provider(async function* (request): AsyncIterable<ProviderEvent> {
      requests.push(request);
      if (!request.continuation) {
        entered = true; await gate;
        yield { type: 'tool_call', call: { id: 'list-team', name: 'list_project_agents', arguments: {} } };
      }
      yield { type: 'usage', inputTokens: 10, outputTokens: 10 };
      yield { type: 'done', continuation: { apiKind: 'fake', data: { stage: 'fixture', calls: [] } } };
    }));
    const recipient = await create('Working agent', 'coding'); const sender = await create('Peer');
    await h.runtime.dispatch('task.send', { taskId: recipient.id, content: 'Start work' });
    await vi.waitFor(() => expect(entered).toBe(true));
    try {
      await h.runtime.dispatch('channel.send', { taskId: sender.id, requestId: randomUUID(), recipientTaskId: recipient.id, content: 'Arrived during inference' });
    } finally { release(); }
    await done(recipient);
    expect(requests).toHaveLength(2); expect(peerData(requests[0]!)).toBe('');
    expect(peerData(requests[1]!)).toContain('Arrived during inference');
    expect(requests[1]!.toolResults?.[0]).toMatchObject({ id: 'list-team', isError: false });
    expect(h.store.task(recipient.id).status).toBe('idle');
  });

  it('keeps delivery pending after a failed provider request', async () => {
    let fail = true; const requests: ProviderRequest[] = [];
    h = await createHarness(provider(async function* (request): AsyncIterable<ProviderEvent> {
      requests.push(request); if (fail) throw new Error('Synthetic provider failure');
      yield { type: 'done', continuation: { apiKind: 'fake', data: { stage: 'fixture', calls: [] } } };
    }));
    const sender = await create('Peer'); const recipient = await create('Recipient');
    await h.runtime.dispatch('channel.send', { taskId: sender.id, requestId: randomUUID(), content: 'Keep pending' });
    await h.runtime.dispatch('task.send', { taskId: recipient.id, content: 'Receive' }); await done(recipient);
    expect(h.store.task(recipient.id).status).toBe('failed'); fail = false;
    await h.runtime.dispatch('task.send', { taskId: recipient.id, content: 'User retries' }); await done(recipient);
    expect(requests.map(peerData).every(content => content.includes('Keep pending'))).toBe(true);
    expect(h.store.task(recipient.id).status).toBe('idle');
  });

  it('does not grant repository tools to chat agents even if the provider fabricates a call', async () => {
    let result: ProviderRequest['toolResults'];
    h = await createHarness(provider(async function* (request): AsyncIterable<ProviderEvent> {
      if (!request.continuation) yield { type: 'tool_call', call: { id: 'forged-read', name: 'read_file', arguments: { path: 'README.md' } } };
      else result = request.toolResults;
      yield { type: 'done', continuation: { apiKind: 'fake', data: { stage: 'fixture', calls: [] } } };
    }));
    const chat = await create('Chat only'); const source = h.sourceSnapshot();
    await h.runtime.dispatch('task.send', { taskId: chat.id, content: 'Hello' }); await done(chat);
    expect(result?.[0]).toMatchObject({ isError: true }); expect(result?.[0]?.content).toContain('only project communication tools');
    expect(h.sourceSnapshot()).toEqual(source);
    await expect(h.runtime.dispatch('channel.send', { taskId: chat.id, requestId: randomUUID(), content: 'x', senderTaskId: chat.id })).rejects.toThrow();
  });
});
