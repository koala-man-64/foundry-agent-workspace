import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STYLES } from './theme';

const directory = __dirname;
const css = readFileSync(join(directory, 'styles.css'), 'utf8');
const rootBlock = /:root\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? '';
const tokens = new Map([...rootBlock.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(match => [match[1]!, match[2]!.toLowerCase()]));

function token(name: string): string {
  const value = tokens.get(name);
  if (!value) throw new Error(`Missing colour token --${name}`);
  return value;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

function failures(foregrounds: string[], backgrounds: string[], minimum: number): string[] {
  return foregrounds.flatMap(foreground => backgrounds
    .filter(background => contrast(token(foreground), token(background)) < minimum)
    .map(background => `--${foreground} on --${background}: ${contrast(token(foreground), token(background)).toFixed(2)}`));
}

const LIGHT_SURFACES = ['canvas', 'surface', 'surface-card', 'surface-sunken', 'surface-inspector', 'surface-well'];
const RAIL_SURFACES = ['rail', 'rail-raised', 'rail-hover'];

describe('design tokens', () => {
  it('keeps every light-surface text token at WCAG AA (4.5:1) on every light surface', () => {
    expect(failures(['ink', 'ink-2', 'ink-muted', 'ink-eyebrow', 'warn-ink', 'danger-ink', 'ok-ink', 'brand-ink'], LIGHT_SURFACES, 4.5)).toEqual([]);
  });

  it('keeps button and filled-surface text at AA', () => {
    expect(failures(['ink-inverse'], ['accent', 'accent-hover', 'danger', 'brand', 'brand-ink'], 4.5)).toEqual([]);
    expect(failures(['secondary-ink'], ['secondary-bg', 'secondary-bg-hover'], 4.5)).toEqual([]);
    expect(failures(['notice-error-ink'], ['notice-error-bg'], 4.5)).toEqual([]);
    expect(failures(['notice-warning-ink'], ['notice-warning-bg'], 4.5)).toEqual([]);
    expect(failures(['notice-success-ink'], ['notice-success-bg'], 4.5)).toEqual([]);
    expect(failures(['danger-ink'], ['danger-soft', 'accent-soft'], 4.5)).toEqual([]);
    expect(failures(['ok-ink'], ['ok-soft'], 4.5)).toEqual([]);
    expect(failures(['ink'], ['select-soft'], 4.5)).toEqual([]);
    expect(failures(['warn-ink'], ['warn-soft'], 4.5)).toEqual([]);
  });

  it('keeps rail text at AA on the rail surfaces it is drawn on', () => {
    expect(failures(['rail-ink', 'rail-ink-2', 'rail-muted', 'rail-faint'], RAIL_SURFACES, 4.5)).toEqual([]);
    expect(failures(['rail-ink', 'rail-ink-2'], ['rail-selected'], 4.5)).toEqual([]);
  });

  it('keeps control boundaries, focus rings and chart marks at 3:1 (WCAG 1.4.11)', () => {
    expect(failures(['line-strong'], ['canvas', 'surface', 'surface-card', 'surface-inspector'], 3)).toEqual([]);
    expect(failures(['focus'], LIGHT_SURFACES.filter(surface => surface !== 'surface-well'), 3)).toEqual([]);
    expect(failures(['select', 'accent', 'danger'], LIGHT_SURFACES, 3)).toEqual([]);
    expect(failures(['select'], ['select-soft'], 3)).toEqual([]);
    expect(failures(['rail-focus'], [...RAIL_SURFACES, 'rail-selected'], 3)).toEqual([]);
    expect(failures(['viz-reported', 'viz-unknown', 'viz-unsent', 'viz-axis'], ['surface', 'surface-card', 'surface-inspector'], 3)).toEqual([]);
  });

  it('uses two weights, 400 and 600, and only the rail glyphs draw lighter', () => {
    const plain = uncommented(css);
    const weights = [...plain.matchAll(/([^{}]+)\{([^}]*)\}/g)].flatMap(([, selector, body]) => [...body!.matchAll(/font-weight:\s*([^;}]+?)\s*(?:;|$)|font:\s*(\d{3}|bold|bolder|lighter)\s/g)]
      .map(match => [selector!.trim(), (match[1] ?? match[2])!.trim()] as const));
    expect(weights.length).toBeGreaterThan(40);
    expect(weights.filter(([selector, weight]) => !['400', '600', 'normal'].includes(weight) && !(weight === '300' && ['.sidebar-plus', '.icon-button'].includes(selector)))).toEqual([]);
  });

  it('writes labels in sentence case: no capitals-and-tracking labels', () => {
    const plain = uncommented(css);
    expect([...plain.matchAll(/([^{}]+)\{[^}]*text-transform:\s*uppercase/g)].map(match => match[1]!.trim())).toEqual(['.approval-heading > span::first-letter']);
    expect([...plain.matchAll(/letter-spacing:\s*([^;}]+)/g)].map(match => match[1]!.trim()).filter(value => !['0', 'normal'].includes(value))).toEqual([]);
    // The browser's own bold (headings) takes the second weight too.
    expect(/(?:^|\})\s*h1, h2 \{[^}]*font-weight: 600;/.test(plain)).toBe(true);
  });

  it('sets evidence text at 12px and 1.4 in Comfortable, in every evidence rule', () => {
    expect([px('fs-evidence'), rootTokens.get('lh-evidence')]).toEqual([12, '1.4']);
    const plain = uncommented(css);
    for (const selector of ['.file-content pre, .patch pre', '.approval-card pre', '.command-evidence small, .approval-result small',
      '.assignment-card pre, .orchestration-evidence pre, .assignment-summary pre, .activity-timeline pre', '.request-chart table']) {
      const start = plain.indexOf(`\n${selector} {`);
      const body = start < 0 ? '' : plain.slice(start, plain.indexOf('}', start));
      expect(body.includes('var(--fs-evidence)') && body.includes('var(--lh-evidence)'), selector).toBe(true);
    }
  });

  it('uses no font size below the 11px floor', () => {
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
    expect(sizes.filter(size => size < 11)).toEqual([]);
  });
});

// The size and spacing roles are the style axis: a style may set their values, so the floors are checked on the values.
const uncommented = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const sizeBlock = uncommented(rootBlock.slice(rootBlock.indexOf('Size and spacing roles'), rootBlock.indexOf('/* Light surfaces */')));
const sizeTokens = new Map([...sizeBlock.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
const rootTokens = new Map([...uncommented(rootBlock).matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
/** A token's value in px when it is one px length, following var() aliases. */
function px(name: string): number | undefined {
  let value = rootTokens.get(name);
  for (let hop = 0; hop < 8 && value; hop++) {
    const alias = /^var\(--([\w-]+)\)$/.exec(value);
    if (!alias) return /^\d+(\.\d+)?px$/.test(value) ? Number.parseFloat(value) : undefined;
    value = rootTokens.get(alias[1]!);
  }
  return undefined;
}

/** A token's value with var() aliases followed, or undefined. */
const follow = (map: Map<string, string>, value: string | undefined) => {
  for (let hop = 0; hop < 8 && value; hop++) { const alias = /^var\(--([\w-]+)\)$/.exec(value.trim()); if (!alias) return value.trim(); value = map.get(alias[1]!); }
  return value?.trim();
};
/** A role's px lengths and unitless numbers, a one- to four-value shorthand expanded to its four sides; undefined where a part is not one. */
const lengths = (map: Map<string, string>, value: string | undefined) => {
  const parts = (follow(map, value)?.match(/var\(--[\w-]+\)|\S+/g) ?? []).map(part => {
    const resolved = follow(map, part);
    // px lengths, and unitless numbers (line heights); a bare zero counts as 0.
    return resolved && /^-?\d+(\.\d+)?(px)?$/.test(resolved) ? Number.parseFloat(resolved) : undefined;
  });
  // A one- to four-value shorthand, expanded to its four sides (or a gap's two axes, twice).
  const [a, b = a, c = a, d = b] = parts;
  return parts.length >= 1 && parts.length <= 4 ? [a, b, c, d] : parts;
};

// Style blocks (:root[data-style="..."]): token values only, set on the size roles.
const styleBlocks = new Map([...uncommented(css).matchAll(/:root\[data-style="([\w-]+)"\]\s*{([^}]*)}/g)].map(match => [match[1]!, new Map([...match[2]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(declaration => [declaration[1]!, declaration[2]!.trim()]))]));
// Fixed heights held at the 24px floor. --h-dense is exempt: dense rows clamp it with max(var(--target-min), var(--h-dense)).
const FIXED_HEIGHTS = /^h-(ctl|view|chrome|decision|composer|compose-text|browser-tabs)\b/;
// Rows whose height comes from padding: each is clamped to the pointer-target floor, so a style can shrink the padding only.
const DENSE_ROWS = ['.sidebar-new', '.project-toggle', '.task-row', '.sidebar-footer button', '.sidebar-usage button', '.file-tree button', '.agent-row'];

describe('size tokens', () => {
  it('finds the size block, so the checks below cannot pass on nothing', () => {
    expect(rootBlock.indexOf('Size and spacing roles')).toBeGreaterThanOrEqual(0);
    expect(rootBlock.indexOf('/* Light surfaces */')).toBeGreaterThan(rootBlock.indexOf('Size and spacing roles'));
    expect(sizeTokens.size).toBeGreaterThan(150);
  });

  it('holds the 24px pointer-target floor on every fixed control height and on dense rows', () => {
    expect(rootTokens.get('target-min')).toBe('24px');
    const heights = [...rootTokens.keys()].filter(name => FIXED_HEIGHTS.test(name)).map(name => [name, px(name)] as const);
    expect(heights.length).toBeGreaterThanOrEqual(8);
    expect(heights.filter(([, value]) => value === undefined || value < 24)).toEqual([]);
    const clamped = [...uncommented(css).matchAll(/([^{}]+)\{[^{}]*min-height:\s*max\(var\(--target-min\), var\(--h-dense\)\)/g)].map(match => match[1]!.replace(/\s+/g, ' ').trim());
    expect(clamped.sort()).toEqual([...DENSE_ROWS].sort());
  });

  it('keeps Approve and Reject at their own size and the approval fields stacked by default', () => {
    // The general button padding moved onto the ladder; the decision buttons keep 78x34 instead of following it.
    expect(rootTokens.get('pad-decision')).toBe('9px 13px');
    // Approve and Reject keep a 32px minimum above the 28px general controls.
    expect([px('h-decision'), px('h-ctl')]).toEqual([32, 28]);
    expect([rootTokens.get('field-layout'), rootTokens.get('field-columns'), rootTokens.get('field-col-gap')]).toEqual(['block', 'none', 'normal']);
  });

  it('keeps every style block to size token values, at the floors, outside forced-colors: none', () => {
    expect(STYLES.filter(style => style !== 'comfortable').sort()).toEqual([...styleBlocks.keys()].sort());
    // Every [data-style] in the stylesheet opens one of those blocks at the top level: no selector rule or duplicate block on
    // a style, and no wrapper (forced-colors: none, @media, @supports) that could switch a style off.
    const plain = uncommented(css);
    const uses = [...plain.matchAll(/\[data-style\b/g)].map(match => match.index!);
    const depth = (index: number) => (plain.slice(0, index).match(/{/g) ?? []).length - (plain.slice(0, index).match(/}/g) ?? []).length;
    expect(uses.length).toBe(styleBlocks.size);
    expect(uses.map(depth), 'style blocks at the top level').toEqual(uses.map(() => 0));
    for (const [style, block] of styleBlocks) {
      const values = new Map([...rootTokens, ...block]);
      const resolved = (name: string) => {
        let value = values.get(name);
        for (let hop = 0; hop < 8 && value; hop++) { const alias = /^var\(--([\w-]+)\)$/.exec(value); if (!alias) break; value = values.get(alias[1]!); }
        return value;
      };
      const size = (name: string) => { const value = resolved(name); return value && /^\d+(\.\d+)?px$/.test(value) ? Number.parseFloat(value) : undefined; };
      expect([...block.keys()].filter(name => !sizeTokens.has(name)), `${style}: names outside the size roles`).toEqual([]);
      expect([...block.keys()].filter(name => name === 'target-min' || name.startsWith('space-')), `${style}: floors and the ladder`).toEqual([]);
      expect([...block].filter(([, value]) => /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|color)\(/i.test(value)), `${style}: colours`).toEqual([]);
      const heights = [...values.keys()].filter(name => FIXED_HEIGHTS.test(name)).filter(name => (size(name) ?? 0) < 24);
      expect(heights, `${style}: control heights under 24px`).toEqual([]);
      const type = [...values.keys()].filter(name => name.startsWith('fs-')).filter(name => (size(name) ?? 0) < 11);
      expect(type, `${style}: type roles under 11px`).toEqual([]);
      expect([size('fs-prose')! >= 14, size('fs-evidence')! >= 12, Number(resolved('lh-evidence')) >= 1.35], `${style}: prose 14px, evidence 12px at 1.35 or more`).toEqual([true, true, true]);
      // In a narrow approval list a label column would break paths, commands and hashes mid-token.
      expect(resolved('field-layout-narrow'), `${style}: narrow approval fields`).toBe('block');
    }
  });

  it('keeps Compact the denser style: no size role larger than Comfortable, apart from named widths', () => {
    // Compared component by component wherever both values are px lengths or unitless numbers (shorthands expanded).
    const ALLOWED = new Map([
      ['h-dense', 'Comfortable sizes dense rows by their padding (0px means no minimum); Compact pins them at 26px'],
      ['measure-focus', 'a width: the Focus column fits more per line'],
      ['pad-decision', 'Approve and Reject are shorter in Compact, with 1px more inline padding'],
    ]);
    const compact = styleBlocks.get('compact')!;
    const values = new Map([...rootTokens, ...compact]);
    const compared: string[] = [], skipped: string[] = [], looser: string[] = [];
    for (const name of compact.keys()) {
      const comfortable = lengths(rootTokens, rootTokens.get(name)), dense = lengths(values, compact.get(name));
      if (comfortable.some(part => part === undefined) || dense.some(part => part === undefined) || comfortable.length !== dense.length) { skipped.push(name); continue; }
      compared.push(name);
      if (!ALLOWED.has(name) && dense.some((part, index) => part! > comfortable[index]!)) looser.push(name);
    }
    expect(looser).toEqual([]);
    expect(compared.length).toBeGreaterThanOrEqual(140);
    // Only roles that are not px lengths are skipped: percentages, viewport and character units, keywords and grid templates.
    const NOT_LENGTH = /%|vh|vw|ch\b|rem|\bnone\b|\bauto\b|\bblock\b|\bgrid\b|\bnormal\b|minmax|calc\(|clamp\(|max\(|min\(|fr\b|^\d+(\.\d+)?$/;
    expect(skipped.filter(name => !NOT_LENGTH.test(`${follow(rootTokens, rootTokens.get(name))} ${follow(values, compact.get(name))}`))).toEqual([]);
    // The exceptions are still real: Compact is larger there, so a stale entry cannot hide a future inversion.
    expect([...ALLOWED.keys()].filter(name => {
      const comfortable = lengths(rootTokens, rootTokens.get(name)), dense = lengths(values, compact.get(name));
      return dense.some((part, index) => part !== undefined && comfortable[index] !== undefined && part > comfortable[index]!);
    })).toEqual([...ALLOWED.keys()]);
  });

  it('lays the task header out as rows of its own children, with the short-window roles only in their query', () => {
    const plain = uncommented(css);
    for (const [selector, declarations] of [['.task-header > .eyebrow', 'order: 1; flex: 0 0 100%;'], ['.task-header h1', 'order: 2;'], ['.task-header > .header-actions', 'order: 3;'], ['.task-header > .task-status', 'order: 4; flex: 0 0 100%;']] as const) {
      const start = plain.indexOf(`\n${selector} {`);
      expect(start >= 0 && plain.slice(start, plain.indexOf('}', start)).includes(declarations), selector).toBe(true);
    }
    expect(/@container task-header \(max-width: 640px\)\s*{\s*\.task-header > \.header-actions \{ order: 5; \}/.test(plain)).toBe(true);
    // Every 760px query: the header and composer first, then the stacked tray.
    const short = [...plain.matchAll(/@media \(max-height: 760px\)\s*{([\s\S]*?)\n}/g)].map(match => match[1]!).join('\n');
    const outside = plain.replace(/@media \(max-height: 760px\)\s*{[\s\S]*?\n}/g, '').replace(/:root[^{]*{[^}]*}/g, '');
    for (const name of ['header-pad-top-short', 'header-pad-bottom-short', 'fs-title-short', 'pad-composer-y-short', 'h-composer-short']) {
      expect(short.includes(`var(--${name})`) && !outside.includes(`var(--${name})`), name).toBe(true);
    }
  });

  it('reads a short-window role only inside a max-height query, never above its base in any style, and never sets a role there', () => {
    const plain = uncommented(css);
    const blocks = [...plain.matchAll(/@media \(max-height: \d+px\)\s*{([\s\S]*?)\n}/g)].map(match => match[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    // A query reads roles. A role set inside it would beat the value a style gave that role.
    expect(blocks.filter(block => /--[\w-]+\s*:/.test(block))).toEqual([]);
    const inside = blocks.join('\n');
    const outside = plain.replace(/@media \(max-height: \d+px\)\s*{[\s\S]*?\n}/g, '').replace(/:root[^{]*{[^}]*}/g, '');
    const shortRoles = [...rootTokens.keys()].filter(name => name.endsWith('-short'));
    expect(shortRoles.length).toBeGreaterThanOrEqual(14);
    expect(shortRoles.filter(name => !inside.includes(`var(--${name})`) || outside.includes(`var(--${name})`))).toEqual([]);
    // Entering the short tier never enlarges a role, in Comfortable or in a style.
    for (const [style, block] of [['comfortable', new Map<string, string>()], ...styleBlocks] as const) {
      const values = new Map([...rootTokens, ...block]);
      const grew = shortRoles.filter(name => {
        const base = name.slice(0, -'-short'.length), short = lengths(values, values.get(name)), full = lengths(values, values.get(base));
        return values.has(base) && short.length === full.length && !short.concat(full).includes(undefined) && short.some((part, index) => part! > full[index]!);
      });
      expect(grew, `${style}: short roles above their base`).toEqual([]);
    }
    // The decision buttons, the evidence text and a card's padding are never tightened.
    expect(inside).not.toMatch(/h-decision|pad-decision|fs-evidence|lh-evidence|pad-card|pad-evidence/);
  });

  it('sizes the Focus column and the transcript floor, and gives the transcript no claim on the tray by its length', () => {
    const plain = uncommented(css);
    expect([px('measure-focus'), px('h-focus-messages-min'), px('h-focus-messages-min-short'), rootTokens.get('h-tray-max')]).toEqual([1100, 92, 84, '70vh']);
    // Compact is the denser style: a wider Focus column (a named exception to the ordering above), a lower floor and a tray cap no
    // taller (a vh value, which the ordering test cannot compare).
    const compact = styleBlocks.get('compact')!;
    expect([compact.get('measure-focus'), compact.get('h-focus-messages-min'), compact.get('h-focus-messages-min-short')]).toEqual(['1180px', '72px', '64px']);
    expect(Number.parseFloat(compact.get('h-tray-max')!)).toBeLessThanOrEqual(Number.parseFloat(rootTokens.get('h-tray-max')!));
    // A flex basis of 0: sized by its content, a long transcript would shrink the tray in proportion to its length.
    // The coordinator's transcript, inside its detail, too.
    expect(plain).toContain('\n.workspace[data-focus="on"] > .conversation > .messages, .workspace[data-focus="on"] .coordinator-detail > .messages { flex-basis: 0; min-height: var(--h-focus-messages-min); }');
  });

  it('puts the Focus tray beside the transcript from 1180px by a data attribute, in grid areas that keep the DOM order', () => {
    const plain = uncommented(css);
    expect(plain).not.toMatch(/:has\(\s*>\s*\.approval-tray/);
    const start = plain.indexOf('@media (min-width: 1180px) {\n  .workspace[data-focus="on"] > .conversation[data-tray="conversation"] {');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = plain.slice(start, plain.indexOf('\n}', start));
    expect(block).toContain('grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);');
    // The banner has a full row of its own, so the visual order is the DOM order.
    expect(block).toContain('grid-template-areas: "head head" "notice notice" "msgs tray" "older tray" "banner banner" "composer composer";');
    for (const [part, area] of [['task-header', 'head'], ['notice', 'notice'], ['messages', 'msgs'], ['older-messages', 'older'], ['approval-tray', 'tray'], ['approval-banner', 'banner'], ['composer', 'composer']] as const) {
      expect(block, part).toMatch(new RegExp(`\\[data-tray="conversation"\\] > \\.${part} \\{[^}]*grid-area: ${area};`));
    }
    expect(block).toMatch(/\[data-tray="conversation"\] > \.approval-tray \{[^}]*max-height: none;[^}]*border-left: 1px solid var\(--line-soft\);/);
    // The coordinated view: the coordinator detail is the grid, with the same order.
    expect(block).toMatch(/\[data-tray="detail"\] > \.agent-detail\.coordinator-detail \{[^}]*display: grid;[^}]*grid-template-areas: "msgs tray" "older tray" "banner banner" "composer composer";[^}]*padding-inline: 0;/);
    for (const [part, area] of [['messages', 'msgs'], ['older-messages', 'older'], ['approval-tray', 'tray'], ['approval-banner', 'banner'], ['composer', 'composer']] as const) {
      expect(block, `coordinator ${part}`).toMatch(new RegExp(`\\[data-tray="detail"\\] > \\.coordinator-detail > \\.${part} \\{[^}]*grid-area: ${area};`));
    }
    // Placement only: nothing reorders, hides or colours.
    expect(block).not.toMatch(/\border\s*:/);
    expect(block).not.toMatch(/display:\s*none/);
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(/i);
    expect(start).toBeLessThan(plain.lastIndexOf('@media (forced-colors: active)'));
  });

  it('hangs the transcript author and time in a column only from a 620px transcript, measured on the transcript itself', () => {
    const plain = uncommented(css);
    expect(/\n\.messages \{[^}]*container: transcript \/ inline-size;/.test(plain)).toBe(true);
    const wide = /@container transcript \(min-width: 620px\)\s*{([\s\S]*?)\n}/.exec(plain)?.[1] ?? '';
    expect(wide).toContain('grid-template-columns: var(--meta-col) minmax(0, 1fr);');
    expect(wide).toContain('.message > :not(.message-meta) { grid-column: 2; }');
    expect([px('meta-col'), rootTokens.get('measure-prose')]).toEqual([124, '33rem']);
    // The prose measure caps the text in both layouts, the bubble included.
    expect(/\n\.message p \{[^}]*max-width: var\(--measure-prose\);/.test(plain) && /\n\.message\.user p \{[^}]*max-width: min\(100%, var\(--measure-prose\)\);/.test(plain)).toBe(true);
  });

  it('lets a style put approval labels beside values only in a wide list, never in a narrow one', () => {
    const plain = uncommented(css);
    for (const list of ['approvals-panel', 'approval-tray-cards']) expect(new RegExp(`\\.${list} \\{[^}]*container: approval-list / inline-size;`).test(plain), list).toBe(true);
    for (const name of ['field-layout', 'field-columns', 'field-col-gap', 'gap-field', 'gap-field-label', 'm-pre-card']) expect(rootTokens.get(`${name}-narrow`), name).toBe(`var(--${name})`);
    expect(/@container approval-list \(min-width: 508px\)\s*{\s*\.approval-card dl \{[^}]*display: var\(--card-field-layout\);/.test(plain)).toBe(true);
    // Long evidence keeps its label above and the full width; the environment takes two columns only in a wider list.
    expect(/@container approval-list \(min-width: 508px\)\s*{[^@]*\.approval-card dl\.field-long \{ display: block; \}/.test(plain)).toBe(true);
    expect(/@container approval-list \(min-width: 600px\)\s*{\s*\.approval-card \.environment-list \{ columns: 2;/.test(plain)).toBe(true);
    expect([rootTokens.get('card-field-layout'), rootTokens.get('label-col')]).toEqual(['grid', '7.5rem']);
  });

  it('puts each Usage figure beside its label, with Balanced\'s chart heights', () => {
    const plain = uncommented(css);
    const rule = (selector: string) => { const start = plain.indexOf(`\n${selector} {`); return start < 0 ? '' : plain.slice(start, plain.indexOf('}', start)); };
    // The label track is auto, so a long figure wraps right-aligned instead of squeezing the label.
    expect(rule('.usage-cards > div')).toContain('grid-template-columns: auto minmax(0, 1fr); align-items: baseline;');
    expect([rule('.usage-cards span'), rule('.usage-cards strong'), rule('.usage-cards small')].map(body => /grid-column: ([^;]+); grid-row: (\d)/.exec(body)?.slice(1))).toEqual([['1', '1'], ['2', '1'], ['1 / -1', '2']]);
    expect([px('h-chart'), px('h-chart-request')]).toEqual([88, 96]);
  });

  it('lays the settings form out in label-left rows in every style, with the MCP form\'s labels kept above their fields', () => {
    const plain = uncommented(css);
    expect([px('w-dialog'), rootTokens.get('form-columns')]).toEqual([780, 'var(--form-label-col) minmax(0, 1fr)']);
    // Compact keeps the rows (it sets only the label column, never the template) and a narrower column.
    expect(styleBlocks.get('compact')!.has('form-columns')).toBe(false);
    expect(Number.parseFloat(styleBlocks.get('compact')!.get('form-label-col')!)).toBeLessThanOrEqual(px('form-label-col')!);
    expect(/\n\.profile-form > label, \.profile-form > \.limits label \{[^}]*grid-template-columns: var\(--form-columns\);/.test(plain)).toBe(true);
    // A descendant selector would also turn the MCP form (nested inside the profile form's dialog) label-left.
    expect(/\n\.profile-form label \{[^}]*grid-template-columns/.test(plain)).toBe(false);
    // Inputs and selects share one height in every style; the eyebrow and title share a baseline.
    expect(/\n\.profile-form input:not\(\[type="checkbox"\]\), \.profile-form select \{ height: var\(--h-input-form\); \}/.test(plain)).toBe(true);
    expect(/\n\.dialog-head > div:first-child \{[^}]*align-items: baseline;/.test(plain)).toBe(true);
  });

  it('runs the child view\'s banner and tray to the pane edges, as the coordinator\'s do, and back into the Focus column', () => {
    const plain = uncommented(css);
    for (const part of ['banner', 'tray']) expect(plain, part).toContain(`\n.coordinator-detail > .approval-${part}, .child-panel > .approval-${part} { margin: 0 calc(-1 * var(--gutter)); }`);
    const start = plain.indexOf('\n.workspace[data-focus="on"] .coordinator-detail > .approval-tray');
    const focus = start < 0 ? '' : plain.slice(start, plain.indexOf('}', start));
    expect(focus).toContain('margin-inline: 0;');
    for (const selector of ['.coordinator-detail > .approval-tray', '.coordinator-detail > .approval-banner', '.child-panel > .approval-tray', '.child-panel > .approval-banner']) expect(focus, selector).toContain(`.workspace[data-focus="on"] ${selector}`);
  });

  it('marks the selected agent by a bar and a border as well as a fill, and restates it for Windows contrast themes', () => {
    const plain = uncommented(css);
    const selected = /\n\.agent-row\.selected \{([^}]*)\}/.exec(plain)?.[1] ?? '';
    expect(['box-shadow: inset 0 -2px 0 var(--select);', 'border-color: var(--select);', 'background: var(--select-chip-bg);'].every(part => selected.includes(part))).toBe(true);
    // Windows contrast themes drop the box-shadow bar, so the forced-colours block restates the selection.
    expect(/@media \(forced-colors: active\)\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? '').toContain('.agent-row.selected');
  });

  it('defines every token a declaration uses', () => {
    const defined = new Set([...uncommented(css).matchAll(/--([\w-]+)\s*:/g)].map(match => match[1]!));
    const used = new Set([...uncommented(css).matchAll(/var\(--([\w-]+)/g)].map(match => match[1]!));
    // --inspector-width is set inline on the workspace by App from the viewer's stored width.
    expect([...used].filter(name => !defined.has(name) && name !== 'inspector-width')).toEqual([]);
  });

  it('keeps every type role at its floor: 11px, conversation prose 14px', () => {
    const roles = [...rootTokens.keys()].filter(name => name.startsWith('fs-')).map(name => [name, px(name)] as const);
    expect(roles.filter(([, value]) => value === undefined || value < 11)).toEqual([]);
    expect(px('fs-prose')).toBeGreaterThanOrEqual(14);
  });

  it('uses every size token and puts no colour in one', () => {
    const rules = uncommented(css).replace(/:root\s*{[\s\S]*?\n}/, '');
    const references = `${rules}\n${[...rootTokens.values()].join('\n')}`;
    expect([...sizeTokens.keys()].filter(name => !references.includes(`var(--${name})`) && !references.includes(`var(--${name},`))).toEqual([]);
    expect([...sizeTokens].filter(([, value]) => /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|color)\(/i.test(value))).toEqual([]);
  });
});

describe('end-to-end hooks', () => {
  // Class names, test ids and accessible names the Playwright specs locate. They are also the contract the
  // WPF host's verbatim spec port relies on, so a rename has to be deliberate (and update the specs).
  const sources = readdirSync(directory).filter(file => file.endsWith('.tsx')).map(file => readFileSync(join(directory, file), 'utf8')).join('\n');
  const classHooks = ['notice', 'approval-card', 'approval-heading', 'composer', 'inspector-resize', 'patch', 'file-tree', 'file-content',
    'command-evidence', 'approval-result', 'approval-target', 'task-row', 'upgrade-banner', 'sidebar-shell', 'browser-content', 'usage-request',
    'automation-dialog', 'automation-form', 'agent-row', 'compaction-summary', 'compacted', 'orchestration-panel', 'assignment-card',
    'approval-banner', 'approval-tray', 'decided-approvals', 'focus-toggle'];
  const testIds = ['publish-panel', 'usage-panel', 'project-channel', 'mcp-settings', 'mcp-server-', 'command-review-limits', 'coordinated-task-controls'];
  const names = ['Agent tree', 'Conversation transcript', 'Task message', 'Message coordinator', 'Chat message', 'Task history', 'Global action center',
    'Resize inspector', 'Task inspector', 'Coordinated task inspector', 'Dismiss notice', 'MCP key', 'MCP name', 'MCP command', 'MCP arguments', 'MCP environment',
    'Pending actions'];

  it('keeps every class hook the specs use', () => {
    // Collect the class tokens of every className expression: string literals inside it, split on whitespace.
    const classTokens = new Set<string>();
    for (const match of sources.matchAll(/className=/g)) {
      let index = match.index + 'className='.length;
      let expression = '';
      if (sources[index] === '"' || sources[index] === "'") expression = sources.slice(index, sources.indexOf(sources[index]!, index + 1) + 1);
      else if (sources[index] === '{') {
        for (let depth = 0; index < sources.length; index++) {
          const character = sources[index]!;
          if (character === '{') depth++;
          if (character === '}' && --depth === 0) break;
          expression += character;
        }
      }
      // Template literals contribute their static text; quoted literals (including those nested in ${…}) their whole text.
      const literals = [...expression.matchAll(/`([^`]*)`/g)].map(literal => literal[1]!.replace(/\$\{[^}]*\}/g, ' '));
      literals.push(...[...expression.matchAll(/"([^"]*)"|'([^']*)'/g)].map(literal => literal[1] ?? literal[2] ?? ''));
      for (const value of literals.join(' ').split(/\s+/)) if (value) classTokens.add(value);
    }
    expect(classHooks.filter(name => !classTokens.has(name))).toEqual([]);
  });

  it('keeps every test id and accessible name the specs use', () => {
    expect(testIds.filter(id => !sources.includes(`data-testid="${id}`) && !sources.includes(`data-testid={\`${id}`))).toEqual([]);
    expect(names.filter(name => !sources.includes(`"${name}"`) && !sources.includes(`'${name}'`))).toEqual([]);
  });
});

describe('attention styles', () => {
  // Rules as [selector, body] pairs; nested at-rule bodies are flattened, which is enough for these checks.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => [match[1]!.trim(), match[2]!] as const);
  const forcedColors = /@media \(forced-colors: active\)\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? '';

  it('recedes and emphasises by colour, border and ring only: never opacity, visibility or display', () => {
    const offending = rules.filter(([selector, body]) => selector.includes('[data-attention') && /\b(opacity|visibility|display|filter)\s*:/.test(body));
    expect(offending).toEqual([]);
  });

  it('adds no motion outside a prefers-reduced-motion: no-preference guard', () => {
    const unguarded = css.replace(/@media \(prefers-reduced-motion: no-preference\)\s*{[\s\S]*?\n}/g, '');
    expect(unguarded.match(/(?:^|[;{\s])(?:transition|animation)(?:-[a-z-]+)?\s*:/gm) ?? []).toEqual([]);
  });

  it('keeps the decision emphasis and Focus state visible in forced colours', () => {
    for (const selector of ['.approval-card.awaiting-approval', '.approval-card.unknown', '.approval-banner', '.focus-toggle[aria-pressed="true"]', '.approval-tray']) expect(forcedColors).toContain(selector);
  });

  it('keeps a box for the cards that need a decision or carry an unknown or failed outcome; decided cards are flat rows', () => {
    const plain = uncommented(css);
    const rule = (selector: string) => { const start = plain.indexOf(`\n${selector} {`); return { start, body: start < 0 ? '' : plain.slice(start, plain.indexOf('}', start)) }; };
    const [base, first, live, awaiting, unknown] = ['.approval-card', '.approval-card:first-of-type', '.approval-card:is(.awaiting-approval, .unknown, .failed)',
      '.approval-card.awaiting-approval', '.approval-card.unknown, .approval-card.failed'].map(rule);
    // Order carries the cascade: the live box restores the top border that :first-of-type removes, and the state rules then
    // set the 3px edge, which a later border shorthand would reset.
    expect([base, first, live, awaiting, unknown].map(found => found!.start >= 0)).toEqual([true, true, true, true, true]);
    expect(base!.start < first!.start && first!.start < live!.start && live!.start < awaiting!.start && awaiting!.start < unknown!.start).toBe(true);
    expect(['border: 0;', 'border-top: 1px solid var(--line);', 'background: transparent;'].every(part => base!.body.includes(part))).toBe(true);
    expect(['margin: var(--gap-card) 0;', 'border: 1px solid'].every(part => live!.body.includes(part))).toBe(true);
    expect([awaiting!.body, unknown!.body].every(body => body.includes('border-left: 3px solid'))).toBe(true);
  });

  it('restates the needs-decision marks for Windows contrast themes', () => {
    for (const selector of ['.action-row.tier-0', '.workspace-views[data-decisions="pending"] > button:first-child', '.primary:disabled']) expect(forcedColors).toContain(selector);
  });

  it('draws the decision ring inside the border, so emphasis never changes geometry', () => {
    const awaiting = rules.find(([selector]) => selector.endsWith('.approval-card.awaiting-approval'))?.[1] ?? '';
    expect(awaiting).toContain('box-shadow: inset');
    expect(awaiting).not.toMatch(/\b(margin|padding|outline)\s*:/);
  });
});
