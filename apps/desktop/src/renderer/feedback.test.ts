import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { decisionFailure, errorMessage } from './feedback';
import { Notice } from './Notice';

describe('errorMessage', () => {
  it('removes only the Electron IPC wrapper and keeps the message verbatim', () => {
    const wrapped = new Error("Error invoking remote method 'workspace:invoke': Error: Compaction would not reduce context size for this message range.");
    expect(errorMessage(wrapped)).toBe('Compaction would not reduce context size for this message range.');
    expect(errorMessage(new Error("Error invoking remote method 'workspace:invoke': TypeError: bad input"))).toBe('bad input');
    expect(errorMessage(new Error('Prepared command fingerprint is stale; request approval again.'))).toBe('Prepared command fingerprint is stale; request approval again.');
  });

  it('handles non-Error values and a bare "Error:" prefix', () => {
    expect(errorMessage('plain text')).toBe('plain text');
    expect(errorMessage(String(new Error('boom')))).toBe('boom');
    expect(errorMessage(42)).toBe('42');
  });

  it('does not strip text that merely mentions errors', () => {
    expect(errorMessage(new Error('The Error invoking flag is not a wrapper here'))).toBe('The Error invoking flag is not a wrapper here');
  });
});

describe('decisionFailure', () => {
  it('names the action, keeps the cause verbatim and claims no outcome', () => {
    const text = decisionFailure('approve', new Error("Error invoking remote method 'workspace:invoke': Error: Approval nonce mismatch."));
    expect(text).toBe("This approval could not be confirmed: Approval nonce mismatch. Approvals were refreshed; review the card's current state before deciding again.");
    expect(text).not.toMatch(/applied|succeeded|was not run|failed to run/i);
    expect(decisionFailure('reconcile', 'x')).toMatch(/^The outcome check could not be confirmed: x/);
  });
});

describe('Notice', () => {
  it('keeps the role=status + .notice contract and states the tone in text', () => {
    const html = renderToStaticMarkup(createElement(Notice, { notice: { text: 'Committed abc on main.', tone: 'success' }, onDismiss: () => undefined }));
    expect(html).toContain('class="notice notice-success"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Done: </span>Committed abc on main.');
    expect(html).toContain('aria-label="Dismiss notice"');
  });

  it('renders nothing without a notice', () => {
    expect(renderToStaticMarkup(createElement(Notice, { notice: undefined, onDismiss: () => undefined }))).toBe('');
  });
});
