import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEMES as PREFERENCES } from './theme';

// Every preset theme is a block of token values. This test reads the token block (Foundry Light) and every
// :root[data-theme="..."] block, resolves aliases, and checks each theme against the same pair table and meaning rules,
// so a new theme is tested by existing here. It replaces the light-only token checks the themes round prototyped.
const directory = __dirname;
const css = readFileSync(join(directory, 'styles.css'), 'utf8');
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
const rootBody = /:root\s*{([\s\S]*?)\n}/.exec(stripped)?.[1] ?? '';
const declarations = (body: string) => new Map([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
const ROOT = declarations(rootBody);
const THEME_BLOCKS = new Map([...stripped.matchAll(/:root\[data-theme="([\w-]+)"\]\s*{([^}]*)}/g)].map(match => [match[1]!, declarations(match[2]!)]));
const THEMES = ['light', ...THEME_BLOCKS.keys()];

function tokens(theme: string): Map<string, string> {
  return theme === 'light' ? ROOT : new Map([...ROOT, ...THEME_BLOCKS.get(theme)!]);
}
function resolve(values: Map<string, string>, name: string): string | undefined {
  let value = values.get(name);
  for (let hop = 0; hop < 8 && value; hop++) {
    const alias = /^var\(--([\w-]+)\)$/.exec(value);
    if (!alias) return value;
    value = values.get(alias[1]!);
  }
  return undefined;
}

// Colour maths: WCAG relative luminance and contrast, HSL hue, CIELAB and CIEDE2000.
const rgb = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
const linear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const luminance = (hex: string) => { const [r, g, b] = rgb(hex).map(linear) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: string, b: string) => { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (light + 0.05) / (dark + 0.05); };
function hue(hex: string): number {
  const [r, g, b] = rgb(hex); const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (delta === 0) return 0;
  const h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a: string, b: string) => { const gap = Math.abs(hue(a) - hue(b)) % 360; return Math.min(gap, 360 - gap); };
function lab(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map(linear) as [number, number, number];
  const xyz = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883];
  const [fx, fy, fz] = xyz.map(t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116) as [number, number, number];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const chroma = (hex: string) => { const [, a, b] = lab(hex); return Math.hypot(a, b); };
function deltaE2000(one: string, two: string): number {
  const [l1, a1, b1] = lab(one), [l2, a2, b2] = lab(two);
  const rad = Math.PI / 180, c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2), cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2, cp1 = Math.hypot(ap1, b1), cp2 = Math.hypot(ap2, b2);
  const hp = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const hp1 = hp(b1, ap1), hp2 = hp(b2, ap2);
  const dL = l2 - l1, dC = cp2 - cp1;
  let dh = hp2 - hp1; if (cp1 * cp2 === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * rad);
  const lBar = (l1 + l2) / 2, cpBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2; if (cp1 * cp2 !== 0) hBar = Math.abs(hp1 - hp2) > 180 ? (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2 : (hp1 + hp2) / 2;
  const t = 1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad) + 0.32 * Math.cos((3 * hBar + 6) * rad) - 0.2 * Math.cos((4 * hBar - 63) * rad);
  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2), sC = 1 + 0.045 * cpBar, sH = 1 + 0.015 * cpBar * t;
  const rT = -2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hBar - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / sL) ** 2 + (dC / sC) ** 2 + (dH / sH) ** 2 + rT * (dC / sC) * (dH / sH));
}

const PAGE = ['canvas', 'surface', 'surface-card', 'surface-sunken', 'surface-inspector', 'surface-well'];
const RAIL3 = ['rail', 'rail-raised', 'rail-hover'];
const RAIL4 = [...RAIL3, 'rail-selected'];
// The needs-decision Inbox row: the one tinted, boxed rail row.
const NEEDS_ROW = 'rail-needs-bg';
type Pair = readonly [foreground: string, backgrounds: readonly string[], minimum: number, kind: 'text' | 'ui'];
// WCAG 1.4.3 text at 4.5:1 and 1.4.11 boundaries, rings and marks at 3:1, on every surface each token is drawn on.
const PAIRS: readonly Pair[] = [
  ['ink', [...PAGE, 'surface-hover', 'select-soft', 'warn-soft', 'notice-error-bg', 'ok-soft', 'choice-soft', 'patch-add-bg', 'patch-del-bg'], 4.5, 'text'],
  ['ink-2', [...PAGE, 'surface-hover', 'notice-warning-bg'], 4.5, 'text'],
  ['ink-muted', [...PAGE, 'notice-error-bg', 'warn-soft', 'choice-soft', 'browser-ground'], 4.5, 'text'],
  ['ink-eyebrow', PAGE, 4.5, 'text'],
  ['ink-content', ['surface', 'surface-inspector', 'browser-tab-bg', 'patch-add-bg', 'patch-del-bg'], 4.5, 'text'],
  ['warn-ink', [...PAGE, 'warn-soft', 'notice-warning-bg'], 4.5, 'text'],
  ['needs-you-ink', [...PAGE, 'needs-you-soft', 'needs-you-soft-hover'], 4.5, 'text'],
  ['needs-you-banner-ink', ['needs-you-banner-bg'], 4.5, 'text'],
  ['danger-ink', [...PAGE, 'danger-soft', 'notice-error-bg'], 4.5, 'text'],
  ['danger-ink-strong', ['danger-soft'], 4.5, 'text'],
  ['ok-ink', [...PAGE, 'ok-soft'], 4.5, 'text'],
  ['brand-ink', PAGE, 4.5, 'text'],
  ['placeholder', ['surface'], 4.5, 'text'],
  ['placeholder-disabled', ['surface-disabled'], 4.5, 'text'],
  ['selection-ink', ['selection-bg'], 4.5, 'text'],
  ['on-accent', ['accent', 'accent-hover'], 4.5, 'text'],
  ['on-danger', ['danger', 'danger-hover'], 4.5, 'text'],
  ['on-brand', ['brand', 'brand-fill', 'brand-quiet'], 4.5, 'text'],
  ['upgrade-banner-ink', ['upgrade-banner-bg'], 4.5, 'text'],
  ['secondary-ink', ['secondary-bg', 'secondary-bg-hover'], 4.5, 'text'],
  ['notice-error-ink', ['notice-error-bg', 'surface-inspector'], 4.5, 'text'],
  ['notice-warning-ink', ['notice-warning-bg'], 4.5, 'text'],
  ['notice-success-ink', ['notice-success-bg'], 4.5, 'text'],
  ['mark-ink', ['mark-bg'], 4.5, 'text'],
  ['bubble-ink', ['bubble-bg'], 4.5, 'text'],
  ['bubble-compacted-ink', ['bubble-compacted-bg'], 4.5, 'text'],
  ['graph-ink', ['graph-done', 'graph-failed', 'graph-open'], 4.5, 'text'],
  ['graph-ink-2', ['graph-done', 'graph-failed', 'graph-open'], 4.5, 'text'],
  ['rail-ink', RAIL3, 4.5, 'text'],
  ['rail-ink-strong', ['rail-hover', 'rail-selected', 'rail-raised'], 4.5, 'text'],
  ['rail-ink-bright', ['rail', 'rail-hover', 'rail-plus-bg', 'rail-popover', 'rail-popover-hover'], 4.5, 'text'],
  ['rail-ink-list', [...RAIL4, NEEDS_ROW], 4.5, 'text'],
  ['rail-ink-warm', ['rail', 'rail-hover'], 4.5, 'text'],
  ['rail-ink-icon', ['rail', 'rail-hover'], 4.5, 'text'],
  ['rail-ink-glyph', ['rail', 'rail-hover'], 4.5, 'text'],
  ['rail-ink-2', RAIL4, 4.5, 'text'],
  ['rail-muted', RAIL3, 4.5, 'text'],
  ['rail-faint', RAIL3, 4.5, 'text'],
  ['rail-ink-meta', ['rail-raised', 'rail-hover', NEEDS_ROW], 4.5, 'text'],
  ['rail-ink-meta-2', RAIL4, 4.5, 'text'],
  ['rail-accent', [...RAIL3, NEEDS_ROW], 4.5, 'text'],
  ['rail-warn-ink', ['rail', 'rail-hover'], 4.5, 'text'],
  ['rail-button-ink', ['rail-button-bg'], 4.5, 'text'],
  ['rail-error-ink', ['rail-error-bg'], 4.5, 'text'],
  ['line-strong', ['canvas', 'surface', 'surface-card', 'surface-inspector'], 3, 'ui'],
  ['focus', PAGE.filter(surface => surface !== 'surface-well'), 3, 'ui'],
  ['select', [...PAGE, 'select-soft'], 3, 'ui'],
  ['accent', PAGE, 3, 'ui'],
  ['danger', PAGE, 3, 'ui'],
  // The complete badge's ring: on cards, panels and the tray, never on an evidence well.
  ['ok', PAGE.filter(surface => surface !== 'surface-well'), 3, 'ui'],
  ['choice', PAGE, 3, 'ui'],
  ['needs-you-line', ['canvas', 'surface', 'surface-card', 'surface-sunken', 'surface-inspector'], 3, 'ui'],
  ['secondary-ring', PAGE, 3, 'ui'],
  ['rail-focus', [...RAIL4, NEEDS_ROW, 'rail-error-bg', 'rail-button-bg', 'rail-popover', 'rail-popover-hover'], 3, 'ui'],
  ['rail-accent', RAIL4, 3, 'ui'],
  ['rail-accent-line', [...RAIL3, NEEDS_ROW], 3, 'ui'],
  ['rail-select-mark', RAIL4, 3, 'ui'],
  ['rail-line-control', RAIL3, 3, 'ui'],
  ['rail-warn', ['rail', 'rail-hover'], 3, 'ui'],
  ['rail-dot', RAIL4, 3, 'ui'],
  ['rail-dot-running', RAIL4, 3, 'ui'],
  ['rail-dot-failed', RAIL4, 3, 'ui'],
  ['rail-dot-cancelled', RAIL4, 3, 'ui'],
  ['viz-reported', ['surface', 'surface-card', 'surface-inspector'], 3, 'ui'],
  ['viz-unknown', ['surface', 'surface-card', 'surface-inspector'], 3, 'ui'],
  ['viz-unsent', ['surface', 'surface-card', 'surface-inspector'], 3, 'ui'],
  ['viz-axis', ['surface', 'surface-card', 'surface-inspector'], 3, 'ui'],
  ['graph-line', ['surface-inspector'], 3, 'ui'],
  ['patch-add-bar', ['patch-add-bg'], 3, 'ui'],
  ['patch-del-bar', ['patch-del-bg'], 3, 'ui'],
];
// High contrast: body inks at 7:1, every other text and every UI pair at 4.5:1.
const STRICT_THEMES = new Set(['contrast']);
const BODY_INKS = new Set(['ink', 'ink-2', 'ink-content', 'rail-ink', 'rail-ink-strong', 'rail-ink-list']);
// High contrast carries its structure in borders rather than tints, so card, panel and popup borders are boundaries there.
// Light and Dark separate those regions by tone, so these rows apply to strict themes only.
const STRICT_PAIRS: readonly Pair[] = [
  ['line', PAGE, 4.5, 'ui'],
  ['line-panel', PAGE, 4.5, 'ui'],
  ['line-popup', ['surface', 'surface-card'], 4.5, 'ui'],
];
// Meanings told apart by hue (when both are chromatic) and by colour distance.
const DISTINCT = [['accent', 'danger'], ['needs-you-ink', 'warn-ink'], ['needs-you-ink', 'danger-ink']] as const;
const NEEDS_YOU_FAMILY = ['accent', 'needs-you-ink', 'needs-you-line', 'rail-accent'];
// Owner decisions recorded instead of failing: Light's secondary buttons keep no drawn edge (a labelled button needs none
// under WCAG 1.4.11; outlining them is a look decision). A transparent ring anywhere else fails.
const PENDING_DECISIONS = [{ theme: 'light', token: 'secondary-ring' }];
const HEX6 = /^#[0-9a-f]{6}$/i;
// A literal a theme must restate: opaque or translucent hex, transparent, or a colour scheme. Aliases follow the theme.
const COLOUR_LITERAL = /^(?:#[0-9a-f]{6}(?:[0-9a-f]{2})?|transparent|light|dark)$/i;

describe.each(THEMES)('theme %s', theme => {
  const values = tokens(theme);
  const colour = (name: string) => resolve(values, name);

  it('sets every token that Foundry Light defines as a literal colour or scheme', () => {
    if (theme === 'light') return;
    const own = THEME_BLOCKS.get(theme)!;
    const missing = [...ROOT].filter(([name, value]) => COLOUR_LITERAL.test(value) && !own.has(name)).map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('meets every contrast pair', () => {
    const failures: string[] = [];
    for (const [foreground, backgrounds, minimum, kind] of STRICT_THEMES.has(theme) ? [...PAIRS, ...STRICT_PAIRS] : PAIRS) {
      const ink = colour(foreground);
      if (ink === 'transparent' && PENDING_DECISIONS.some(decision => decision.theme === theme && decision.token === foreground)) continue;
      const required = STRICT_THEMES.has(theme) ? (kind === 'text' && BODY_INKS.has(foreground) ? 7 : 4.5) : minimum;
      for (const background of backgrounds) {
        const ground = colour(background);
        if (!ink || !ground || !HEX6.test(ink) || !HEX6.test(ground)) { failures.push(`--${foreground} on --${background}: not an opaque colour (${ink} on ${ground})`); continue; }
        const ratio = contrast(ink, ground);
        if (ratio < required) failures.push(`--${foreground} on --${background}: ${ratio.toFixed(2)} < ${required}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('tells needs-you, danger and warning apart by hue and by colour distance', () => {
    const failures = DISTINCT.flatMap(([one, two]) => {
      const a = colour(one)!, b = colour(two)!;
      const chromatic = chroma(a) >= 8 && chroma(b) >= 8;
      const gap = hueGap(a, b), distance = deltaE2000(a, b);
      return (chromatic && gap < 18) || distance < 15 ? [`--${one} ${a} / --${two} ${b}: ${gap.toFixed(0)} degrees, delta-E ${distance.toFixed(1)}`] : [];
    });
    expect(failures).toEqual([]);
  });

  it('keeps the focus rings and the rail selection out of the needs-you family', () => {
    const failures = ['focus', 'rail-focus', 'rail-select-mark', 'choice'].flatMap(ring => NEEDS_YOU_FAMILY.flatMap(member => {
      const a = colour(ring)!, b = colour(member)!;
      return chroma(a) >= 8 && chroma(b) >= 8 && hueGap(a, b) < 25 ? [`--${ring} ${a} is ${hueGap(a, b).toFixed(0)} degrees from --${member} ${b}`] : [];
    }));
    expect(failures).toEqual([]);
  });

  it('names a colour scheme that matches its canvas and keeps the rail distinct', () => {
    const canvas = colour('canvas')!;
    expect(colour('color-scheme')).toBe(luminance(canvas) < 0.2 ? 'dark' : 'light');
    expect(contrast(colour('rail')!, canvas) >= 1.3 || contrast(colour('rail-edge')!, canvas) >= 1.5).toBe(true);
  });

  it('draws the Chromium Retry button in the scheme of its rail error box', () => {
    expect(colour('rail-error-scheme')).toBe(luminance(colour('rail-error-bg')!) < 0.2 ? 'dark' : 'light');
  });
});

describe('theme stylesheet', () => {
  it('has a block for every theme the settings offer, and offers every block', () => {
    expect(PREFERENCES.filter(preference => preference !== 'system').sort()).toEqual([...THEMES].sort());
  });

  it('draws no colour literal outside the token block and the Windows contrast block', () => {
    const rules = stripped.slice(stripped.indexOf(rootBody) + rootBody.length).replace(/@media \(forced-colors: active\)\s*{[\s\S]*?\n}/, '').replace(/:root\[data-theme="[\w-]+"\]\s*{[^}]*}/g, '');
    expect(rules.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi) ?? []).toEqual([]);
    const COLOUR_PROPERTY = /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-decoration(?:-color)?|caret-color|accent-color|scrollbar-color)$/;
    const NAMED = /\b(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|navy|teal|maroon|olive|lime|aqua|fuchsia|gold|beige|tan|crimson|salmon|ivory)\b/i;
    const named = [...rules.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)].filter(match => COLOUR_PROPERTY.test(match[1]!) && NAMED.test(match[2]!)).map(match => match[0].trim());
    expect(named).toEqual([]);
  });

  it('keeps the Windows contrast block last and lets only the status dots opt out of it', () => {
    expect(stripped.trimEnd().endsWith('}') && /@media \(forced-colors: active\)\s*{[\s\S]*}\s*$/.test(stripped)).toBe(true);
    expect(stripped.slice(stripped.lastIndexOf('@media (forced-colors: active)') + 1)).not.toContain('@media');
    expect([...stripped.matchAll(/([^{}]+)\{[^}]*forced-color-adjust:\s*none/g)].map(match => match[1]!.trim())).toEqual(['.status-dot']);
  });

  it('gives the window, the page and Foundry Light one underlay colour', async () => {
    const { DEFAULT_UNDERLAY } = await import('../main/window-underlay');
    const meta = /<meta name="theme-color" content="(#[0-9a-f]{6})"/i.exec(readFileSync(join(directory, 'index.html'), 'utf8'))?.[1];
    expect([DEFAULT_UNDERLAY, meta]).toEqual([ROOT.get('canvas-deep'), ROOT.get('canvas-deep')]);
  });

  it('wraps every theme block in forced-colors: none so Windows contrast themes keep winning', () => {
    const unwrapped = [...stripped.matchAll(/(.{0,40}):root\[data-theme="([\w-]+)"\]/gs)].filter(match => !/@media \(forced-colors: none\)\s*{\s*$/.test(match[1]!)).map(match => match[2]);
    expect(unwrapped).toEqual([]);
  });

  it('leaves colour to the stylesheet in every component', () => {
    const offenders = readdirSync(directory).filter(file => file.endsWith('.tsx')).flatMap(file => {
      const source = readFileSync(join(directory, file), 'utf8');
      return [...source.matchAll(/\b(fill|stroke|color|background)=["{]['"]?#[0-9a-f]{3,8}/gi)].map(match => `${file}: ${match[0]}`);
    });
    expect(offenders).toEqual([]);
  });
});
