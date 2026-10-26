import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyStyle, applyTheme, readStyle, readTheme, resolveTheme, saveStyle, saveTheme, STYLE_STORAGE_KEY, STYLES, THEME_STORAGE_KEY, THEMES, type ThemeHost } from './theme';

function storage(values: Record<string, string> = {}, failing = false): Storage {
  const fail = () => { throw new Error('storage blocked'); };
  return { getItem: key => (failing ? fail() : values[key] ?? null), setItem: (key, value) => { if (failing) fail(); values[key] = value; } } as Storage;
}

function host(prefersDark: boolean, canvasDeep = '#141210') {
  const listeners = new Set<() => void>();
  const meta = { content: '#e8e2d4', setAttribute(name: string, value: string) { if (name === 'content') this.content = value; } };
  const darkMode = { matches: prefersDark, addEventListener: (_type: string, listener: () => void) => listeners.add(listener), removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener) };
  const value: ThemeHost = { root: { dataset: {} } as HTMLElement, themeColor: meta as unknown as HTMLMetaElement, darkMode: darkMode as unknown as ThemeHost['darkMode'], styleOf: () => ({ getPropertyValue: () => ` ${canvasDeep}` }) };
  return { value, meta, darkMode, listeners, flip(next: boolean) { darkMode.matches = next; for (const listener of listeners) listener(); } };
}

describe('theme preference', () => {
  it('reads only a value from the closed list and falls back to Light', () => {
    expect(readTheme(storage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe('dark');
    expect(readTheme(storage({ [THEME_STORAGE_KEY]: 'system' }))).toBe('system');
    for (const value of ['paper', 'DARK', '', 'dark; color: red', '<script>']) expect(readTheme(storage({ [THEME_STORAGE_KEY]: value }))).toBe('light');
    expect(readTheme(storage())).toBe('light');
    expect(readTheme(storage({}, true))).toBe('light');
    expect(readTheme(undefined)).toBe('light');
  });

  it('saves without throwing when storage is blocked', () => {
    const values: Record<string, string> = {};
    saveTheme('dark', storage(values));
    expect(values[THEME_STORAGE_KEY]).toBe('dark');
    expect(() => saveTheme('dark', storage({}, true))).not.toThrow();
  });

  it('resolves System from the Windows app mode only', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('sets data-theme and names the underlay for the window', () => {
    const page = host(false);
    applyTheme('dark', page.value);
    expect(page.value.root.dataset.theme).toBe('dark');
    expect(page.meta.content).toBe('#141210');
    expect(page.listeners.size).toBe(0);
  });

  it('follows the Windows app mode for System until stopped', () => {
    const page = host(false);
    const stop = applyTheme('system', page.value);
    expect(page.value.root.dataset.theme).toBe('light');
    page.flip(true);
    expect(page.value.root.dataset.theme).toBe('dark');
    stop();
    expect(page.listeners.size).toBe(0);
    page.flip(false);
    expect(page.value.root.dataset.theme).toBe('dark');
  });

  it('never writes a value that is not a plain hex colour to the underlay', () => {
    const page = host(false, 'red');
    applyTheme('light', page.value);
    expect(page.meta.content).toBe('#e8e2d4');
  });

});

describe('style preference', () => {
  it('reads only a value from the closed list and falls back to Comfortable', () => {
    expect(readStyle(storage({ [STYLE_STORAGE_KEY]: 'compact' }))).toBe('compact');
    for (const value of ['dense', 'COMPACT', '', 'compact; x', 'comfortable ']) expect(readStyle(storage({ [STYLE_STORAGE_KEY]: value }))).toBe('comfortable');
    expect(readStyle(storage())).toBe('comfortable');
    expect(readStyle(storage({}, true))).toBe('comfortable');
    expect(readStyle(undefined)).toBe('comfortable');
  });

  it('saves without throwing when storage is blocked, and sets data-style', () => {
    const values: Record<string, string> = {};
    saveStyle('compact', storage(values));
    expect(values[STYLE_STORAGE_KEY]).toBe('compact');
    expect(() => saveStyle('compact', storage({}, true))).not.toThrow();
    const root = { dataset: {} } as HTMLElement;
    applyStyle('compact', root);
    expect(root.dataset.style).toBe('compact');
    applyStyle('comfortable', root);
    expect(root.dataset.style).toBe('comfortable');
  });
});

describe('first-paint script', () => {
  const script = readFileSync(join(__dirname, 'public', 'theme-boot.js'), 'utf8');
  // Runs the real file against a stand-in window, as the page head does before the module bundle.
  function run(read: () => Storage, prefersDark: boolean): Record<string, string> {
    const root = { dataset: {} as Record<string, string> };
    const fakeWindow = Object.defineProperty({ matchMedia: (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && prefersDark }) }, 'localStorage', { get: read });
    runInNewContext(script, { window: fakeWindow, document: { documentElement: root } });
    return root.dataset;
  }
  const boot = (read: () => Storage, prefersDark: boolean) => run(read, prefersDark).theme;

  it('paints with the theme the app applies for every stored value, Windows mode and blocked storage', () => {
    const blocked = () => { throw new Error('storage blocked'); };
    for (const prefersDark of [false, true]) {
      for (const value of [...THEMES, 'paper', 'DARK', '', 'dark; color: red']) {
        const stored = storage({ [THEME_STORAGE_KEY]: value });
        expect(boot(() => stored, prefersDark), `${value}, Windows ${prefersDark ? 'dark' : 'light'}`).toBe(resolveTheme(readTheme(stored), prefersDark));
      }
      expect(boot(() => storage(), prefersDark)).toBe('light');
      expect(boot(() => storage({}, true), prefersDark)).toBe('light');
      expect(boot(blocked, prefersDark)).toBe('light');
    }
  });

  it('paints with the style the app applies for every stored value and blocked storage', () => {
    for (const value of [...STYLES, 'dense', 'COMPACT', '']) {
      const stored = storage({ [STYLE_STORAGE_KEY]: value });
      expect(run(() => stored, false).style, value).toBe(readStyle(stored));
    }
    expect(run(() => storage(), false).style).toBe('comfortable');
    expect(run(() => storage({}, true), false).style).toBe('comfortable');
    expect(run(() => { throw new Error('storage blocked'); }, false).style).toBe('comfortable');
    // The theme and the style are independent: one stored value never changes the other.
    expect(run(() => storage({ [THEME_STORAGE_KEY]: 'dark', [STYLE_STORAGE_KEY]: 'compact' }), false)).toMatchObject({ theme: 'dark', style: 'compact' });
  });
});
