import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Disposable repository trees shared by the P2.2 Node oracles. The C# RepositoryFixture builds the same steps the same
// way. Fixture and runtime Git share an isolated HOME, no system configuration and the C locale.
export type Step = { dir: string } | { file: string; text?: string; base64?: string; repeat?: [string, number] } | { junction: string; target: string }
  | { hardlink: string; target: string } | { git: string[] } | { remove: string };

export const git = (...args: string[]): Step => ({ git: args });
export const file = (name: string, text: string): Step => ({ file: name, text });
export const committed = (extra: Step[] = [], name = 'repo'): Step[] => [
  { dir: name }, file(`${name}/README.md`, 'hello\n'), file(`${name}/src/a.ts`, 'export const a = 1;\n'), file(`${name}/docs/b.md`, '# b\n'), ...extra,
  git('-C', name, 'init', '-q'), git('-C', name, 'add', '-A'), git('-C', name, 'commit', '-qm', 'fixture'),
];

export function isolatedGitEnvironment(home: string): Record<string, string> {
  return { GIT_CONFIG_NOSYSTEM: '1', HOME: home, XDG_CONFIG_HOME: home, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };
}

export function runGit(scratch: string, home: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
  Object.assign(env, isolatedGitEnvironment(home), { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
  return execFileSync('git', ['-c', `core.hooksPath=${path.join(scratch, 'no-fixture-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: scratch, env, windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
}

export function build(scratch: string, home: string, tree: Step[]): string[] {
  const links: string[] = [];
  for (const step of tree) {
    if ('dir' in step) fs.mkdirSync(path.join(scratch, step.dir), { recursive: true });
    else if ('file' in step) {
      const target = path.join(scratch, step.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = step.base64 !== undefined ? Buffer.from(step.base64, 'base64') : step.repeat ? Buffer.from(step.repeat[0].repeat(step.repeat[1]), 'utf8') : Buffer.from(step.text!, 'utf8');
      fs.writeFileSync(target, bytes);
    } else if ('junction' in step) {
      const link = path.join(scratch, step.junction);
      fs.symlinkSync(path.join(scratch, step.target), link, 'junction'); links.push(link);
    } else if ('hardlink' in step) fs.linkSync(path.join(scratch, step.target), path.join(scratch, step.hardlink));
    else if ('remove' in step) fs.rmSync(path.join(scratch, step.remove));
    else runGit(scratch, home, step.git);
  }
  return links;
}

/** Scratch paths become placeholders; long strings are pinned by length and hash so the corpus stays reviewable. */
export function normalize(value: unknown, scratch: string): unknown {
  if (typeof value === 'string') {
    // Raw JSON columns spell the path with doubled backslashes.
    const text = value.replaceAll(scratch.replaceAll('\\', '\\\\'), '{scratch-json}').replaceAll(scratch, '{scratch}').replaceAll(scratch.replaceAll('\\', '/'), '{scratch/}').replaceAll(scratch.toLowerCase(), '{scratch-lower}');
    return text.length > 4096 ? { length: text.length, sha256: createHash('sha256').update(text, 'utf8').digest('hex') } : text;
  }
  if (Array.isArray(value)) return value.map(item => normalize(item, scratch));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, scratch)]));
  return value;
}

/** Placeholders in seeded documents become the scratch path. */
export function expand(value: unknown, scratch: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{scratch}', scratch);
  if (Array.isArray(value)) return value.map(item => expand(item, scratch));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, scratch)]));
  return value;
}

/** Runs body with the isolated Git environment applied to process.env, restoring every variable afterwards. */
export async function withIsolatedGit<T>(home: string, body: () => Promise<T>): Promise<T> {
  const settings = isolatedGitEnvironment(home); const saved: Record<string, string | undefined> = {};
  for (const name of Object.keys(settings)) { saved[name] = process.env[name]; process.env[name] = settings[name]; }
  try { return await body(); }
  finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}

export const sha256File = (target: string) => createHash('sha256').update(fs.readFileSync(target)).digest('hex');
