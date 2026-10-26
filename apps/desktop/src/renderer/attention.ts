import { useEffect, useRef } from 'react';
import type { Approval } from '../../../../packages/protocol/src/index';
import type { AgentRun, IntegrationOperation } from '../../../../packages/protocol/src/orchestration';
import type { NoticeTone } from './feedback';

/**
 * What on the open task needs Rudy. Derived on every render from runtime counts, so it never acknowledges, dismisses
 * or stores anything. `unknown` counts unknown tool approvals plus unknown commit/push/retire outcomes; the runtime
 * reports them together, so `unknownPublication` (the part no loaded approval card accounts for) can over-report but
 * never under-reports.
 */
export interface Attention {
  awaiting: number;
  unknown: number;
  unknownPublication: number;
  /** For coordinated tasks: unknown integrations, checked from the Orchestration tab. */
  unknownIntegrations: number;
  /** More agents or approvals exist than are loaded, so counts are lower bounds ("2+"). */
  partial: boolean;
}

type StateOnly = Pick<Approval, 'state'>;
const count = (items: readonly StateOnly[] | undefined, state: Approval['state']) => items?.filter(item => item.state === state).length ?? 0;

/** An ordinary task: `task.read` counts, raised by whatever approval cards are already loaded. */
export function taskAttention(input: { pendingApprovals: number; unknownOutcomes: number; approvals?: readonly StateOnly[] }): Attention {
  const unknownCards = count(input.approvals, 'unknown');
  const unknown = Math.max(input.unknownOutcomes, unknownCards);
  return { awaiting: Math.max(input.pendingApprovals, count(input.approvals, 'awaiting-approval')), unknown, unknownPublication: unknown - unknownCards, unknownIntegrations: 0, partial: false };
}

/** A coordinated task: loaded approvals, agents waiting on approval (always loaded with the run list) and unknown integrations. */
export function coordinatedAttention(input: { approvals: readonly StateOnly[]; runs: readonly Pick<AgentRun, 'lifecycle' | 'waitReason'>[]; integrations: readonly Pick<IntegrationOperation, 'state'>[]; partial: boolean }): Attention {
  const waitingRuns = input.runs.filter(run => run.lifecycle === 'waiting' && run.waitReason === 'approval').length;
  const unknownIntegrations = input.integrations.filter(item => item.state === 'unknown').length;
  return { awaiting: Math.max(count(input.approvals, 'awaiting-approval'), waitingRuns), unknown: count(input.approvals, 'unknown') + unknownIntegrations, unknownPublication: 0, unknownIntegrations, partial: input.partial };
}

export function needsYou(attention: Attention): boolean {
  return attention.awaiting > 0 || attention.unknown > 0;
}

/** The header toggle that opens the slide-over inspector names what is waiting inside it. */
export function inspectLabel(attention: Attention): string {
  return `Inspect task${attention.awaiting > 0 ? ' · approval waiting' : ''}${attention.unknown > 0 ? ' · outcome unknown' : ''}`;
}

export type AttentionTarget = 'approvals' | 'publish' | 'orchestration';

export interface AttentionBanner { lines: string[]; action: 'Review pending actions' | 'Review unknown outcomes'; target: AttentionTarget }

/**
 * The banner above the composer. Awaiting decisions come first and keep their existing sentences; unknown outcomes
 * reuse the Activity panel's recovery wording. When approval cards are already on screen (the Focus tray), only the
 * outcomes no card shows are named.
 */
export function attentionBanner(attention: Attention, cardsOnScreen = false): AttentionBanner | undefined {
  const awaiting = cardsOnScreen ? 0 : attention.awaiting;
  const unknownCards = attention.unknown - attention.unknownPublication - attention.unknownIntegrations;
  const unknown = cardsOnScreen ? attention.unknown - unknownCards : attention.unknown;
  if (awaiting <= 0 && unknown <= 0) return undefined;
  const plus = attention.partial ? '+' : '';
  const lines: string[] = [];
  if (awaiting > 0) lines.push(awaiting > 1 ? `${awaiting}${plus} actions are waiting for your decision.` : 'An action is waiting for your decision.');
  if (unknown > 0) lines.push(`${unknown} outcome${unknown === 1 ? ' needs' : 's need'} inspection. Unknown does not mean success and is never retried automatically.`);
  const target: AttentionTarget = awaiting > 0 || (unknownCards > 0 && !cardsOnScreen) ? 'approvals' : attention.unknownIntegrations > 0 ? 'orchestration' : 'publish';
  return { lines, action: awaiting > 0 ? 'Review pending actions' : 'Review unknown outcomes', target };
}

/** Inbox needs-decision count across all tasks, or unavailable when the action center could not be read. */
export type InboxCount = { needsDecision: number } | 'unavailable';

/** The Focus-mode chip: never a false zero. */
export function inboxChipLabel(counts: InboxCount | undefined): string | undefined {
  if (counts === 'unavailable') return 'Needs-you count unavailable';
  if (!counts || counts.needsDecision <= 0) return undefined;
  return `${counts.needsDecision} need${counts.needsDecision === 1 ? 's' : ''} you`;
}

/** Window title: the taskbar and Alt+Tab show when something needs Rudy while the app is in the background. */
export function windowTitle(base: string, inbox: InboxCount | undefined, openTask: Attention | undefined): string {
  const fromInbox = inbox && inbox !== 'unavailable' ? inbox.needsDecision : 0;
  const fromTask = openTask ? openTask.awaiting + openTask.unknown : 0;
  const count = Math.max(fromInbox, fromTask);
  return count > 0 ? `Needs you (${count}) · ${base}` : base;
}

/** Where a waiting decision can be reached right now, in the words of the announcement and the composer hint. */
export type DecisionSurface = 'approvals' | 'tray' | 'banner';

export function decisionWhere(surface: DecisionSurface): string {
  return surface === 'approvals' ? ' in Approvals.' : surface === 'tray' ? ' in Pending actions.' : '. Use Review pending actions.';
}

/** `running` is undefined until the task's status is known; `finished` is what to say when a run ends. */
export interface AnnouncedState { taskId?: string; awaiting: number; unknown: number; running?: boolean; finished?: string }

/**
 * The one sentence to announce for a change on the open task, or nothing. The first observation of a task (initial
 * load or a task switch) is never announced; a new unknown outcome interrupts, everything else waits.
 */
export function attentionAnnouncement(previous: AnnouncedState, next: AnnouncedState, surface: DecisionSurface): { text: string; tone: NoticeTone } | undefined {
  if (previous.taskId !== next.taskId) return undefined;
  if (next.unknown > previous.unknown) return { text: `${next.unknown} outcome${next.unknown === 1 ? ' needs' : 's need'} inspection. Unknown does not mean success and is never retried automatically.`, tone: 'error' };
  if (next.awaiting > 0 && previous.awaiting === 0) return { text: `An action is waiting for your decision${decisionWhere(surface)}`, tone: 'info' };
  if (previous.running === true && next.running === false && next.finished) return { text: next.finished, tone: 'info' };
  return undefined;
}

/** Announce attention changes on the open task through the app's live regions (shared by both task views). */
export function useAttentionAnnouncements(state: AnnouncedState, surface: DecisionSurface, announce: (text: string, tone?: NoticeTone) => void): void {
  const previous = useRef<AnnouncedState>({ awaiting: 0, unknown: 0 });
  const { taskId, awaiting, unknown, running, finished } = state;
  useEffect(() => {
    const next = { taskId, awaiting, unknown, running, finished };
    const message = attentionAnnouncement(previous.current, next, surface);
    if (message) announce(message.text, message.tone);
    previous.current = next;
  }, [taskId, awaiting, unknown, running, finished]);
}

/** The runtime's task budget warning fires at 80% of charged or reserved tokens (agent-loop.ts, service.ts). */
const BUDGET_WARNING_RATIO = 0.8;

/** Words appended to the header status line when a runtime threshold is crossed, so colour is never the only cue. */
export function statusWarnings(input: { usedTokens: number; tokenBudget: number; contextPercent?: number; warningPercent?: number }): string[] {
  const warnings: string[] = [];
  if (input.contextPercent !== undefined && input.warningPercent !== undefined && input.contextPercent >= input.warningPercent) warnings.push('context warning');
  if (input.tokenBudget > 0 && input.usedTokens >= input.tokenBudget * BUDGET_WARNING_RATIO) warnings.push('budget warning');
  return warnings;
}
