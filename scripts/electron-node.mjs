// Runs a Node program under the Node that Electron ships (ELECTRON_RUN_AS_NODE), the runtime the shipping app's
// supervisor starts. `pnpm oracle` runs the P2 oracles this way, the only place their vectors may be written; CI uses
// it to check them and the `.node-version` pin against the Electron it downloaded.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

const electron = createRequire(import.meta.url)('electron');
const result = spawnSync(electron, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
