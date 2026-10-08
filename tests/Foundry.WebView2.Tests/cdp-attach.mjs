// Spike S9, run by CdpTests: attach Playwright over CDP to each WebView2 environment the rig exposes, read the page and
// evaluate in it, then detach without closing the host's browser.
import { chromium } from '@playwright/test';
import process from 'node:process';
import console from 'node:console';

for (const port of process.argv.slice(2)) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = browser.contexts().flatMap(context => context.pages());
  for (const page of pages) {
    const title = await page.title();
    const origin = await page.evaluate(() => globalThis.location.origin + globalThis.location.pathname);
    console.log(`port ${port}: ${browser.contexts().length} context(s), page ${page.url()} title "${title}" evaluated ${origin}`);
  }
  if (pages.length === 0) console.log(`port ${port}: attached, no pages`);
  await browser.close(); // For a connectOverCDP browser this disconnects; the host's browser keeps running.
}
