import { Disclosure, disclosureLabel } from './Disclosure';

export type ToolReadiness = 'offline' | 'verified' | 'unavailable';

const READINESS_TEXT: Record<ToolReadiness, string> = {
  offline: 'Offline deterministic coding demo. Type /demo to create reviewed sample actions.',
  verified: 'Verified tool and continuation support. Each proposed action still needs review and approval.',
  unavailable: 'Tool execution unavailable until this profile is re-probed with tool and continuation support.'
};

interface Props {
  readiness: ToolReadiness;
  /** The command-review limits, word for word. */
  commandReviewHelp: string;
  /** The panel already lists approval cards, so the profile note is reference rather than the empty state. */
  hasCards: boolean;
  /** A command card is live (awaiting, approved, executing, unknown or failed) or some evidence is incomplete. */
  commandDecisionOpen: boolean;
}

/**
 * The notes above a coding task's approvals. A warning (tools unavailable) and the command-review limits while a
 * command decision is open stay on screen; the rest folds into one counted disclosure. Wording never changes.
 */
export function ToolReadinessNotes({ readiness, commandReviewHelp, hasCards, commandDecisionOpen }: Props) {
  const profileNote = <p key="profile" className="tool-readiness">{READINESS_TEXT[readiness]}</p>;
  const limits = <p key="limits" className="tool-readiness" data-testid="command-review-limits">{commandReviewHelp}</p>;
  const showProfile = readiness === 'unavailable' || !hasCards;
  const folded = [showProfile ? null : profileNote, commandDecisionOpen ? null : limits].filter(note => note !== null);
  return <>
    {showProfile && profileNote}
    {commandDecisionOpen && limits}
    {folded.length > 0 && <Disclosure className="tool-notes" summary={disclosureLabel('Tool review notes', folded.length)}>{folded}</Disclosure>}
  </>;
}
