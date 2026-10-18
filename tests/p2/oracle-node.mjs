// P2 vectors record the shipping runtime's behaviour, so they are written only on the Node that Electron ships, which
// `.node-version` pins (CI checks the pin against Electron). Checking them is allowed on any Node.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const pinned = readFileSync(new URL('../../.node-version', import.meta.url), 'utf8').trim();

/** Refuses to write vectors, at the request of `trigger`, on a Node other than the pinned one. */
export function requirePinnedNode(trigger) {
  if (process.versions.node !== pinned)
    throw new Error(`${trigger} writes vectors only on Node ${pinned} (.node-version), the Node Electron ships; this is Node ${process.versions.node}. Run it under Electron's Node: pnpm oracle <test file>, or node scripts/electron-node.mjs <script>.`);
}

/** Whether a P2_WRITE_* flag asks to regenerate vectors; refuses on a Node other than the pinned one. */
export function regenerating(flag) {
  if (process.env[flag] !== '1') return false;
  requirePinnedNode(`${flag}=1`);
  return true;
}
