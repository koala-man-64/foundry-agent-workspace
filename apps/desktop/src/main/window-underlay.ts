/** The window colour shown before the page paints and while resizing: Foundry Light's --canvas-deep. */
export const DEFAULT_UNDERLAY = '#e8e2d4';

/**
 * The UI renderer names the active theme's underlay through <meta name="theme-color">, and Electron reports it with
 * did-change-theme-color. Only a plain #rrggbb value is applied; anything else (null when the meta is removed, a
 * keyword, a malformed value) leaves the window as it is.
 */
export function underlayColor(color: string | null | undefined): string | undefined {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}
