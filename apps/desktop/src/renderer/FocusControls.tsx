interface Props {
  on: boolean;
  onToggle: () => void;
  /** The "N need you" text for work elsewhere (or "Needs-you count unavailable"), shown only while Focus is on. */
  needsYou?: string;
  /** Leaves Focus mode and shows the Inbox: the route to work elsewhere while the sidebar is hidden. */
  onShowInbox: () => void;
}

/**
 * The Focus mode toggle (constant name, pressed state) and, while focused, the count of work that needs Rudy
 * elsewhere. Both sit in the view header, never inside a region Focus hides.
 */
export function FocusControls({ on, onToggle, needsYou, onShowInbox }: Props) {
  return <>
    <button type="button" className="secondary focus-toggle" aria-pressed={on} aria-keyshortcuts="Control+Shift+F" title="Focus mode (Ctrl+Shift+F)" onClick={onToggle}>Focus mode<span className="shortcut-hint" aria-hidden="true">Ctrl+Shift+F</span></button>
    {on && needsYou && <button type="button" className="secondary focus-chip" title="Leave Focus mode and show the Inbox" onClick={onShowInbox}>{needsYou}</button>}
  </>;
}
