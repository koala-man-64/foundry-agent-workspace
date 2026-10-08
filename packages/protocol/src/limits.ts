// Bounds and capability lists the renderer needs as values. This module imports nothing, so a renderer that takes its
// values from here carries no validator in its bundle (docs/wpf-webview2-migration.md, P0); the zod schemas build on
// the same constants. When the zod protocol is removed at cutover, this module moves with the UI.

/** Agent channel bounds, enforced by the channel schemas and the runtime's channel store. */
export const CHANNEL_LIMITS = { messageBytes: 2048, pageSize: 20, participants: 50, messagesPerTask: 1000 } as const;

/**
 * Shared, tested orchestration bounds. Store, runtime and renderer use these
 * constants; nothing in repository text or model output can raise them.
 */
export const ORCHESTRATION_LIMITS = {
  maxAssignmentRevisions: 8,
  maxAdmittedChildren: 2,
  childSummariesPerPage: 8,
  eventsPerPage: 50,
  summaryTextBytes: 4 * 1024,
  childReportBytes: 16 * 1024,
  responseBytes: 256 * 1024,
  maxScopePaths: 32,
  maxDependencies: 8,
  maxAcceptanceItems: 16,
  maxChildProfiles: 4,
  protectedCoordinatorPercent: 20,
  budgetWarningPercent: 80,
  patchBytes: 128 * 1024
} as const;

/** Reasoning efforts in their protocol order; usage.ts builds EffortSchema from this list. */
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export function supportedEfforts(apiKind: string): Effort[] {
  if (apiKind === 'responses') return [...EFFORTS];
  // Azure max effort is Responses-only; deployment-specific support still requires probing.
  if (apiKind === 'chat-completions') return EFFORTS.filter(effort => effort !== 'max');
  if (apiKind === 'anthropic') return ['low', 'medium', 'high', 'xhigh', 'max'];
  return [];
}
