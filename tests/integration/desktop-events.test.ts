import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventSchema } from '../../apps/desktop/src/main/supervisor';
import { NotificationPreferences, notificationTitle } from '../../apps/desktop/src/main/notification-preferences';
import { Store } from '../../packages/runtime/src/store';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
describe('desktop event mediation', () => {
  it('accepts the canonical versioned runtime event without killing the transport', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-event-envelope-')); directories.push(directory);
    const store = new Store(join(directory, 'workspace.db'));
    try {
      const event = store.event('features.changed', { feature: 'hooks', enabled: false });
      expect(event).toMatchObject({ version: 1, source: 'runtime' });
      expect(EventSchema.parse({ jsonrpc: '2.0', method: 'workspace.event', params: event }).params).toEqual(event);
      expect(EventSchema.safeParse({ jsonrpc: '2.0', method: 'workspace.event', params: { ...event, version: 99 } }).success).toBe(false);
    } finally { store.close(); }
  });
  it('persists opt-in notification preference and excludes event content from toast text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-notifications-')); directories.push(directory); const path = join(directory, 'notifications.json');
    const preferences = new NotificationPreferences(path); await preferences.load(); expect(preferences.enabled).toBe(false);
    await preferences.set(true); const reopened = new NotificationPreferences(path); await reopened.load(); expect(reopened.enabled).toBe(true);
    await reopened.set(false); await preferences.load(); expect(preferences.enabled).toBe(false);
    const event = { sequence: 1, type: 'approval.changed', data: { state: 'awaiting-approval', command: 'secret body should never enter toast' }, createdAt: new Date().toISOString() };
    expect(notificationTitle(event)).toBe('An action needs your review'); expect(notificationTitle({ ...event, type: 'task.progress' })).toBeNull();
  });
});
