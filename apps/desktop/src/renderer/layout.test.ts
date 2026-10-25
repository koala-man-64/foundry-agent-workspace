import { describe, expect, it } from 'vitest';
import { approvalsTabLabel, classifyPatchLines } from './layout';

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

  it('keeps the +/- marks in the text and classifies each line', () => {
    expect(classifyPatchLines(patch).map(line => line.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add', 'add']);
    expect(classifyPatchLines(patch).find(line => line.kind === 'add')?.text.startsWith('+')).toBe(true);
  });
});
