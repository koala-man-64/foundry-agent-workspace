import type { NoticeState } from './feedback';

const toneLabel = { error: 'Error', warning: 'Warning', info: 'Note', success: 'Done' } as const;

/**
 * The app notice. Exactly one is rendered at a time (inside the open dialog, otherwise in the main column), so it is
 * never hidden behind a modal backdrop. Screen-reader announcement goes through the always-mounted live regions in
 * App, so this element sets aria-live="off" and keeps role="status" for its semantics.
 */
export function Notice({ notice, onDismiss }: { notice?: NoticeState; onDismiss: () => void }) {
  if (!notice) return null;
  return <div className={`notice notice-${notice.tone}`} role="status" aria-live="off" data-tone={notice.tone}>
    <p><span className="visually-hidden">{toneLabel[notice.tone]}: </span>{notice.text}</p>
    <button type="button" onClick={onDismiss} aria-label="Dismiss notice">×</button>
  </div>;
}
