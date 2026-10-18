import fs from 'node:fs';
import path from 'node:path';

// Scratch trees hold Git's read-only objects and junctions. Under Electron's build of Node 24.21, fs.rmSync refuses
// read-only files and junctions, and a recursive fs.rmSync follows a junction inside the tree and empties its target;
// Node's own 24.21 build does neither. This walk never follows a link and gives the same result on both.
const TRANSIENT = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

/** Removes a tree, or a missing path, without following links; `retries` covers a handle a child process still holds. */
export function removeTree(target: string, retries = 0): void {
  for (let attempt = 0; ; attempt++) {
    try { return remove(target); } catch (error) {
      if (attempt >= retries || !TRANSIENT.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

function remove(target: string): void {
  let entry: fs.Stats;
  try { entry = fs.lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entry.isDirectory()) {
    for (const name of fs.readdirSync(target)) remove(path.join(target, name));
    fs.rmdirSync(target);
    return;
  }
  if (!entry.isSymbolicLink() && (entry.mode & 0o200) === 0) fs.chmodSync(target, 0o666);
  fs.unlinkSync(target); // a junction or symbolic link goes, never its target
}
