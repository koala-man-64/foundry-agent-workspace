import type { ApprovalState, TaskStatus } from '../../../../packages/protocol/src/index';
import type { ActionItem } from '../../../../packages/protocol/src/workspace';
import type { RunLifecycle, WaitReason } from '../../../../packages/protocol/src/orchestration';

/** The one user-facing name for each task status (sidebar rows, headers, filters). */
export const taskStatusLabel: Record<TaskStatus, string> = {
  idle: 'Ready', running: 'Working', cancelled: 'Cancelled', interrupted: 'Interrupted', failed: 'Needs attention', retired: 'Retired'
};

/**
 * Approval states as lowercase words. Each keeps the raw state keyword ("unknown", "complete", "rejected") so the
 * text still names the recorded state exactly; CSS capitalises it for display.
 */
export const approvalStateLabel: Record<ApprovalState, string> = {
  'awaiting-approval': 'awaiting approval', approved: 'approved', executing: 'executing', complete: 'complete',
  rejected: 'rejected', revoked: 'revoked', unknown: 'unknown outcome', failed: 'failed'
};

export const lifecycleLabel: Record<RunLifecycle, string> = { queued: 'Queued', preparing: 'Preparing', running: 'Running', waiting: 'Waiting', terminal: 'Terminal' };

export const waitReasonLabel: Record<WaitReason, string> = {
  admission: 'Waiting for an admission slot', dependencies: 'Waiting on dependencies', children: 'Waiting on children',
  approval: 'Waiting on approval', 'profile-quota': 'Waiting on profile availability', 'task-budget': 'Waiting on task budget',
  conflict: 'Blocked on a conflict', reconciliation: 'Awaiting reconciliation', 'user-continuation': 'Waiting for you to continue'
};

/** Sentence-case an identifier such as `git.push`, `task-budget` or `promptDraft` for display. */
export function humanize(value: string): string {
  const words = value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

function isKey<T extends string>(record: Record<T, string>, value: string): value is T {
  return Object.prototype.hasOwnProperty.call(record, value);
}

/** What an Inbox item is waiting on, in words. Unknown outcomes always say "unknown". */
export function actionStateLabel(action: Pick<ActionItem, 'kind' | 'state'>): string {
  const { kind, state } = action;
  if (kind === 'approval') return state === 'awaiting-approval' ? 'Approval waiting for you' : state === 'unknown' ? 'Approval outcome unknown' : `Approval ${isKey(approvalStateLabel, state) ? approvalStateLabel[state] : humanize(state).toLowerCase()}`;
  if (kind === 'intent') return state === 'unknown' ? 'Outcome unknown' : humanize(state);
  if (kind === 'task') return state === 'running' ? 'Task running' : `Task ${humanize(state).toLowerCase()}`;
  if (kind === 'run') return `Agent ${(isKey(lifecycleLabel, state) ? lifecycleLabel[state] : humanize(state)).toLowerCase()}`;
  if (kind === 'validation') return state === 'failed' ? 'Validation failed' : `Validation ${humanize(state).toLowerCase()}`;
  if (kind === 'draft') return 'Draft ready to review';
  if (state === 'task.completed') return 'Finished';
  if (state === 'task.stopped') return 'Stopped';
  return humanize(state);
}

/** The Inbox item's detail line; raw wait reasons and draft kinds become words, free text passes through. */
export function actionDetailLabel(action: Pick<ActionItem, 'kind' | 'detail'>): string {
  const { kind, detail } = action;
  if (kind === 'run' && isKey(waitReasonLabel, detail)) return waitReasonLabel[detail];
  if (kind === 'draft') return detail === 'promptDraft' ? 'Prompt draft' : detail === 'actionDraft' ? 'Proposed action draft' : humanize(detail);
  if (kind === 'intent') return humanize(detail);
  return detail;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const elapsed = now - new Date(iso).getTime();
  if (!Number.isFinite(elapsed)) return iso;
  const minutes = Math.max(0, Math.round(elapsed / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** Locale date and time without seconds; the caller keeps the exact instant in a dateTime or title attribute. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Compact list form: the time for today, otherwise the date. */
export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toDateString() === now.toDateString() ? date.toLocaleTimeString(undefined, { timeStyle: 'short' }) : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}
