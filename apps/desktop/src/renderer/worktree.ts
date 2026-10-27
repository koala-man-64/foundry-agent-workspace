import type { DiffResult, WorkspaceEvent } from '../../../../packages/protocol/src/index';

/** Approval states after which the approved action may have changed files: it ran, failed part-way, or its outcome is unknown. */
const SETTLED_APPROVAL_STATES = new Set(['complete', 'failed', 'unknown']);

/**
 * Whether an event means its task's worktree may have changed, so a Files or Changes view of that task reads it again.
 * Edits made outside the app raise no event; Refresh covers those.
 */
export function mayChangeWorktree(event: WorkspaceEvent): boolean {
  if (event.type === 'task.completed' || event.type === 'task.stopped') return true;
  if (event.type !== 'approval.changed' || typeof event.data !== 'object' || event.data === null) return false;
  const state = Reflect.get(event.data, 'state');
  return typeof state === 'string' && SETTLED_APPROVAL_STATES.has(state);
}

/**
 * The line above the patch. An empty diff is said in words rather than left blank. It claims only what is shown:
 * the runtime leaves sensitive and unsupported paths out of the diff.
 */
export function diffSummaryText(diff: DiffResult | undefined): string {
  if (!diff) return 'Loading changes…';
  if (!diff.summary && !diff.patch) return diff.truncated ? 'Some changes are not shown (truncated).' : 'No uncommitted changes to show.';
  return diff.summary + (diff.truncated ? ' (truncated)' : '');
}
