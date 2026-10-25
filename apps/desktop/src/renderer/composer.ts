import type { KeyboardEvent } from 'react';

interface ShortcutKeys { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; isComposing?: boolean }

/** Ctrl+Enter (Cmd+Enter on macOS keyboards) sends. Bare Enter stays a newline, and IME composition never sends. */
export function isSendShortcut(keys: ShortcutKeys): boolean {
  return keys.key === 'Enter' && (keys.ctrlKey || keys.metaKey) && !keys.shiftKey && !keys.altKey && !keys.isComposing;
}

/**
 * Key handler for a composer textarea: the shortcut submits the form through the same guarded path as the Send
 * button, and only when that button is enabled.
 */
export function sendOnShortcut(canSend: boolean, onUnavailable?: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSendShortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    if (canSend) event.currentTarget.form?.requestSubmit();
    else onUnavailable?.();
  };
}

export interface DraftSendState {
  schemaVersion?: number;
  unknownOutcome: boolean;
  folderUnavailable: boolean;
  profileMissing: boolean;
  profileUnverified: boolean;
  coordinatedWithoutValidation: boolean;
}

/** The first unmet requirement that keeps a New chat draft from being sent, as one sentence (none for an empty draft). */
export function draftSendBlockReason(state: DraftSendState): string | undefined {
  if (state.schemaVersion === undefined) return 'Loading the workspace…';
  if (state.schemaVersion < 3) return 'Upgrade the database to start new chats.';
  if (state.unknownOutcome) return undefined;
  if (state.folderUnavailable) return 'This folder is unavailable. Restore it before starting a chat.';
  if (state.profileMissing) return 'The saved model profile is unavailable. Choose a profile before sending.';
  if (state.profileUnverified) return 'Verify this profile in Model settings before sending.';
  if (state.coordinatedWithoutValidation) return 'Enter the required combined validation command (More options).';
  return undefined;
}
