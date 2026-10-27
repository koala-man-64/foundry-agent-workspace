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
    const weights = [...plain.matchAll(/([^{}]+)\{([^}]*)\}/g)].flatMap(([, selector, body]) => [...body!.matchAll(/font-weight:\s*([^;]+);|font:\s*(\d{3})\s/g)]
      .map(match => [selector!.trim(), (match[1] ?? match[2])!.trim()] as const));
    expect(weights.length).toBeGreaterThan(40);
    expect(weights.filter(([selector, weight]) => !['400', '600', 'normal'].includes(weight) && !(weight === '300' && ['.sidebar-plus', '.icon-button'].includes(selector)))).toEqual([]);
  });

  it('writes labels in sentence case: no capitals-and-tracking labels', () => {
    const plain = uncommented(css);
    expect([...plain.matchAll(/([^{}]+)\{[^}]*text-transform:\s*uppercase/g)].map(match => match[1]!.trim())).toEqual(['.approval-state::first-letter']);
    expect([...plain.matchAll(/letter-spacing:\s*([^;]+);/g)].map(match => match[1]!.trim()).filter(value => !['0', 'normal'].includes(value))).toEqual([]);
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

// Style blocks (:root[data-style="..."]): token values only, set on the size roles.
const styleBlocks = new Map([...uncommented(css).matchAll(/:root\[data-style="([\w-]+)"\]\s*{([^}]*)}/g)].map(match => [match[1]!, new Map([...match[2]!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(declaration => [declaration[1]!, declaration[2]!.trim()]))]));
// Fixed heights held at the 24px floor. --h-dense is exempt: dense rows clamp it with max(var(--target-min), var(--h-dense)).
const FIXED_HEIGHTS = /^h-(ctl|view|chrome|decision|composer|compose-text|browser-tabs)\b/;
// Rows whose height comes from padding: each is clamped to the pointer-target floor, so a style can shrink the padding only.
const DENSE_ROWS = ['.sidebar-new', '.project-toggle', '.task-row', '.sidebar-footer button', '.sidebar-usage button', '.inspector-tabs button', '.file-tree button', '.agent-row'];

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

  it('lets a style put approval labels beside values only in a wide list, never in a narrow one', () => {
    const plain = uncommented(css);
    for (const list of ['approvals-panel', 'approval-tray-cards']) expect(new RegExp(`\\.${list} \\{[^}]*container: approval-list / inline-size;`).test(plain), list).toBe(true);
    for (const name of ['field-layout', 'field-columns', 'field-col-gap', 'gap-field', 'gap-field-label', 'm-pre-card']) expect(rootTokens.get(`${name}-narrow`), name).toBe(`var(--${name})`);
    expect(/@container approval-list \(min-width: 560px\)\s*{\s*\.approval-card dl \{[^}]*display: var\(--field-layout\);/.test(plain)).toBe(true);
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

  it('draws the decision ring inside the border, so emphasis never changes geometry', () => {
    const awaiting = rules.find(([selector]) => selector.endsWith('.approval-card.awaiting-approval'))?.[1] ?? '';
    expect(awaiting).toContain('box-shadow: inset');
    expect(awaiting).not.toMatch(/\b(margin|padding|outline)\s*:/);
  });
});
