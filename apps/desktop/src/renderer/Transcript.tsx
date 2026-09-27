import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CompactionRecord, DesktopApi, Message } from '../../../../packages/protocol/src/index';
import type { CompactionSummary } from '../../../../packages/protocol/src/workspace';
import { compactionSlot, isCompactedMessage } from './transcriptHistory';

type DisplayMessage = Pick<Message, 'id' | 'role' | 'content' | 'createdAt'> & { status?: string; truncated?: boolean };

function MessageBody({ message, initial, api, taskId }: { message: DisplayMessage; initial: string; api?: DesktopApi; taskId?: string }) {
  const [content, setContent] = useState<string>();
  const [nextOffset, setNextOffset] = useState<number | null>(message.truncated ? 0 : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  useEffect(() => { revision.current++; setContent(undefined); setNextOffset(message.truncated ? 0 : null); setError(''); }, [message.id, message.content, message.status, message.truncated]);
  const load = async () => {
    if (!api || !taskId || nextOffset === null || loading) return;
    setLoading(true);
    const requestedRevision = revision.current;
    try {
      const chunk = await api.invoke('task.messageContent', { taskId, messageId: message.id, offset: nextOffset, maxBytes: 64 * 1024 });
      if (requestedRevision !== revision.current) return;
      setContent(previous => nextOffset === 0 ? chunk.content : `${previous ?? ''}${chunk.content}`);
      setNextOffset(chunk.nextOffset);
      setError('');
    } catch (cause) { setError(`Could not load content: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setLoading(false); }
  };
  return <><p>{content ?? initial}{nextOffset !== null && ' …'}</p>{nextOffset !== null && api && taskId && <button type="button" className="quiet" disabled={loading} onClick={() => void load()}>{loading ? 'Loading…' : content === undefined ? 'Load full message' : 'Load more content'}</button>}{error && <p role="alert">{error}</p>}</>;
}

function SummaryBody({ record, api, taskId }: { record: CompactionSummary; api?: DesktopApi; taskId?: string }) {
  const [content, setContent] = useState<string>();
  const [nextOffset, setNextOffset] = useState<number | null>(record.summaryTruncated ? 0 : null);
  const [error, setError] = useState('');
  const load = async () => {
    if (!api || !taskId || nextOffset === null) return;
    try {
      const chunk = await api.invoke('task.compactionContent', { taskId, compactionId: record.id, offset: nextOffset, maxBytes: 64 * 1024 });
      setContent(previous => nextOffset === 0 ? chunk.content : `${previous ?? ''}${chunk.content}`);
      setNextOffset(chunk.nextOffset); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <article className="message system compaction-summary"><div className="message-meta">Runtime summary <span>{record.messageCount} messages · estimate {record.estimatedTokensBefore.toLocaleString()} → {record.estimatedTokensAfter.toLocaleString()}</span></div><p>{content ?? record.summaryExcerpt}{nextOffset !== null && ' …'}</p>{nextOffset !== null && <button type="button" className="quiet" onClick={() => void load()}>{content === undefined ? 'Load full summary' : 'Load more summary'}</button>}{error && <p role="alert">Could not load summary: {error}</p>}</article>;
}

export function Transcript({ messages, compactions = [], ordinals, awaitingApproval = false, empty, api, taskId }: {
  messages: DisplayMessage[];
  compactions?: (CompactionRecord | CompactionSummary)[];
  ordinals?: ReadonlyMap<string, number>;
  awaitingApproval?: boolean;
  empty?: ReactNode;
  api?: DesktopApi;
  taskId?: string;
}) {
  const [pagedCompactions, setPagedCompactions] = useState<CompactionSummary[]>([]);
  const [olderBefore, setOlderBefore] = useState<number | null>(null);
  const [compactionError, setCompactionError] = useState('');
  const [loadingCompactions, setLoadingCompactions] = useState(false);
  const [retryCompactions, setRetryCompactions] = useState(0);
  const compactionRequest = useRef(0);
  useEffect(() => {
    const version = ++compactionRequest.current;
    setPagedCompactions([]); setOlderBefore(null); setCompactionError(''); setLoadingCompactions(false);
    if (!api || !taskId) return;
    setLoadingCompactions(true);
    void api.invoke('task.compactions', { taskId, limit: 20 }).then(page => {
      if (version !== compactionRequest.current) return;
      setPagedCompactions(page.compactions); setOlderBefore(page.nextBefore);
    }, cause => {
      if (version === compactionRequest.current) setCompactionError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (version === compactionRequest.current) setLoadingCompactions(false); });
    return () => { ++compactionRequest.current; };
  }, [api, taskId, retryCompactions]);
  const loadOlderCompactions = async () => {
    if (!api || !taskId || olderBefore === null || loadingCompactions) return;
    const version = compactionRequest.current;
    setLoadingCompactions(true);
    try {
      const page = await api.invoke('task.compactions', { taskId, before: olderBefore, limit: 20 });
      if (version !== compactionRequest.current) return;
      setPagedCompactions(current => {
        const ids = new Set(current.map(item => item.id));
        return [...current, ...page.compactions.filter(item => !ids.has(item.id))];
      });
      setOlderBefore(page.nextBefore); setCompactionError('');
    } catch (cause) { if (version === compactionRequest.current) setCompactionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (version === compactionRequest.current) setLoadingCompactions(false); }
  };
  const allCompactions = useMemo(() => {
    const byId = new Map<string, CompactionRecord | CompactionSummary>();
    for (const record of [...compactions, ...pagedCompactions]) byId.set(record.id, record);
    return [...byId.values()];
  }, [compactions, pagedCompactions]);
  const byMessage = new Map<string, CompactionRecord | CompactionSummary>();
  const slots: (CompactionRecord | CompactionSummary)[][] = Array.from({ length: messages.length + 1 }, () => []);
  for (const record of allCompactions) {
    if ('messageIds' in record) {
      for (const message of messages) if (message.status === 'complete' && record.messageIds.includes(message.id)) byMessage.set(message.id, record);
      const lastVisible = messages.reduce((last, message, index) => message.status === 'complete' && record.messageIds.includes(message.id) ? index : last, -1);
      slots[lastVisible >= 0 ? lastVisible + 1 : messages.length]!.push(record);
    } else {
      for (const message of messages) {
        if (isCompactedMessage(message, record.fromOrdinal, record.toOrdinal, ordinals)) byMessage.set(message.id, record);
      }
      slots[compactionSlot(record.toOrdinal, messages, ordinals)]!.push(record);
    }
  }
  for (const slot of slots) slot.sort((left, right) =>
    (('toOrdinal' in left ? left.toOrdinal : 0) - ('toOrdinal' in right ? right.toOrdinal : 0)) ||
    (('fromOrdinal' in left ? left.fromOrdinal : 0) - ('fromOrdinal' in right ? right.fromOrdinal : 0)) ||
    left.createdAt.localeCompare(right.createdAt));
  const summary = (record: CompactionRecord | CompactionSummary, key: string) => 'summaryExcerpt' in record
    ? <SummaryBody key={key} record={record} api={api} taskId={taskId} />
    : <article key={key} className="message system compaction-summary"><div className="message-meta">Runtime summary <span>{record.messageIds.length} messages · estimate {record.estimatedTokensBefore.toLocaleString()} → {record.estimatedTokensAfter.toLocaleString()}</span></div><p>{record.summary}</p></article>;

  return <div className="messages" aria-live="polite" aria-label="Conversation transcript">
    {slots[0]?.map(record => summary(record, record.id))}
    {messages.map((message, index) => {
      const record = byMessage.get(message.id);
      const label = message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System';
      const content = message.content || (message.status === 'streaming' ? awaitingApproval ? 'Awaiting your reviewed tool approval.' : 'Receiving response…' : '');
      return <div key={message.id}>
        <article className={`message ${message.role} ${record ? 'compacted' : ''}`} data-message-id={message.id}>
          <div className="message-meta">{label} <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>{record && <span className="compacted-tag">compacted · retained locally</span>}</div>
          <MessageBody message={message} initial={content} api={api} taskId={taskId} />
        </article>
        {slots[index + 1]?.map(item => summary(item, item.id))}
      </div>;
    })}
    {compactionError && <p role="alert">Could not load compaction history: {compactionError} <button type="button" onClick={() => { if (olderBefore !== null) void loadOlderCompactions(); else setRetryCompactions(value => value + 1); }}>Retry</button></p>}
    {olderBefore !== null && <button type="button" className="quiet" disabled={loadingCompactions} onClick={() => void loadOlderCompactions()}>{loadingCompactions ? 'Loading…' : 'Older summaries'}</button>}
    {!messages.length && !allCompactions.length && empty}
  </div>;
}
