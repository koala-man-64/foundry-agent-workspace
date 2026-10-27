import type { DiffResult, WorkspaceEvent } from '../../../../packages/protocol/src/index';
import { PatchText } from './Evidence';

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
 * The line above the patch. An empty diff is said in words rather than left blank, and never as a clean worktree:
 * the runtime leaves secret-named paths, and untracked files it cannot read as text, out of the diff.
 */
export function diffSummaryText(diff: DiffResult | undefined): string {
  if (!diff) return 'Loading changes…';
  if (!diff.summary && !diff.patch) return diff.truncated ? 'Some changes are not shown (truncated).' : EMPTY_DIFF_TEXT;
  return diff.summary + (diff.truncated ? ' (truncated)' : '');
}

export const EMPTY_DIFF_TEXT = 'No changes to show. Secret-named files, and new files that are binary or too large to read, are not listed.';

/** The Changes tab. A failed read is said in place, also over an older diff, which may then be out of date. */
export function ChangesPanel({ diff, error, onRetry }: { diff: DiffResult | undefined; error: string; onRetry: () => void }) {
  return <div className="patch">
    {error && <div className="load-error" role="alert"><p>Could not load changes: {error}{diff ? ' What is shown below may be out of date.' : ''}</p><button type="button" className="secondary" onClick={onRetry}>Retry</button></div>}
    {(diff || !error) && <p>{diffSummaryText(diff)}</p>}
    {diff?.patch && <PatchText patch={diff.patch} />}
  </div>;
}
