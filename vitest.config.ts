import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: [
  { test: { name: 'unit', include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], exclude: ['packages/**/*.integration.test.ts'], testTimeout: 20000 } },
  { test: { name: 'integration', include: ['tests/integration/**/*.test.ts', 'packages/**/*.integration.test.ts'], testTimeout: 30000 } }
] } });
