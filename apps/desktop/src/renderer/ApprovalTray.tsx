import type { ReactNode } from 'react';
import { traySummary } from './attention';

interface Props {
  /** How many awaiting and unknown cards the tray holds, named above the scroll area so none is missed below the fold. */
  shown: { awaiting: number; unknown: number };
  /** Notes that qualify the decision (the command-review limits, a tools-unavailable warning), above the first card. */
  notes?: ReactNode;
  children: ReactNode;
}

/**
 * Focus mode's Pending actions: the live approval cards above the composer, cards still waiting first (see trayOrder),
 * so a decided card never pushes a waiting one below the fold. The counted summary never scrolls away; the notes and
 * cards scroll inside a bounded, keyboard-reachable area, as they do in the inspector.
 */
export function ApprovalTray({ shown, notes, children }: Props) {
  return <section className="approval-tray" aria-label="Pending actions">
    <p className="tray-summary">{traySummary(shown)}</p>
    <div className="approval-tray-cards" role="group" aria-label="Pending action cards" tabIndex={0}>{notes}{children}</div>
  </section>;
}
