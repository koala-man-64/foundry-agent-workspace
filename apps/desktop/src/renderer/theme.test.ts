import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyTheme, readTheme, resolveTheme, saveTheme, THEME_STORAGE_KEY, THEMES, type ThemeHost } from './theme';

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

  it('keeps the first-paint script on the same key, list and fallback', () => {
    const boot = readFileSync(join(__dirname, 'public', 'theme-boot.js'), 'utf8');
    expect(boot).toContain(`'${THEME_STORAGE_KEY}'`);
    expect(THEMES).toEqual(['system', 'light', 'dark']);
    expect(boot).toContain("stored === 'dark'");
    expect(boot).toContain("stored === 'system'");
    expect(boot).toContain("let theme = 'light'");
  });
});
