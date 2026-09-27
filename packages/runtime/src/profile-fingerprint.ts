import { createHash } from 'node:crypto';
import type { ModelProfile } from '../../protocol/src/index';

export function profileFingerprint(profile: ModelProfile): string {
  return createHash('sha256').update(JSON.stringify({ apiKind: profile.apiKind, endpoint: profile.endpoint, deployment: profile.deployment, credentialRef: profile.credentialRef, contextLimit: profile.contextLimit, outputLimit: profile.outputLimit, effort: profile.effort })).digest('hex');
}
