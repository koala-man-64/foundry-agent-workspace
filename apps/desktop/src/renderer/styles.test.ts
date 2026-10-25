import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
  });

  it('keeps rail text at AA on the rail surfaces it is drawn on', () => {
    expect(failures(['rail-ink', 'rail-ink-2', 'rail-muted', 'rail-faint'], RAIL_SURFACES, 4.5)).toEqual([]);
    expect(failures(['rail-ink', 'rail-ink-2'], ['rail-selected'], 4.5)).toEqual([]);
  });

  it('keeps control boundaries, focus rings and chart marks at 3:1 (WCAG 1.4.11)', () => {
    expect(failures(['line-strong'], ['canvas', 'surface', 'surface-card', 'surface-inspector'], 3)).toEqual([]);
    expect(failures(['focus'], LIGHT_SURFACES.filter(surface => surface !== 'surface-well'), 3)).toEqual([]);
    expect(failures(['rail-focus'], [...RAIL_SURFACES, 'rail-selected'], 3)).toEqual([]);
    expect(failures(['viz-reported', 'viz-unknown', 'viz-unsent', 'viz-axis'], ['surface', 'surface-card', 'surface-inspector'], 3)).toEqual([]);
  });

  it('uses no font size below the 11px floor', () => {
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
    expect(sizes.filter(size => size < 11)).toEqual([]);
  });
});

describe('end-to-end hooks', () => {
  // Class names, test ids and accessible names the Playwright specs locate. They are also the contract the
  // WPF host's verbatim spec port relies on, so a rename has to be deliberate (and update the specs).
  const sources = readdirSync(directory).filter(file => file.endsWith('.tsx')).map(file => readFileSync(join(directory, file), 'utf8')).join('\n');
  const classHooks = ['notice', 'approval-card', 'approval-heading', 'composer', 'inspector-resize', 'patch', 'file-tree', 'file-content',
    'command-evidence', 'approval-result', 'approval-target', 'task-row', 'upgrade-banner', 'sidebar-shell', 'browser-content', 'usage-request',
    'automation-dialog', 'automation-form', 'agent-row', 'compaction-summary', 'compacted', 'orchestration-panel', 'assignment-card'];
  const testIds = ['publish-panel', 'usage-panel', 'project-channel', 'mcp-settings', 'mcp-server-', 'command-review-limits', 'coordinated-task-controls'];
  const names = ['Agent tree', 'Conversation transcript', 'Task message', 'Message coordinator', 'Chat message', 'Task history', 'Global action center',
    'Resize inspector', 'Task inspector', 'Coordinated task inspector', 'Dismiss notice', 'MCP key', 'MCP name', 'MCP command', 'MCP arguments', 'MCP environment'];

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
