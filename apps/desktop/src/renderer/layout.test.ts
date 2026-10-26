import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeFilterCount, recentOutcomesFold, inspectorTabInView, approvalsTabLabel, clampInspectorWidth, classifyPatchLines, DEFAULT_RAIL_WIDTHS, defaultInspectorWidth, documentRailWidths, initialInspectorWidth, maxInspectorWidth, MIN_INSPECTOR_WIDTH, rememberInspectorWidth } from './layout';

describe('inspectorTabInView', () => {
  it('is true only when the tab is selected and the inspector is on screen', () => {
    expect(inspectorTabInView(true, false, false)).toBe(true);
    expect(inspectorTabInView(true, true, true)).toBe(true);
    expect(inspectorTabInView(true, true, false)).toBe(false);
    expect(inspectorTabInView(false, false, false)).toBe(false);
    expect(inspectorTabInView(false, true, true)).toBe(false);
  });
});

describe('approvalsTabLabel', () => {
  it('keeps the name starting with Approvals and shows real counts', () => {
    expect(approvalsTabLabel(0)).toBe('Approvals');
    expect(approvalsTabLabel(2)).toBe('Approvals (2 waiting)');
    expect(approvalsTabLabel(3, 0, true)).toBe('Approvals (3+ waiting)');
    expect(approvalsTabLabel(1, 2)).toBe('Approvals (1 waiting · 2 unknown)');
    expect(approvalsTabLabel(0, 1)).toBe('Approvals (1 unknown)');
    for (const label of [approvalsTabLabel(0), approvalsTabLabel(4, 1, true)]) expect(label).toMatch(/^Approvals/);
  });
});

describe('classifyPatchLines', () => {
  const patch = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n context\n-old\n+new\n+added';

  it('reproduces the patch text exactly', () => {
    expect(classifyPatchLines(patch).map(line => line.text).join('')).toBe(patch);
    expect(classifyPatchLines('').map(line => line.text).join('')).toBe('');
    expect(classifyPatchLines('a\n').map(line => line.text).join('')).toBe('a\n');
  });

  it('treats --/++ content inside a hunk as a change, not a header', () => {
    const tricky = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- old dashes\n+++ new pluses\ndiff --git a/y b/y\n--- a/y';
    expect(classifyPatchLines(tricky).map(line => line.kind)).toEqual(['meta', 'meta', 'hunk', 'del', 'add', 'meta', 'meta']);
  });

  it('keeps the +/- marks in the text and classifies each line', () => {
    expect(classifyPatchLines(patch).map(line => line.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add', 'add']);
    expect(classifyPatchLines(patch).find(line => line.kind === 'add')?.text.startsWith('+')).toBe(true);
  });
});

describe('inspector width', () => {
  it('defaults to 360px up to 1480px and grows on wide windows to at most 480px', () => {
    expect(defaultInspectorWidth(1000)).toBe(360 > maxInspectorWidth(1000) ? maxInspectorWidth(1000) : 360);
    expect(defaultInspectorWidth(1480)).toBe(360);
    expect(defaultInspectorWidth(1920)).toBe(480);
    expect(defaultInspectorWidth(2560)).toBe(480);
  });

  it('clamps to the minimum and to what leaves the conversation room', () => {
    expect(clampInspectorWidth(100, 1480)).toBe(MIN_INSPECTOR_WIDTH);
    expect(clampInspectorWidth(5000, 1480)).toBe(1480 - 270 - 320 - 5);
    expect(maxInspectorWidth(1000)).toBe(1000 - 236 - 320 - 5);
    expect(maxInspectorWidth(700)).toBe(MIN_INSPECTOR_WIDTH);
  });

  it('takes the rail width from the stylesheet, so a style that changes it moves the limits too', () => {
    const root = /:root\s*{([\s\S]*?)\n}/.exec(readFileSync(join(__dirname, 'styles.css'), 'utf8'))?.[1] ?? '';
    const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(root)?.[1]?.trim();
    expect([token('rail-w'), token('rail-w-narrow')]).toEqual([`${DEFAULT_RAIL_WIDTHS.wide}px`, `${DEFAULT_RAIL_WIDTHS.narrow}px`]);
    const narrowRail = { wide: 240, narrow: 224 };
    expect(maxInspectorWidth(1480, narrowRail)).toBe(1480 - 240 - 320 - 5);
    expect(maxInspectorWidth(1000, narrowRail)).toBe(1000 - 224 - 320 - 5);
    expect(clampInspectorWidth(5000, 1480, narrowRail)).toBe(maxInspectorWidth(1480, narrowRail));
    expect(initialInspectorWidth(1000, { getItem: () => '900' }, narrowRail)).toBe(maxInspectorWidth(1000, narrowRail));
  });

  it('reads the rail widths from the page and keeps the default for anything but a px length', () => {
    const style = (values: Record<string, string>) => ({ getPropertyValue: (name: string) => values[name] ?? '' });
    expect(documentRailWidths(style({ '--rail-w': ' 240px', '--rail-w-narrow': '224px' }))).toEqual({ wide: 240, narrow: 224 });
    expect(documentRailWidths(style({}))).toEqual(DEFAULT_RAIL_WIDTHS);
    expect(documentRailWidths(style({ '--rail-w': 'calc(10px + 20%)', '--rail-w-narrow': '-4px' }))).toEqual(DEFAULT_RAIL_WIDTHS);
  });

  it('prefers a remembered width, clamped, and survives unavailable storage', () => {
    expect(initialInspectorWidth(1480, { getItem: () => '420' })).toBe(420);
    expect(initialInspectorWidth(1000, { getItem: () => '900' })).toBe(maxInspectorWidth(1000));
    expect(initialInspectorWidth(1920, { getItem: () => null })).toBe(480);
    expect(initialInspectorWidth(1480, { getItem: () => { throw new Error('denied'); } })).toBe(360);
    expect(initialInspectorWidth(1480, undefined)).toBe(360);
    expect(() => rememberInspectorWidth(400, { setItem: () => { throw new Error('denied'); } })).not.toThrow();
  });
});

describe('activeFilterCount', () => {
  it('counts only set filters and ignores whitespace-only paths', () => {
    const none = { mode: '', status: '', projectId: '', projectPath: '  ', fromDate: '', toDate: '' };
    expect(activeFilterCount(none)).toBe(0);
    expect(activeFilterCount({ ...none, mode: 'coding', fromDate: '2026-10-01' })).toBe(2);
  });
});

describe('recentOutcomesFold', () => {
  it('folds finished outcomes only while something needs a decision or is in progress', () => {
    const finished = [{ state: 'task.completed' }];
    expect(recentOutcomesFold({ needsDecision: 1, inProgress: 0 }, [], finished)).toEqual({ defaultOpen: false, forceOpen: false });
    expect(recentOutcomesFold({ needsDecision: 0, inProgress: 0 }, [], finished)).toEqual({ defaultOpen: true, forceOpen: false });
    expect(recentOutcomesFold(undefined, [{ tier: 1 }, { tier: 2 }], finished).defaultOpen).toBe(false);
  });

  it('never folds a stopped task away', () => {
    expect(recentOutcomesFold({ needsDecision: 2, inProgress: 0 }, [], [{ state: 'task.completed' }, { state: 'task.stopped' }]).forceOpen).toBe(true);
  });
});
