/**
 * Compiled-in theme presets. The preference is one value of a closed list, kept in this viewer's storage like the
 * inspector width; it is never read from repository text, model output, a URL or a file. A theme is a block of token
 * values in styles.css selected by data-theme on <html>.
 */
export const THEMES = ['system', 'light', 'dark', 'contrast'] as const;
export type ThemePreference = (typeof THEMES)[number];
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;
export const THEME_LABELS: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark', contrast: 'High contrast' };
// public/theme-boot.js mirrors this key and the light fallback, so the first frame is already themed.
export const THEME_STORAGE_KEY = 'foundry.theme';

/** The stored preference; anything missing, unknown (a removed preset, a hand edit) or unreadable is Light. */
export function readTheme(storage: Storage | undefined): ThemePreference {
  try { const value = storage?.getItem(THEME_STORAGE_KEY); return THEMES.find(theme => theme === value) ?? 'light'; } catch { return 'light'; }
}

export function saveTheme(theme: ThemePreference, storage: Storage | undefined): void {
  try { storage?.setItem(THEME_STORAGE_KEY, theme); } catch { /* only a convenience, like the inspector width */ }
}

export function resolveTheme(theme: ThemePreference, prefersDark: boolean): ResolvedTheme {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
}

/**
 * Compiled-in styles: the size and spacing axis, independent of the theme. Kept like the theme, selected by data-style on
 * <html>; Comfortable is the token defaults, Compact a block of token values in styles.css.
 */
export const STYLES = ['comfortable', 'compact'] as const;
export type StylePreference = (typeof STYLES)[number];
export const STYLE_LABELS: Record<StylePreference, string> = { comfortable: 'Comfortable', compact: 'Compact' };
// public/theme-boot.js mirrors this key and the Comfortable fallback too.
export const STYLE_STORAGE_KEY = 'foundry.style';

/** The stored style; anything missing, unknown or unreadable is Comfortable. */
export function readStyle(storage: Storage | undefined): StylePreference {
  try { const value = storage?.getItem(STYLE_STORAGE_KEY); return STYLES.find(style => style === value) ?? 'comfortable'; } catch { return 'comfortable'; }
}

export function saveStyle(style: StylePreference, storage: Storage | undefined): void {
  try { storage?.setItem(STYLE_STORAGE_KEY, style); } catch { /* only a convenience, like the theme */ }
}

export function applyStyle(style: StylePreference, root: HTMLElement): void {
  root.dataset.style = style;
}

export interface ThemeHost {
  root: HTMLElement;
  /** The page's <meta name="theme-color">: main applies it as the window underlay (did-change-theme-color). */
  themeColor: HTMLMetaElement | null;
  /** (prefers-color-scheme: dark), the Windows app mode. */
  darkMode: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  styleOf: (element: Element) => Pick<CSSStyleDeclaration, 'getPropertyValue'>;
}

export function documentThemeHost(): ThemeHost {
  return { root: document.documentElement, themeColor: document.querySelector('meta[name="theme-color"]'), darkMode: window.matchMedia('(prefers-color-scheme: dark)'), styleOf: element => getComputedStyle(element) };
}

/** Sets data-theme and the underlay colour. System follows the Windows app mode until the returned stop runs. */
export function applyTheme(theme: ThemePreference, host: ThemeHost): () => void {
  const set = (): void => {
    host.root.dataset.theme = resolveTheme(theme, host.darkMode.matches);
    const underlay = host.styleOf(host.root).getPropertyValue('--canvas-deep').trim();
    if (/^#[0-9a-f]{6}$/i.test(underlay)) host.themeColor?.setAttribute('content', underlay);
  };
  set();
  if (theme !== 'system') return () => undefined;
  host.darkMode.addEventListener('change', set);
  return () => host.darkMode.removeEventListener('change', set);
}
