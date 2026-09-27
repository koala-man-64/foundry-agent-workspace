import { BrowserSnapshotSchema, BrowserTabSchema, type ProviderEvent, type ProviderRequest, type ToolCall } from '../../protocol/src/index';
import { z } from 'zod';

const State = z.object({ browserDemo: z.literal(true), stage: z.enum(['tabs', 'snapshot', 'action']), calls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.unknown() })).length(1) });
export function isBrowserFixtureRequest(request: ProviderRequest): boolean {
  return State.safeParse(request.continuation?.data).success || [...request.messages].reverse().find(message => message.role === 'user')?.content.trim() === '/browser-demo';
}
/** Offline acceptance flow. It only proposes the explicitly named fixture button, through normal approval. */
export async function* browserFixture(request: ProviderRequest): AsyncIterable<ProviderEvent> {
  request.signal.throwIfAborted();
  const state = State.safeParse(request.continuation?.data);
  let call: ToolCall | undefined;
  let stage: 'tabs' | 'snapshot' | 'action' = 'tabs';
  let message = 'Offline browser demo stopped. Attach a page containing a button named Browser demo action.';
  if (!state.success) {
    if (['browser_tabs', 'browser_snapshot', 'browser_action'].every(name => request.tools?.some(tool => tool.name === name))) call = { id: 'browser-demo-tabs', name: 'browser_tabs', arguments: {} };
  } else {
    const expected = state.data.calls[0]!;
    const result = request.toolResults?.find(item => item.id === expected.id && item.name === expected.name);
    if (result && !result.isError) {
      if (state.data.stage === 'action') message = 'Offline browser demo finished: the approved interaction was dispatched. Check the page for its result.';
      else {
        let data: unknown; try { data = JSON.parse(result.content); } catch { data = null; }
        if (state.data.stage === 'tabs') {
          const tabs = z.array(BrowserTabSchema).safeParse(data);
          const tab = tabs.success ? tabs.data.find(tab => tab.sharing) : undefined;
          if (tab) { stage = 'snapshot'; call = { id: 'browser-demo-snapshot', name: 'browser_snapshot', arguments: { tabId: tab.id } }; }
        } else {
          const snapshot = BrowserSnapshotSchema.safeParse(data);
          const target = snapshot.success ? snapshot.data.nodes.find(node => node.role === 'button' && node.name === 'Browser demo action') : undefined;
          if (snapshot.success && target) { stage = 'action'; call = { id: 'browser-demo-action', name: 'browser_action', arguments: { kind: 'click', tabId: snapshot.data.tabId, snapshotId: snapshot.data.id, nodeId: target.id } }; }
        }
      }
    } else message = 'Offline browser demo stopped: the browser operation was rejected, revoked, or failed.';
  }
  if (call) {
    yield { type: 'tool_call', call };
    yield { type: 'done', continuation: { apiKind: 'fake', data: { browserDemo: true, stage, calls: [call] } } };
  } else {
    yield { type: 'text', text: message };
    yield { type: 'done', continuation: { apiKind: 'fake', data: { stage: 'complete', calls: [] } } };
  }
}
