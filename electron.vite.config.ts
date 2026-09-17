import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import { copyFileSync } from 'node:fs';
export default defineConfig({
  main: {
    plugins: [{ name: 'command-helper', closeBundle() { copyFileSync('packages/runtime/src/job-runner.ps1', 'out/main/job-runner.ps1'); } }],
    build: { outDir: 'out/main', rollupOptions: { input: { index: resolve('apps/desktop/src/main/index.ts'), runtime: resolve('packages/runtime/src/entry.ts') }, external: ['better-sqlite3'] } }
  },
  preload: { build: { outDir: 'out/preload', rollupOptions: { input: resolve('apps/desktop/src/preload/index.ts') } } },
  renderer: {
    root: 'apps/desktop/src/renderer',
    build: { outDir: resolve('out/renderer'), rollupOptions: { input: resolve('apps/desktop/src/renderer/index.html') } }
  }
});
