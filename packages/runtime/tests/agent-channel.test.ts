import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelMessageInput, ChannelRpc, type GitTask, type ProviderRequest } from '../../protocol/src/index';
import { AgentChannel } from '../src/agent-channel';
import { Store, FAKE_PROFILE_ID } from '../src/store';
import { Redactor } from '../src/redaction';
import { OrchestrationRecords } from '../src/orchestration-records';

describe('runtime-owned project channel', () => {
  let directory: string, project: string, store: Store, channel: AgentChannel, redactor: Redactor;
  let sender: GitTask, recipient: GitTask, teammate: GitTask, outsider: GitTask;
  const task = (projectPath: string, title: string): GitTask => store.saveTask({ id: randomUUID(), title, projectPath, worktreePath: projectPath, branch: 'fixture', baseCommit: 'a'.repeat(40), profileId: FAKE_PROFILE_ID, status: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', tokenBudget: 100000, usedTokens: 0, mode: 'coding' }) as GitTask;
  const request = (): ProviderRequest => ({ profile: store.profile(FAKE_PROFILE_ID)!, signal: new AbortController().signal, messages: [{ role: 'system', content: 'Trusted system instructions' }, { role: 'user', content: 'Continue my task' }] });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'foundry-channel-')); project = join(directory, 'project');
    mkdirSync(join(project, '.git'), { recursive: true }); mkdirSync(join(directory, 'other', '.git'), { recursive: true });
    store = new Store(join(directory, 'state.db')); redactor = new Redactor(); channel = new AgentChannel(store, redactor, () => {});
    sender = task(project, 'Sender'); recipient = task(project, 'Recipient'); teammate = task(project, 'Teammate'); outsider = task(join(directory, 'other'), 'Other project');
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  it('isolates discovery, broadcasts and direct messages by canonical local project and recipient', () => {
    expect(channel.participants(sender.id).participants.map(item => item.taskId).sort()).toEqual([sender.id, recipient.id, teammate.id].sort());
    expect(() => channel.send(sender.id, 'bad-target', { recipientTaskId: outsider.id, content: 'private' }, 'agent')).toThrow('this project');
    const direct = channel.send(sender.id, 'direct', { recipientTaskId: recipient.id, content: 'Private result' }, 'agent');
    const broadcast = channel.send(sender.id, 'broadcast', { content: 'Shared result' }, 'agent');
    expect(channel.view(recipient.id).messages.map(message => message.sequence)).toEqual([direct.sequence, broadcast.sequence]);
    expect(channel.view(sender.id).messages).toHaveLength(2);
    expect(channel.view(teammate.id).messages.map(message => message.content)).toEqual(['Shared result']);
    expect(channel.view(outsider.id).messages).toEqual([]);
    expect(() => channel.send(sender.id, 'spoof', { content: 'x', senderTaskId: outsider.id }, 'agent')).toThrow();
  });
  it('coalesces canonical aliases and project subdirectories', () => {
    const alias = join(directory, 'alias'); symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    mkdirSync(join(project, 'src')); const fromAlias = task(alias, 'Alias'); const fromSubdirectory = task(join(project, 'src'), 'Subdirectory');
    channel.send(sender.id, 'alias', { content: 'Same project' }, 'agent');
    expect(channel.view(fromAlias.id).messages).toHaveLength(1); expect(channel.view(fromSubdirectory.id).messages).toHaveLength(1);
  });
  it('deduplicates exact sends and rejects key reuse, stopped senders and unavailable recipients', () => {
    const first = channel.send(sender.id, 'once', { content: 'hello' }, 'agent');
    expect(channel.send(sender.id, 'once', { content: 'hello' }, 'agent')).toEqual(first);
    expect(channel.view(recipient.id).messages).toHaveLength(1);
    expect(() => channel.send(sender.id, 'once', { content: 'changed' }, 'agent')).toThrow('different content');
    store.saveTask({ ...recipient, status: 'retired' });
    expect(() => channel.send(sender.id, 'retired', { recipientTaskId: recipient.id, content: 'x' }, 'agent')).toThrow('available');
    store.saveTask({ ...sender, status: 'cancelled' });
    expect(() => channel.send(sender.id, 'cancelled', { content: 'x' }, 'agent')).toThrow('stopped');
    expect(() => channel.execute(sender.id, { id: 'read', name: 'read_agent_messages', arguments: {} })).toThrow('stopped');
  });
  it('shares a channel between linked worktrees using Git commondir metadata', () => {
    const linked = join(directory, 'linked'); const metadata = join(project, '.git', 'worktrees', 'linked');
    mkdirSync(linked); mkdirSync(metadata, { recursive: true });
    writeFileSync(join(linked, '.git'), `gitdir: ${metadata}\n`); writeFileSync(join(metadata, 'commondir'), '../..\n');
    const peer = task(linked, 'Linked worktree');
    channel.send(sender.id, 'across-worktrees', { recipientTaskId: peer.id, content: 'Shared local project' }, 'agent');
    expect(channel.view(peer.id).messages).toHaveLength(1); expect(channel.view(outsider.id).messages).toEqual([]);
  });
  it('fences coordinated agents and resumes reads correctly after many unrelated retained events', () => {
    const root = store.saveTask({ ...sender, mode: 'coordinated', role: 'coordinator', rootTaskId: sender.id });
    const records = new OrchestrationRecords(store); records.insertCoordinatorRun(root.id);
    channel.send(root.id, 'before-fence', { content: 'Available' }, 'agent');
    store.transaction(() => { for (let index = 0; index < 5000; index++) store.event('unrelated.progress', { index }, outsider.id); });
    const later = channel.send(teammate.id, 'after-noise', { content: 'Relevant after unrelated history' }, 'agent');
    expect(channel.view(recipient.id).messages.at(-1)?.sequence).toBe(later.sequence);
    expect(channel.send(teammate.id, 'after-noise', { content: 'Relevant after unrelated history' }, 'agent').sequence).toBe(later.sequence);
    records.fence(root.id);
    expect(() => channel.send(root.id, 'late', { content: 'Must fail' }, 'agent')).toThrow('stopped');
    expect(channel.enrich(root, request()).channelCursor).toBeUndefined();
  });
  it('rejects secret canaries and oversized UTF-8 messages before persistence', () => {
    redactor.add('synthetic-channel-secret-123456');
    expect(() => channel.send(sender.id, 'secret', { content: 'synthetic-channel-secret-123456' }, 'agent')).toThrow('secret');
    expect(() => ChannelMessageInput.parse({ content: '😀'.repeat(600) })).toThrow();
    expect(() => ChannelRpc['channel.get'].parse({ taskId: sender.id, before: Infinity })).toThrow();
    expect(channel.view(recipient.id).messages).toEqual([]);
  });
  it('pages retained messages in both directions without gaps or repeats', () => {
    for (let index = 0; index < 27; index++) channel.send(sender.id, `message-${index}`, { content: `Message ${index}` }, 'agent');
    const latest = channel.view(recipient.id); const older = channel.view(recipient.id, latest.nextCursor!);
    expect([...older.messages, ...latest.messages].map(message => message.content)).toEqual(Array.from({ length: 27 }, (_, index) => `Message ${index}`));
    const first = channel.execute(recipient.id, { id: 'read-1', name: 'read_agent_messages', arguments: {} }) as { messages: unknown[]; nextCursor: number };
    const next = channel.execute(recipient.id, { id: 'read-2', name: 'read_agent_messages', arguments: { after: first.nextCursor } }) as { messages: unknown[] };
    expect(first.messages).toHaveLength(20); expect(next.messages).toHaveLength(7);
  });
  it('bounds JSON-expanded control characters in model context while retaining full history', () => {
    const content = 'X' + '\u0001'.repeat(1900) + 'Y';
    for (let index = 0; index < 20; index++) channel.send(sender.id, `escaped-${index}`, { content }, 'agent');
    const input = request(); input.profile = { ...input.profile, contextLimit: 4096 };
    const delivered = channel.enrich(recipient, input);
    expect(Buffer.byteLength(delivered.messages[1]!.content, 'utf8')).toBeLessThanOrEqual(3072);
    expect(delivered.messages[1]!.content).toContain('contentTruncated');
    const history = channel.view(recipient.id);
    expect(history.messages[0]!.content).toBe(content);
    expect(Buffer.byteLength(JSON.stringify(history), 'utf8')).toBeLessThan(66 * 1024);
    expect(history.nextCursor).not.toBeNull();
  });
  it('delivers bounded untrusted context once per recipient only after successful model acknowledgement, including restart', () => {
    for (let index = 0; index < 12; index++) channel.send(sender.id, `long-${index}`, { content: `${index} ${'x'.repeat(2000)}` }, 'agent');
    const enriched = channel.enrich(recipient, request());
    expect(enriched.messages[0]!.role).toBe('system');
    expect(enriched.messages[1]!.content).toContain('PROJECT_CHANNEL_DATA');
    expect(Buffer.byteLength(enriched.messages[1]!.content)).toBeLessThan(9000);
    expect(channel.enrich(recipient, request()).channelCursor).toBe(enriched.channelCursor); // failed/unadmitted request
    channel.acknowledge(recipient.id, enriched.channelCursor);
    const next = channel.enrich(recipient, request()); expect(next.channelCursor).toBeGreaterThan(enriched.channelCursor!);
    expect(channel.enrich(teammate, request()).channelCursor).toBe(enriched.channelCursor); // independent recipient
    store.close(); store = new Store(join(directory, 'state.db')); channel = new AgentChannel(store, redactor, () => {});
    expect(channel.enrich(recipient, request()).channelCursor).toBe(next.channelCursor);
    expect(store.schemaVersion).toBe(4);
  });
});
