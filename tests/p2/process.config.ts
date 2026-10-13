import { defineConfig } from 'vitest/config';

// Explicit dual-runtime qualification: build both runtimes before invoking this
// gate. The ordinary shipping Node suite must not require a .NET SDK/install.
export default defineConfig({ test: { include: ['tests/p2/*.parity.ts'], testTimeout: 20000 } });
