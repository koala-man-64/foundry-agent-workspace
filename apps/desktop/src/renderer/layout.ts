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
  let inHunk = false;
  return lines.map((line, index) => {
    const text = index < lines.length - 1 ? `${line}\n` : line;
    // Inside a hunk, "---"/"+++" are a deleted "--…" line or an added "++…" line, not file headers.
    if (line.startsWith('diff ')) inHunk = false;
    const kind: PatchLineKind = line.startsWith('@@') ? 'hunk'
      : !inHunk && (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) ? 'meta'
        : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context';
    if (kind === 'hunk') inHunk = true;
    return { text, kind };
  });
}

const SEPARATOR_WIDTH = 5;
export const MIN_INSPECTOR_WIDTH = 300;
const INSPECTOR_WIDTH_KEY = 'foundry.inspectorWidth';

/** The widest inspector that still leaves the conversation its minimum width (320px, 260px in compact windows). */
export function maxInspectorWidth(viewportWidth: number): number {
  // Mirrors the grid in styles.css: a 270px sidebar, 236px at <=1050px.
  const sidebarWidth = viewportWidth <= 1050 ? 236 : 270;
  const minConversation = viewportWidth <= 950 ? 260 : 320;
  return Math.max(MIN_INSPECTOR_WIDTH, viewportWidth - sidebarWidth - minConversation - SEPARATOR_WIDTH);
}

export function clampInspectorWidth(width: number, viewportWidth: number): number {
  return Math.round(Math.max(MIN_INSPECTOR_WIDTH, Math.min(maxInspectorWidth(viewportWidth), width)));
}

/** 360px up to a 1480px window, then growing with the spare width to at most 480px. */
export function defaultInspectorWidth(viewportWidth: number): number {
  return clampInspectorWidth(Math.min(480, 360 + Math.max(0, viewportWidth - 1480) * 0.3), viewportWidth);
}

/** The remembered width (a per-viewer convenience in local storage), else the default; always clamped to the window. */
export function initialInspectorWidth(viewportWidth: number, storage: Pick<Storage, 'getItem'> | undefined): number {
  let stored: number | undefined;
  try { const value = Number(storage?.getItem(INSPECTOR_WIDTH_KEY)); stored = Number.isFinite(value) && value > 0 ? value : undefined; } catch { stored = undefined; }
  return stored === undefined ? defaultInspectorWidth(viewportWidth) : clampInspectorWidth(stored, viewportWidth);
}

export function rememberInspectorWidth(width: number, storage: Pick<Storage, 'setItem'> | undefined): void {
  try { storage?.setItem(INSPECTOR_WIDTH_KEY, String(Math.round(width))); } catch { /* storage can be unavailable; the width is only a convenience */ }
}

export interface TaskFilters { mode: string; status: string; projectId: string; projectPath: string; fromDate: string; toDate: string }

/** How many sidebar task filters are set; a closed Filters disclosure shows this so no active filter is hidden. */
export function activeFilterCount(filters: TaskFilters): number {
  return [filters.mode, filters.status, filters.projectId, filters.projectPath.trim(), filters.fromDate, filters.toDate].filter(Boolean).length;
}
