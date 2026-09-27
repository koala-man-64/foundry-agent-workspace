import { randomUUID } from 'node:crypto';
import type { ProviderEvent, ProviderRequest, Task } from '../../protocol/src/index';
import type { ReservationHandle, TurnHooks } from './agent-loop';
import type { Store } from './store';

export type MeasuredUsage = Extract<ProviderEvent, { type: 'usage' }>;
export type ResponseMetadata = { reportedModel?: string; responseId?: string };

/** The runtime revalidates measurements even when an adapter is injected. */
export function measuredUsage(event: MeasuredUsage): MeasuredUsage | undefined {
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!valid(event.inputTokens) || !valid(event.outputTokens) || !Number.isSafeInteger(event.inputTokens + event.outputTokens)) return undefined;
  const subset = (n: unknown, total: number): number | undefined => valid(n) && n <= total ? n : undefined;
  let cacheReadTokens = subset(event.cacheReadTokens, event.inputTokens);
  let cacheCreationTokens = subset(event.cacheCreationTokens, event.inputTokens);
  if ((cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0) > event.inputTokens) { cacheReadTokens = undefined; cacheCreationTokens = undefined; }
  return { type: 'usage', inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadTokens, cacheCreationTokens, reasoningTokens: subset(event.reasoningTokens, event.outputTokens) };
}

export function admitRequest(store: Store, task: Task, request: ProviderRequest, hooks: TurnHooks): ReservationHandle {
  return store.transaction(() => {
    const handle = hooks.reserve(task, request);
    handle.requestId ??= randomUUID();
    store.beginUsage(handle.requestId, task, request.profile, handle.amount, 'conversation');
    return handle;
  });
}
