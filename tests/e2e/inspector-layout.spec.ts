import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForRuntimeReady } from './fixtures';

// The approval list's container rules and the Activity row, measured on synthetic markup that uses the app's classes:
// short fields beside their label from 508px of list, long evidence always stacked with a gap above its text (in
// Comfortable and Compact), the environment in two columns from 600px, an Activity event with its time on the title's row
// and its evidence below, and a file list a long file cannot squeeze.
test('approval fields, Activity rows and the file list lay out by the inspector size', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), 'foundry-inspector-layout-e2e-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.FOUNDRY_WORKSPACE_TEST_DATA = join(root, 'state'); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env });
  try {
    const page = await app.firstWindow();
    await waitForRuntimeReady(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.style)).toBe('comfortable');
    // In both styles: stacked evidence (a long field, the Command block) keeps a gap between its label and its text, however
    // wide the list.
    for (const style of ['comfortable', 'compact'] as const) {
      const cards = await page.evaluate(style => {
        document.documentElement.dataset.style = style;
        return [507, 508, 599, 600].map(width => {
          const list = document.createElement('div');
          list.className = 'approvals-panel';
          Object.assign(list.style, { width: `${width}px`, padding: '0', flex: 'none' });
          list.innerHTML = '<article class="approval-card awaiting-approval"><div class="command-evidence"><strong>Command</strong><pre>Write-Output 1</pre></div>'
            + '<dl><dt>Shell</dt><dd>powershell.exe</dd></dl>'
            + '<dl class="field-long"><dt>After</dt><dd><pre>new content</pre></dd></dl>'
            + '<dl class="field-long"><dt>Environment</dt><dd class="environment-list">' + Array.from({ length: 6 }, (_, index) => `<span class="environment">KEY${index}=value</span>`).join('') + '</dd></dl></article>';
          document.body.append(list);
          const box = (selector: string) => list.querySelector(selector)!.getBoundingClientRect();
          const [short, long, environment] = [...list.querySelectorAll('dl')].map(dl => ({ label: dl.querySelector('dt')!.getBoundingClientRect(), value: dl.querySelector('dd')!.getBoundingClientRect() }));
          const entries = [...list.querySelectorAll('.environment')].map(entry => Math.round(entry.getBoundingClientRect().left));
          const result = {
            width, shortBeside: short!.label.right <= short!.value.left, longStacked: long!.value.top >= long!.label.bottom, environmentStacked: environment!.value.top >= environment!.label.bottom, environmentColumns: new Set(entries).size,
            // Compact's stacked gaps are 1px under a label and 2px above a pre; the environment has no pre, so its label's own
            // margin is the only gap.
            longGap: box('dl.field-long pre').top - long!.label.bottom >= 1.5, commandGap: box('.command-evidence pre').top - box('.command-evidence strong').bottom >= 1.5,
            environmentGap: environment!.value.top - environment!.label.bottom >= 0.5,
          };
          list.remove();
          return result;
        });
      }, style);
      const stacked = { longStacked: true, environmentStacked: true, longGap: true, commandGap: true, environmentGap: true };
      expect(cards, style).toEqual([
        { width: 507, shortBeside: false, environmentColumns: 1, ...stacked },
        { width: 508, shortBeside: true, environmentColumns: 1, ...stacked },
        { width: 599, shortBeside: true, environmentColumns: 1, ...stacked },
        { width: 600, shortBeside: true, environmentColumns: 2, ...stacked },
      ]);
    }
    await page.evaluate(() => { document.documentElement.dataset.style = 'comfortable'; });
    const activity = await page.evaluate(() => {
      const list = document.createElement('ol');
      list.className = 'activity-timeline';
      list.style.width = '360px';
      list.innerHTML = '<li><time>10/27/2026, 9:48:03 AM</time><strong>Approval Changed</strong><details><summary>Inspect evidence record 203</summary></details></li>';
      document.body.append(list);
      const box = (selector: string) => list.querySelector(selector)!.getBoundingClientRect();
      const [time, title, details] = [box('time'), box('strong'), box('details')];
      // Baseline alignment offsets the smaller time from the title's top, so "the same row" means they overlap vertically.
      const result = { timeBesideTitle: time.left >= title.right && time.top < title.bottom && time.bottom > title.top, detailsBelow: details.top >= Math.max(time.bottom, title.bottom), detailsFromTheStart: Math.abs(details.left - title.left) < 1 };
      list.remove();
      return result;
    });
    expect(activity).toEqual({ timeBesideTitle: true, detailsBelow: true, detailsFromTheStart: true });
    // A long open file never squeezes the file list: three files keep their rows, and a long list stops at 40%.
    const files = await page.evaluate(() => [3, 40].map(count => {
      const inspector = document.createElement('aside');
      inspector.className = 'inspector';
      Object.assign(inspector.style, { width: '400px', height: '600px' });
      inspector.innerHTML = `<div class="file-tree">${Array.from({ length: count }, (_, index) => `<button type="button"><span>·</span>file-${index}.ts</button>`).join('')}</div>`
        + `<div class="file-content"><p>file-0.ts</p><pre>${'line\n'.repeat(4000)}</pre></div>`;
      document.body.append(inspector);
      const tree = inspector.querySelector('.file-tree')!;
      const result = { count, rowsShown: tree.clientHeight >= tree.scrollHeight - 1, share: Math.round(tree.getBoundingClientRect().height / 600 * 100) };
      inspector.remove();
      return result;
    }));
    expect(files[0]!.rowsShown, 'three files show every row beside a long file').toBe(true);
    expect(files[1]!.rowsShown).toBe(false);
    expect(files[1]!.share, 'a long list stops at its 40% ceiling').toBe(40);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
