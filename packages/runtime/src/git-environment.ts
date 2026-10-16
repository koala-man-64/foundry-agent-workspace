import { promises as fs } from 'node:fs';

/**
 * App-invoked Git points core.hooksPath at the app-owned empty hooks folder, and Git runs whatever hook it finds there
 * (post-commit, post-checkout, reference-transaction…) with the user's privileges. The folder must therefore be absent or
 * a real, empty directory, checked before every launch and again after exit: a hook planted while Git ran may have run.
 */
export async function assertNoGitHooks(hooksPath: string, when: 'before' | 'after'): Promise<void> {
  let entry: Awaited<ReturnType<typeof fs.lstat>>;
  try { entry = await fs.lstat(hooksPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory() || (await fs.readdir(hooksPath)).length > 0) {
    throw new Error(when === 'before'
      ? 'The app-owned Git hooks folder is not empty; refusing to run Git.'
      : 'The app-owned Git hooks folder changed while Git ran; a hook may have run.');
  }
}

/**
 * Environment for app-invoked Git. Every inherited `GIT_*` variable is removed first: values
 * such as GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY or GIT_CONFIG_PARAMETERS
 * would otherwise redirect operations away from the validated worktree or inject configuration.
 */
export function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra };
}
