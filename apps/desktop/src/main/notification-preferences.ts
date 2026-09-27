import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceEvent } from '../../../../packages/protocol/src/index';

export class NotificationPreferences {
  enabled = false;
  private writes = Promise.resolve();
  constructor(private readonly path: string) {}
  async load(): Promise<void> {
    try { const value: unknown = JSON.parse(await readFile(this.path, 'utf8')); this.enabled = typeof value === 'object' && value !== null && 'enabled' in value && value.enabled === true; }
    catch { this.enabled = false; }
  }
  async set(enabled: boolean): Promise<{ enabled: boolean }> {
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify({ version: 1, enabled }), { flag: 'wx', mode: 0o600 }); await rename(temporary, this.path); this.enabled = enabled; }
      finally { await rm(temporary, { force: true }); }
    });
    await this.writes; return { enabled: this.enabled };
  }
}

/** Native toast text deliberately excludes conversation and command content. Inbox remains authoritative. */
export function notificationTitle(event: WorkspaceEvent): string | null {
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  if (event.type === 'approval.changed' && data.state === 'awaiting-approval') return 'An action needs your review';
  if (event.type === 'task.completed' || event.type === 'orchestration.completed') return 'Work completed';
  if (event.type === 'task.stopped' || event.type === 'orchestration.child-provision-failed' || event.type === 'automation.fault') return 'Work needs attention';
  if (event.type === 'orchestration.waiting' || event.type === 'orchestration.assignment-waiting' || event.type === 'orchestration.child-provision-unknown') return 'Work has a blocker';
  if (event.type === 'automation.schedule.drafts') return 'A scheduled follow-up is ready';
  return null;
}
