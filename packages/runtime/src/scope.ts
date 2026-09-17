import { ORCHESTRATION_LIMITS } from '../../protocol/src/index';

const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.terraformrc|\.(?:ssh|aws|azure|kube|docker|gnupg)|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Portable repository-relative path; '' is the repository root and is only valid for read scope. */
export function normalizeScopePath(value: string, allowRoot: boolean): string {
  if (typeof value !== 'string') throw new Error('Scope paths must be strings.');
  const portable = value.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!portable) { if (allowRoot) return ''; throw new Error('Write scope cannot be the whole repository.'); }
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) throw new Error('Scope paths must be repository-relative.');
  for (const segment of portable.split('/')) {
    if (!segment || segment === '.' || segment === '..') throw new Error('Scope paths cannot contain empty, "." or ".." segments.');
    // eslint-disable-next-line no-control-regex -- control characters are deliberately rejected in path segments
    if (segment.toLowerCase() === '.git' || segment.toLowerCase() === '.gitmodules' || segment.toLowerCase() === '.gitattributes' || segment.includes(':') || /[. ]$/.test(segment) || RESERVED_WINDOWS_NAME.test(segment) || SECRET_NAME.test(segment) || /[\u0000-\u001f*?"<>|]/.test(segment)) {
      throw new Error(`Scope path segment "${segment.slice(0, 64)}" is not permitted.`);
    }
  }
  return portable;
}

export function normalizeScope(values: string[], allowRoot: boolean): string[] {
  if (values.length > ORCHESTRATION_LIMITS.maxScopePaths) throw new Error('Too many scope paths.');
  const normalized = [...new Set(values.map(value => normalizeScopePath(value, allowRoot)))];
  const keys = new Set<string>();
  for (const entry of normalized) {
    const key = entry.toLowerCase();
    if (keys.has(key)) throw new Error('Scope paths differ only by case.');
    keys.add(key);
  }
  return normalized.sort();
}

/** Segment-aware, case-insensitive (Windows) containment: `src` covers `src/a.ts`, not `src2/a.ts`. */
export function covers(scope: string, candidate: string): boolean {
  const left = scope.toLowerCase(); const right = candidate.replaceAll('\\', '/').toLowerCase();
  return left === '' || right === left || right.startsWith(`${left}/`);
}

export function inScope(scopes: string[], candidate: string): boolean {
  let normalized: string;
  try { normalized = normalizeScopePath(candidate, false); } catch { return false; }
  return scopes.some(scope => covers(scope, normalized));
}

export function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some(a => right.some(b => covers(a, b) || covers(b, a)));
}

/** Reject cycles and unknown nodes in a dependency graph described by successor -> predecessors. */
export function assertAcyclic(edges: Map<string, string[]>): void {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (node: string): void => {
    const current = state.get(node);
    if (current === 'done') return;
    if (current === 'visiting') throw new Error('Assignment dependencies contain a cycle.');
    state.set(node, 'visiting');
    for (const predecessor of edges.get(node) ?? []) {
      if (!edges.has(predecessor)) throw new Error('Assignment dependency references an unknown assignment.');
      visit(predecessor);
    }
    state.set(node, 'done');
  };
  for (const node of edges.keys()) visit(node);
}

/** True when `a` transitively depends on `b` or vice versa (serial ordering is guaranteed). */
export function ordered(edges: Map<string, string[]>, a: string, b: string): boolean {
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (edges.get(from) ?? []).some(next => reaches(next, to, seen));
  };
  return reaches(a, b) || reaches(b, a);
}
