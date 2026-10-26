import type { ReactNode } from 'react';
import { traySummary } from './attention';

interface Props {
  /** How many awaiting and unknown cards the tray holds, named above the scroll area so none is missed below the fold. */
  shown: { awaiting: number; unknown: number };
  /** Notes that qualify the decision (the command-review limits, a tools-unavailable warning), kept out of the scroll area. */
  notes?: ReactNode;
  children: ReactNode;
}

/**
 * Focus mode's Pending actions: the live approval cards above the composer. The summary and notes never scroll away;
 * the cards scroll inside a bounded, keyboard-reachable area.
 */
export function ApprovalTray({ shown, notes, children }: Props) {
  return <section className="approval-tray" aria-label="Pending actions">
    <p className="tray-summary">{traySummary(shown)}</p>
    {notes}
    <div className="approval-tray-cards" role="group" aria-label="Pending action cards" tabIndex={0}>{children}</div>
  </section>;
}
