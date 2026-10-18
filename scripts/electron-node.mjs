// Runs a Node program under the Node that Electron ships (ELECTRON_RUN_AS_NODE), the runtime the shipping app's
// supervisor starts. `pnpm oracle` runs vitest this way, so P2 vectors can be written on a machine whose own Node
// differs from `.node-version`; CI uses it to check that pin against the Electron it downloaded.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

const electron = createRequire(import.meta.url)('electron');
const result = spawnSync(electron, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
