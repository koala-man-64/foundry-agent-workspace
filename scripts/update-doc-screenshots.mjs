import { copyFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import console from 'node:console';

// Deliberate publication step. Routine tests write only ignored test artifacts.
const screenshots = [
  ['workspace.png', 'workspace-screenshot.png'],
  ['coding-approval.png', 'coding-approval-screenshot.png'],
  ['orchestration-complete.png', 'orchestration-screenshot.png'],
  ['mcp-approval.png', 'mcp-approval-screenshot.png'],
];
await Promise.all(screenshots.map(async ([source]) => { const file = await stat(resolve('test-results', source)); if (!file.isFile()) throw new Error(`Missing test screenshot: ${source}`); }));
for (const [source, target] of screenshots) await copyFile(resolve('test-results', source), resolve('docs', target));
console.log('Documentation screenshots updated from the latest local E2E artifacts. Review the image diff before committing.');
