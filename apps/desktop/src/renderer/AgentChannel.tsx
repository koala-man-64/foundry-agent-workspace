import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CHANNEL_LIMITS, type ChannelView, type DesktopApi } from '../../../../packages/protocol/src/index';

export function AgentChannelPanel({ api, taskId }: { api: DesktopApi; taskId: string }): React.JSX.Element {
  const [view, setView] = useState<ChannelView>();
  const [content, setContent] = useState('');
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const request = useRef<{ id: string; content: string; recipient: string } | undefined>(undefined);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    try { const next = await api.invoke('channel.get', { taskId }); if (current === version.current) { setView(next); setError(''); } }
    catch (failure) { if (current === version.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [api, taskId]);
  useEffect(() => {
    setView(undefined); setContent(''); setRecipient(''); request.current = undefined;
    void refresh();
    const unsubscribe = api.onEvent(event => { if (event.type === 'channel.changed' || event.type === 'tasks.changed' || event.type === 'task.started' || event.type === 'task.completed' || event.type === 'task.stopped') void refresh(); });
    return () => { version.current++; unsubscribe(); };
  }, [api, refresh]);
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (!content.trim() || busy) return;
    const value = content.trim();
    if (!request.current || request.current.content !== value || request.current.recipient !== recipient) request.current = { id: crypto.randomUUID(), content: value, recipient };
    const pending = request.current;
    setBusy(true); setError('');
    try {
      await api.invoke('channel.send', { taskId, requestId: pending.id, content: pending.content, recipientTaskId: pending.recipient || null });
      setContent(''); request.current = undefined; await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const more = async (agents: boolean): Promise<void> => {
    if (!view) return;
    const current = ++version.current;
    try {
      const next = await api.invoke('channel.get', { taskId, ...(agents ? { afterTaskId: view.participantsCursor ?? undefined } : { before: view.nextCursor ?? undefined }) });
      if (current !== version.current) return;
      setView(agents ? { ...view, participants: [...view.participants, ...next.participants], participantsCursor: next.participantsCursor } : { ...view, messages: next.messages, nextCursor: next.nextCursor });
      setError('');
    } catch (failure) { if (current === version.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <div className="channel-panel" data-testid="project-channel">
    <div className="channel-heading"><h3>Project channel</h3><button type="button" className="quiet" onClick={() => void refresh()}>Latest messages</button></div>
    <p className="muted">Connect agents across task chats in this project. Messages arrive between model requests or on the next turn. Sending a message does not start an idle agent.</p>
    <details><summary>Project agents ({view?.participants.length ?? 0})</summary>
      {view?.participants.map(agent => <p className="channel-agent" key={agent.taskId}><strong>{agent.title}</strong><span>{agent.role} · {agent.status}{!agent.available ? ' · unavailable' : ''}</span><code>{agent.taskId}</code></p>)}
      {view?.participantsCursor && <button type="button" onClick={() => void more(true)}>More agents</button>}
    </details>
    {error && <p role="alert" className="channel-error">{error}</p>}
    <div className="channel-messages" aria-live="polite">
      {view?.nextCursor !== null && view?.nextCursor !== undefined && <button type="button" className="quiet" onClick={() => void more(false)}>Older messages</button>}
      {view?.messages.map(message => <article className="channel-message" key={message.sequence}>
        <div><strong>{message.actor === 'user' ? `You via ${message.senderTitle}` : message.senderTitle}</strong><span>{message.recipientTaskId ? ` → ${view.participants.find(agent => agent.taskId === message.recipientTaskId)?.title ?? message.recipientTaskId}` : ' → Project'}</span></div>
        <p>{message.content}</p><small>#{message.sequence} · {new Date(message.createdAt).toLocaleString()}</small>
      </article>)}
      {view && !view.messages.length && <p className="muted">No messages on this page.</p>}
    </div>
    <form className="channel-composer" onSubmit={event => void send(event)}>
      <label>Send to<select aria-label="Channel recipient" value={recipient} disabled={busy} onChange={event => setRecipient(event.target.value)}><option value="">Project (all agents)</option>{view?.participants.filter(agent => agent.taskId !== taskId && agent.available).map(agent => <option key={agent.taskId} value={agent.taskId}>{agent.title}</option>)}</select></label>
      <label>Channel message<textarea aria-label="Channel message" value={content} maxLength={CHANNEL_LIMITS.messageBytes} disabled={busy} onChange={event => setContent(event.target.value)} placeholder="Share a finding, question or handoff…" /></label>
      <button className="primary" disabled={busy || !content.trim()}>Send to channel</button>
      <small>Posted as you. Messages do not approve actions or change agent assignments.</small>
    </form>
  </div>;
}
