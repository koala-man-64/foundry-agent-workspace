import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { draftSendBlockReason, isFocusShortcut, isSendShortcut } from './composer';
import { FocusControls } from './FocusControls';

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

describe('isFocusShortcut', () => {
  const chord = (overrides: Partial<Parameters<typeof isFocusShortcut>[0]> = {}) => ({ code: 'KeyF', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false, isComposing: false, ...overrides });

  it('matches Ctrl+Shift+F by physical key only', () => {
    expect(isFocusShortcut(chord())).toBe(true);
    expect(isFocusShortcut(chord({ code: 'KeyG' }))).toBe(false);
    expect(isFocusShortcut(chord({ shiftKey: false }))).toBe(false);
    expect(isFocusShortcut(chord({ ctrlKey: false }))).toBe(false);
  });

  it('ignores AltGr and Meta combinations, key repeat and IME composition', () => {
    expect(isFocusShortcut(chord({ altKey: true }))).toBe(false);
    expect(isFocusShortcut(chord({ metaKey: true }))).toBe(false);
    expect(isFocusShortcut(chord({ repeat: true }))).toBe(false);
    expect(isFocusShortcut(chord({ isComposing: true }))).toBe(false);
  });
});

describe('FocusControls', () => {
  const render = (on: boolean, needsYou?: string) => renderToStaticMarkup(createElement(FocusControls, { on, needsYou, onToggle: () => undefined, onShowInbox: () => undefined }));

  it('keeps a constant name with a pressed state and a discoverable shortcut', () => {
    expect(render(false)).toBe('<button type="button" class="secondary focus-toggle" aria-pressed="false" aria-keyshortcuts="Control+Shift+F" title="Focus mode (Ctrl+Shift+F)">Focus mode<span class="shortcut-hint" aria-hidden="true">Ctrl+Shift+F</span></button>');
    expect(render(true)).toContain('aria-pressed="true"');
  });

  it('shows the needs-you route only while focused', () => {
    expect(render(false, '2 need you')).not.toContain('focus-chip');
    expect(render(true, '2 need you')).toContain('<button type="button" class="secondary focus-chip" title="Leave Focus mode and show the Inbox">2 need you</button>');
    expect(render(true)).not.toContain('focus-chip');
  });
});
