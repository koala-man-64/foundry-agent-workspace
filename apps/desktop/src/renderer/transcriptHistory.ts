import type { MessagePage } from '../../../../packages/protocol/src/workspace';

/** Keep loaded older messages while replacing newer versions of streaming rows. */
export function mergeTranscriptPage<T extends { id: string }>(current: T[], items: { message: T; ordinal: number }[], ordinals: Map<string, number>): T[] {
  const merged = new Map(current.map(message => [message.id, message]));
  for (const item of items) {
    ordinals.set(item.message.id, item.ordinal);
    merged.set(item.message.id, item.message);
  }
  return [...merged.values()].sort((left, right) =>
    (ordinals.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (ordinals.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}

/** A burst larger than the latest page needs its own older-page traversal. */
export function refreshedOlderCursor(previousThrough: number | undefined, previousBefore: number | null, page: MessagePage): number | null {
  if (previousThrough === undefined) return page.nextBefore;
  const oldestLatest = page.items[0]?.ordinal;
  return oldestLatest !== undefined && oldestLatest > previousThrough + 1 ? oldestLatest : previousBefore;
}

/** Put a retained summary immediately before the first visible message after its recorded range. */
export function compactionSlot(toOrdinal: number, messages: { id: string }[], ordinals?: ReadonlyMap<string, number>): number {
  if (!ordinals) return messages.length;
  const firstAfter = messages.findIndex(message => (ordinals.get(message.id) ?? Number.NEGATIVE_INFINITY) > toOrdinal);
  return firstAfter < 0 ? messages.length : firstAfter;
}

export function isCompactedMessage(message: { id: string; status?: string }, fromOrdinal: number, toOrdinal: number, ordinals?: ReadonlyMap<string, number>): boolean {
  const ordinal = ordinals?.get(message.id);
  return message.status === 'complete' && ordinal !== undefined && ordinal >= fromOrdinal && ordinal <= toOrdinal;
}
