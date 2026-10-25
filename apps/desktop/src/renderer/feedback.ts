export type NoticeTone = 'error' | 'warning' | 'info' | 'success';
export interface NoticeState { text: string; tone: NoticeTone }
/** Set or clear (empty text) the single app notice. Callers that pass no tone report an error. */
export type SetNotice = (text: string, tone?: NoticeTone) => void;

// Electron's ipcRenderer.invoke wraps every rejection as "Error invoking remote method '<channel>': Error: <message>".
const IPC_WRAPPER = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

/** Inline approval-card failure text. It never claims whether the action ran, nor that the card was re-read. */
export function decisionFailure(action: 'approve' | 'reject' | 'reconcile' | 'acknowledge', error: unknown): string {
  const what = action === 'approve' ? 'This approval' : action === 'reject' ? 'This rejection' : action === 'reconcile' ? 'The outcome check' : 'The inspection record';
  const cause = errorMessage(error).trim();
  return `${what} could not be confirmed: ${cause}${/[.!?]$/.test(cause) ? '' : '.'} Check the card's recorded state before deciding again; reopen Approvals if it has not changed.`;
}

/** The user-facing text of a failure: the original message, without the IPC transport wrapper or an "Error:" prefix. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(IPC_WRAPPER, '').replace(/^Error: /, '');
}
