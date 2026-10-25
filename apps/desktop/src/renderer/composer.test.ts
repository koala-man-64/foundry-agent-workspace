import { describe, expect, it } from 'vitest';
import { draftSendBlockReason, isSendShortcut } from './composer';

const keys = (overrides: Partial<Parameters<typeof isSendShortcut>[0]> = {}) => ({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, ...overrides });

describe('isSendShortcut', () => {
  it('sends only on Ctrl+Enter or Cmd+Enter', () => {
    expect(isSendShortcut(keys({ ctrlKey: true }))).toBe(true);
    expect(isSendShortcut(keys({ metaKey: true }))).toBe(true);
  });

  it('never sends on bare Enter, Shift/Alt combinations, other keys or during IME composition', () => {
    expect(isSendShortcut(keys())).toBe(false);
    expect(isSendShortcut(keys({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSendShortcut(keys({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSendShortcut(keys({ ctrlKey: true, key: 'a' }))).toBe(false);
    expect(isSendShortcut(keys({ ctrlKey: true, isComposing: true }))).toBe(false);
  });
});

describe('draftSendBlockReason', () => {
  const ready = { schemaVersion: 5, unknownOutcome: false, folderUnavailable: false, profileMissing: false, profileUnverified: false, coordinatedWithoutValidation: false };

  it('is silent when nothing blocks the draft', () => {
    expect(draftSendBlockReason(ready)).toBeUndefined();
  });

  it('names the first unmet requirement in priority order', () => {
    expect(draftSendBlockReason({ ...ready, schemaVersion: undefined })).toBe('Loading the workspace…');
    expect(draftSendBlockReason({ ...ready, schemaVersion: 2, folderUnavailable: true })).toBe('Upgrade the database to start new chats.');
    expect(draftSendBlockReason({ ...ready, folderUnavailable: true, profileMissing: true })).toBe('This folder is unavailable. Restore it before starting a chat.');
    expect(draftSendBlockReason({ ...ready, profileMissing: true })).toMatch(/model profile is unavailable/);
    expect(draftSendBlockReason({ ...ready, profileUnverified: true })).toBe('Verify this profile in Model settings before sending.');
    expect(draftSendBlockReason({ ...ready, coordinatedWithoutValidation: true })).toMatch(/combined validation command/);
  });

  it('defers to the unknown-outcome explanation when a retry is pending', () => {
    expect(draftSendBlockReason({ ...ready, unknownOutcome: true, profileMissing: true })).toBeUndefined();
  });
});
