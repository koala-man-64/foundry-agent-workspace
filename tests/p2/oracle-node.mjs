// P2 vectors record the shipping runtime's behaviour, so they are written only under Electron's own Node, the runtime
// the app's supervisor starts, at the version `.node-version` pins (CI checks the pin against Electron). The same
// version is not enough: Electron builds Node with its own V8 and ICU, and its fs.rmSync differs from Node's build.
// Checking vectors is allowed on any Node.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const pinned = readFileSync(new URL('../../.node-version', import.meta.url), 'utf8').trim();

/** Refuses to write vectors, at the request of `trigger`, anywhere but Electron's Node at the pinned version. */
export function requireShippingNode(trigger) {
  const { electron, node } = process.versions;
  if (electron === undefined || node !== pinned)
    throw new Error(`${trigger} writes vectors only under Electron's Node ${pinned} (.node-version), the runtime the app ships; this is ${electron === undefined ? 'a standalone' : `Electron ${electron}'s`} Node ${node}. Run it with pnpm oracle, or node scripts/electron-node.mjs <script>.`);
}

/** Whether a P2_WRITE_* flag asks to regenerate vectors; refuses anywhere but Electron's Node at the pinned version. */
export function regenerating(flag) {
  if (process.env[flag] !== '1') return false;
  requireShippingNode(`${flag}=1`);
  return true;
}
