import { describe, expect, it } from 'vitest';
import { compactionSlot, isCompactedMessage, mergeTranscriptPage, refreshedOlderCursor } from './transcriptHistory';
import type { MessagePage } from '../../../../packages/protocol/src/workspace';

const row = (ordinal: number, status: 'streaming' | 'complete' = 'complete') => ({ ordinal, message: { id: `m${ordinal}`, status, content: `${status} ${ordinal}` } });

describe('paged transcript refresh', () => {
  it('replaces a streaming row in place and retains older loaded rows', () => {
    const ordinals = new Map<string, number>();
    const first = mergeTranscriptPage([], [row(1), row(2, 'streaming')], ordinals);
    const refreshed = mergeTranscriptPage(first, [row(2, 'complete'), row(3)], ordinals);
    expect(refreshed.map(item => item.id)).toEqual(['m1', 'm2', 'm3']);
    expect(refreshed[1]).toMatchObject({ status: 'complete', content: 'complete 2' });
  });

  it('bridges a burst larger than the latest page without losing ordinals or duplicating rows', () => {
    const ordinals = new Map<string, number>();
    let history = mergeTranscriptPage([], Array.from({ length: 50 }, (_, index) => row(index + 1)), ordinals);
    const latest = { items: Array.from({ length: 50 }, (_, index) => row(index + 61)), nextBefore: 61, through: 110 };
    let cursor = refreshedOlderCursor(50, null, latest as unknown as MessagePage);
    expect(cursor).toBe(61);
    history = mergeTranscriptPage(history, latest.items, ordinals);
    const gap = Array.from({ length: 50 }, (_, index) => row(index + 11));
    history = mergeTranscriptPage(history, gap, ordinals);
    cursor = 11;
    history = mergeTranscriptPage(history, Array.from({ length: 10 }, (_, index) => row(index + 1)), ordinals);
    expect(cursor).toBe(11);
    expect(history.map(item => item.id)).toEqual(Array.from({ length: 110 }, (_, index) => `m${index + 1}`));
  });

  it('places a bounded compaction summary at its recorded ordinal boundary', () => {
    const messages = [{ id: 'older' }, { id: 'compacted' }, { id: 'newer' }];
    const ordinals = new Map([['older', 2], ['compacted', 5], ['newer', 12]]);
    expect(compactionSlot(8, messages, ordinals)).toBe(2);
    expect(compactionSlot(1, messages, ordinals)).toBe(0);
    expect(compactionSlot(20, messages, ordinals)).toBe(3);
    expect(isCompactedMessage({ id: 'compacted', status: 'complete' }, 4, 8, ordinals)).toBe(true);
    expect(isCompactedMessage({ id: 'compacted', status: 'streaming' }, 4, 8, ordinals)).toBe(false);
    expect(isCompactedMessage({ id: 'compacted', status: 'failed' }, 4, 8, ordinals)).toBe(false);
    expect(isCompactedMessage({ id: 'newer', status: 'complete' }, 4, 8, ordinals)).toBe(false);
  });
});
