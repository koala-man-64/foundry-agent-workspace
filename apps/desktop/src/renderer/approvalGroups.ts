import type { Approval } from '../../../../packages/protocol/src/index';

type Decided = Pick<Approval, 'state' | 'result'>;

/**
 * A decided approval that may fold away because nothing about it needs Rudy: a rejection, or a completion without an
 * error result, a non-zero exit or unverified cleanup, with complete evidence and no failed action on the card.
 * Awaiting, approved, executing, unknown, failed and revoked cards never fold.
 */
export function foldableDecided(approval: Decided, evidenceComplete: boolean, cardError: boolean): boolean {
  if (!evidenceComplete || cardError) return false;
  if (approval.state === 'rejected') return true;
  if (approval.state !== 'complete') return false;
  const result = approval.result;
  return !result?.isError && (result?.exitCode === undefined || result.exitCode === 0) && result?.cleanupVerified !== false;
}

/**
 * Live cards first, decided cards after, each in their existing order. A card seen in a live state while the task is
 * open stays with the live cards (recorded in `seenLive`), so a decided card never folds away under the pointer. (In the
 * Focus tray, trayOrder then moves it below the cards still waiting, so the next decision takes its place.)
 */
export function partitionApprovals<T extends { id: string }>(approvals: readonly T[], foldable: (approval: T) => boolean, seenLive: Set<string>): { live: T[]; decided: T[] } {
  const live: T[] = [];
  const decided: T[] = [];
  for (const approval of approvals) {
    if (!foldable(approval)) seenLive.add(approval.id);
    (seenLive.has(approval.id) ? live : decided).push(approval);
  }
  return { live, decided };
}

/** "Decided approvals (3+: 2 complete, 1 rejected)": the summary of the folded group. */
export function decidedSummaryDetail(decided: readonly Pick<Approval, 'state'>[]): string {
  const complete = decided.filter(item => item.state === 'complete').length;
  const rejected = decided.filter(item => item.state === 'rejected').length;
  return [complete ? `${complete} complete` : '', rejected ? `${rejected} rejected` : ''].filter(Boolean).join(', ');
}

// Focus tray groups: waiting for a decision, unknown outcomes to inspect, still running, ended with a problem, settled.
const TRAY_GROUP: Record<Approval['state'], number> = {
  'awaiting-approval': 0, unknown: 1, approved: 2, executing: 2, failed: 3, revoked: 3, complete: 4, rejected: 4
};

/**
 * Focus tray order: what still needs Rudy comes first, so a card decided earlier can never push one that is waiting
 * below the fold. Within a group, oldest first with ties kept, so a later arrival joins below the one being read.
 */
export function trayOrder<T extends Pick<Approval, 'state' | 'createdAt'>>(approvals: readonly T[]): T[] {
  // A state this renderer does not know (a newer runtime) sorts with the unknown outcomes: never below settled cards.
  const group = (state: Approval['state']) => TRAY_GROUP[state] ?? TRAY_GROUP.unknown;
  return approvals.map((approval, index) => ({ approval, index }))
    .sort((a, b) => group(a.approval.state) - group(b.approval.state) || a.approval.createdAt.localeCompare(b.approval.createdAt) || a.index - b.index)
    .map(item => item.approval);
}
