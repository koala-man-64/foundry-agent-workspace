import type { Approval, DesktopApi } from '../../../../packages/protocol/src/index';

export interface ReviewedApproval { approval: Approval; complete: boolean; error?: string }

export async function readApprovalEvidence(api: DesktopApi, taskId: string, approvalId: string): Promise<ReviewedApproval> {
  const read = await api.invoke('approval.get', { taskId, approvalId });
  if (!read.truncatedFields.includes('full')) return { approval: read.approval, complete: true };
  try {
    let offset = 0;
    let content = '';
    let nextOffset: number | null = offset;
    while (nextOffset !== null) {
      const chunk = await api.invoke('approval.content', { taskId, approvalId, field: 'full', offset, maxBytes: 32 * 1024 });
      content += chunk.content;
      nextOffset = chunk.nextOffset;
      if (nextOffset !== null) {
        if (nextOffset <= offset) throw new Error('Evidence paging did not advance.');
        offset = nextOffset;
      }
    }
    const approval = JSON.parse(content) as Approval;
    if (new TextEncoder().encode(content).byteLength !== read.fullBytes) throw new Error('Approval evidence byte count changed while loading.');
    if (approval.id !== approvalId || approval.taskId !== taskId || approval.nonce !== read.approval.nonce || approval.fingerprint !== read.approval.fingerprint || approval.state !== read.approval.state) throw new Error('Approval evidence changed while loading. Refresh before deciding.');
    return { approval, complete: true };
  } catch (cause) {
    return { approval: read.approval, complete: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
