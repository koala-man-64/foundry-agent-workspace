import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react';

/** The compact breakpoint; styles.css uses the same 950px in its media queries (custom properties cannot). */
export const COMPACT_LAYOUT_QUERY = '(max-width: 950px)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(COMPACT_LAYOUT_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** True in compact windows, where the sidebar narrows and the inspector becomes a slide-over. */
export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(COMPACT_LAYOUT_QUERY).matches, () => false);
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/**
 * The chosen inspector width clamped to the window as it is now, so narrowing the window never pushes the inspector off
 * screen and widening it again restores the chosen width. It re-renders only when the clamped width changes, not on
 * every resize.
 */
export function useShownInspectorWidth(width: number, rail: RailWidths): number {
  return useSyncExternalStore(subscribeResize, () => clampInspectorWidth(width, window.innerWidth, rail), () => width);
}

/** Whether an inspector tab is on screen: selected, and the inspector either a column or an open slide-over. */
export function inspectorTabInView(tabSelected: boolean, overlay: boolean, overlayOpen: boolean): boolean {
  return tabSelected && (!overlay || overlayOpen);
}

export interface InspectorOverlay {
  /** The inspector is a slide-over rather than a column. */
  overlay: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
  closeRef: RefObject<HTMLButtonElement | null>;
  asideProps: { ref: RefObject<HTMLElement | null>; role?: 'dialog'; 'aria-modal'?: true; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void };
}

/**
 * The inspector is a slide-over in compact windows and in Focus mode, unless the browser is expanded (then it stays a
 * column so the native view keeps its place). The slide-over is a dialog only while open; Esc closes it and focus
 * moves to its Close button and back to the Inspect task toggle. Leaving slide-over mode closes it, and focus never
 * stays inside an inspector that has just been hidden.
 */
export function useInspectorOverlay(focus: boolean, suppressed = false): InspectorOverlay {
  const compact = useCompactLayout();
  const overlay = (compact || focus) && !suppressed;
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!overlay) { setOpen(false); wasOpen.current = false; return; }
    if (!open && asideRef.current?.contains(document.activeElement)) toggleRef.current?.focus();
  }, [overlay]);
  useEffect(() => {
    if (!overlay) return;
    if (open) closeRef.current?.focus();
    else if (wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = open;
  }, [open, overlay]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !overlay || !open) return;
    // A dialog nested inside the inspector (the browser's confirm prompt) handles its own Escape.
    if (event.target instanceof Element && event.target.closest('[role="dialog"], dialog') !== event.currentTarget) return;
    setOpen(false);
  };
  return { overlay, open, setOpen, toggleRef, closeRef, asideProps: { ref: asideRef, role: overlay && open ? 'dialog' : undefined, 'aria-modal': overlay && open ? true : undefined, onKeyDown } };
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

/** The sidebar rail's width: styles.css sets --rail-w, and --rail-w-narrow at <=1050px. A style may change both. */
export interface RailWidths { wide: number; narrow: number }
export const DEFAULT_RAIL_WIDTHS: RailWidths = { wide: 270, narrow: 236 };

/**
 * The rail widths the page's tokens name now. A style must set them as px lengths (layout.test.ts checks every block);
 * anything else keeps the default. App reads them once, so a style that changes the rail at runtime must read again.
 */
export function documentRailWidths(style: Pick<CSSStyleDeclaration, 'getPropertyValue'> = getComputedStyle(document.documentElement)): RailWidths {
  const px = (name: string, fallback: number) => {
    const value = style.getPropertyValue(name).trim();
    return /^\d+(\.\d+)?px$/.test(value) ? Number.parseFloat(value) : fallback;
  };
  return { wide: px('--rail-w', DEFAULT_RAIL_WIDTHS.wide), narrow: px('--rail-w-narrow', DEFAULT_RAIL_WIDTHS.narrow) };
}

/** The widest inspector that still leaves the conversation its minimum width (320px, 260px in compact windows). */
export function maxInspectorWidth(viewportWidth: number, rail: RailWidths = DEFAULT_RAIL_WIDTHS): number {
  const sidebarWidth = viewportWidth <= 1050 ? rail.narrow : rail.wide;
  const minConversation = viewportWidth <= 950 ? 260 : 320;
  return Math.max(MIN_INSPECTOR_WIDTH, viewportWidth - sidebarWidth - minConversation - SEPARATOR_WIDTH);
}

export function clampInspectorWidth(width: number, viewportWidth: number, rail: RailWidths = DEFAULT_RAIL_WIDTHS): number {
  return Math.round(Math.max(MIN_INSPECTOR_WIDTH, Math.min(maxInspectorWidth(viewportWidth, rail), width)));
}

/**
 * The width a viewer who never dragged the separator gets: 360px at the 1000px minimum window, 400px at 1480px and 640px
 * from about 1920px, read when the app starts. A remembered (dragged) width always wins. Either is the chosen width, which
 * useShownInspectorWidth clamps to the current window.
 */
export function defaultInspectorWidth(viewportWidth: number, rail: RailWidths = DEFAULT_RAIL_WIDTHS): number {
  return clampInspectorWidth(Math.min(640, Math.max(360, 0.5455 * viewportWidth - 407)), viewportWidth, rail);
}

/** The remembered width (a per-viewer convenience in local storage), else the default; always clamped to the window. */
export function initialInspectorWidth(viewportWidth: number, storage: Pick<Storage, 'getItem'> | undefined, rail: RailWidths = DEFAULT_RAIL_WIDTHS): number {
  let stored: number | undefined;
  try { const value = Number(storage?.getItem(INSPECTOR_WIDTH_KEY)); stored = Number.isFinite(value) && value > 0 ? value : undefined; } catch { stored = undefined; }
  return stored === undefined ? defaultInspectorWidth(viewportWidth, rail) : clampInspectorWidth(stored, viewportWidth, rail);
}

export function rememberInspectorWidth(width: number, storage: Pick<Storage, 'setItem'> | undefined): void {
  try { storage?.setItem(INSPECTOR_WIDTH_KEY, String(Math.round(width))); } catch { /* storage can be unavailable; the width is only a convenience */ }
}

export interface TaskFilters { mode: string; status: string; projectId: string; projectPath: string; fromDate: string; toDate: string }

/** How many sidebar task filters are set; a closed Filters disclosure shows this so no active filter is hidden. */
export function activeFilterCount(filters: TaskFilters): number {
  return [filters.mode, filters.status, filters.projectId, filters.projectPath.trim(), filters.fromDate, filters.toDate].filter(Boolean).length;
}

/**
 * The Inbox's Recent outcomes fold while something needs a decision or is in progress (fixed when the group first
 * renders), and a stopped task's outcome forces them open: only finished outcomes ever fold away.
 */
export function recentOutcomesFold(counts: { needsDecision: number; inProgress: number } | undefined, actions: readonly { tier: number }[], rows: readonly { state: string }[]): { defaultOpen: boolean; forceOpen: boolean } {
  const busy = counts ? counts.needsDecision + counts.inProgress > 0 : actions.some(action => action.tier < 2);
  return { defaultOpen: !busy, forceOpen: rows.some(row => row.state !== 'task.completed') };
}
