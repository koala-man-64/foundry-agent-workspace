import { useSyncExternalStore } from 'react';

/** The slide-over breakpoint; styles.css uses the same 950px in its media queries (custom properties cannot). */
export const COMPACT_LAYOUT_QUERY = '(max-width: 950px)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(COMPACT_LAYOUT_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** True while the inspector is a slide-over rather than a column. */
export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(COMPACT_LAYOUT_QUERY).matches, () => false);
}

/** Inspector tab label: the runtime's pending count, "+" when the loaded list may be partial, unknown outcomes named. */
export function approvalsTabLabel(pending: number, unknown = 0, partial = false): string {
  const parts = [pending > 0 ? `${pending}${partial ? '+' : ''} waiting` : '', unknown > 0 ? `${unknown} unknown` : ''].filter(Boolean);
  return parts.length ? `Approvals (${parts.join(' · ')})` : 'Approvals';
}

export type PatchLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

/** Classify unified-diff lines for display. The text is untouched; joining the lines reproduces the patch exactly. */
export function classifyPatchLines(patch: string): { text: string; kind: PatchLineKind }[] {
  const lines = patch.split('\n');
  return lines.map((line, index) => {
    const text = index < lines.length - 1 ? `${line}\n` : line;
    const kind: PatchLineKind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta'
      : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context';
    return { text, kind };
  });
}
