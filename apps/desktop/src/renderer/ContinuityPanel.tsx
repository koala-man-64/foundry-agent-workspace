import { useCallback, useEffect, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import type { DesktopApi, Message, ModelProfile, Task, WorkspaceEvent } from '../../../../packages/protocol/src/index';
import type { ArtifactPreview, ContinuationPreview, ContinuityView, TranscriptExport } from '../../../../packages/protocol/src/continuity';

const decode = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));
const concatenate = (first: Uint8Array, second: Uint8Array) => { const merged = new Uint8Array(first.length + second.length); merged.set(first); merged.set(second, first.length); return merged; };
const encode = (bytes: Uint8Array) => { let value = ''; for (let offset = 0; offset < bytes.length; offset += 24_576) value += btoa(String.fromCharCode(...bytes.slice(offset, offset + 24_576))); return value; };

export function ContinuityPanel({ api, taskId, messages, profiles, onCreated, setNotice }: {
  api: DesktopApi; taskId: string; messages: Message[]; profiles: ModelProfile[];
  onCreated: (task: Task) => void; setNotice: (value: string) => void;
}) {
  const [view, setView] = useState<ContinuityView>();
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const [selectedMessages, setSelectedMessages] = useState<string[]>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [events, setEvents] = useState<WorkspaceEvent[]>([]);
  const [eventsBefore, setEventsBefore] = useState<number | null>(null);
  const [eventsError, setEventsError] = useState('');
  const [retired, setRetired] = useState(false);
  const [retainedCommit, setRetainedCommit] = useState('');
  const [supersedesId, setSupersedesId] = useState('');
  const [preview, setPreview] = useState<ContinuationPreview>();
  const [continuationTitle, setContinuationTitle] = useState('');
  const [continuationMode, setContinuationMode] = useState<'chat' | 'coding'>('chat');
  const [continuationProfile, setContinuationProfile] = useState(profiles[0]?.id ?? '');
  const [continuationBudget, setContinuationBudget] = useState(100000);
  const [artifactPath, setArtifactPath] = useState('');
  const [artifact, setArtifact] = useState<ArtifactPreview>();
  const [artifactBytes, setArtifactBytes] = useState<Uint8Array>();
  const [imageUrl, setImageUrl] = useState('');
  const [exportResult, setExportResult] = useState<TranscriptExport>();
  const [includeChildren, setIncludeChildren] = useState(true);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try { setView(await api.invoke('continuity.get', { taskId })); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [api, taskId]);
  useEffect(() => {
    let cancelled = false;
    setView(undefined); setPreview(undefined); setSelectedMessages([]); setSelectedEvidence([]); setEvents([]); setRetainedCommit('');
    setArtifact(undefined); setArtifactBytes(undefined); void reload();
    void Promise.all([api.invoke('task.timeline', { taskId, limit: 50 }), api.invoke('task.read', { taskId })]).then(([page, read]) => {
      if (cancelled) return;
      setEvents(page.events); setEventsBefore(page.nextBefore); setRetired(read.task.status === 'retired'); setEventsError('');
    }, cause => { if (!cancelled) setEventsError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [api, taskId, reload]);
  const loadOlderEvents = async () => {
    if (eventsBefore === null) return;
    try {
      const page = await api.invoke('task.timeline', { taskId, before: eventsBefore, limit: 50 });
      setEvents(current => [...current, ...page.events.filter(item => !current.some(known => known.sequence === item.sequence))]);
      setEventsBefore(page.nextBefore); setEventsError('');
    } catch (cause) { setEventsError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => {
    if (!artifact || !artifactBytes || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(artifact.mimeType) || artifact.nextOffset !== null) { setImageUrl(''); return; }
    setImageUrl(`data:${artifact.mimeType};base64,${encode(artifactBytes)}`);
  }, [artifact, artifactBytes]);

  const saveDecision = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true);
    try { await api.invoke('decision.save', { taskId, title: title.trim(), rationale: rationale.trim(), messageIds: selectedMessages, evidenceIds: selectedEvidence, supersedesId: supersedesId || null }); setTitle(''); setRationale(''); setSupersedesId(''); await reload(); }
    catch (cause) { setNotice(`Could not save decision: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  };
  const loadOlderDecisions = async () => {
    if (!view?.nextBefore) return;
    try { const page = await api.invoke('continuity.get', { taskId, before: view.nextBefore }); setView(current => current && { ...current, decisions: [...current.decisions, ...page.decisions], nextBefore: page.nextBefore }); }
    catch (cause) { setError(`Could not load older decisions: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  const loadMoreLineage = async () => {
    if (!view?.nextLineage) return;
    try { const page = await api.invoke('continuity.get', { taskId, lineageAfter: view.nextLineage }); setView(current => current && { ...current, lineage: [...current.lineage, ...page.lineage], nextLineage: page.nextLineage }); }
    catch (cause) { setError(`Could not load more lineage: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  const previewContinuation = async () => {
    setBusy(true);
    try { setPreview(await api.invoke('task.continuationPreview', { taskId, messageIds: selectedMessages, evidenceIds: selectedEvidence, ...(retired && retainedCommit.trim() ? { sourceCommit: retainedCommit.trim() } : {}) })); }
    catch (cause) { setNotice(`Could not prepare continuation: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  };
  const createContinuation = async () => {
    if (!preview || busy) return; setBusy(true);
    try { const task = await api.invoke('task.continue', { previewId: preview.id, title: continuationTitle.trim(), profileId: continuationProfile, tokenBudget: continuationBudget, mode: continuationMode }); setPreview(undefined); onCreated(task); }
    catch (cause) { setNotice(`Could not create continuation: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  };
  const inspectArtifact = async () => {
    setBusy(true);
    try { const result = await api.invoke('artifact.preview', { taskId, path: artifactPath.trim() }); setArtifact(result); setArtifactBytes(decode(result.content)); }
    catch (cause) { setNotice(`Could not preview artifact: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  };
  const loadArtifact = async () => {
    if (!artifact || artifact.nextOffset === null || !artifactBytes) return; setBusy(true);
    try { const chunk = await api.invoke('artifact.chunk', { previewId: artifact.id, offset: artifact.nextOffset }); setArtifactBytes(concatenate(artifactBytes, decode(chunk.content))); setArtifact({ ...artifact, nextOffset: chunk.nextOffset }); }
    catch (cause) { setNotice(`Could not load more artifact content: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  };
  const exportTranscript = async () => {
    setBusy(true);
    try { setExportResult(await api.invoke('task.exportTranscript', { taskId, includeChildren })); }
    catch (cause) { setNotice(`Could not export transcript: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  };
  const text = artifactBytes && artifact && !artifact.mimeType.startsWith('image/') ? new TextDecoder().decode(artifactBytes) : '';

  return <section className="continuity-panel" aria-label="Continuity and artifacts">
    <h3>Decisions and lineage</h3>{error && <p role="alert">{error} <button type="button" onClick={() => void reload()}>Retry</button></p>}
    {!view && !error && <p role="status">Loading decisions…</p>}
    {view?.decisions.map(card => <article className="automation-card" key={card.id}><strong>{card.title}{card.superseded ? ' · superseded' : ''}</strong><small>{new Date(card.createdAt).toLocaleString()} · {card.messageIds.length} message citation(s) · {card.evidenceIds.length} evidence citation(s)</small><p>{card.rationale}</p></article>)}
    {view && !view.decisions.length && <p className="muted">No decisions recorded. Add one with a reason and cited messages.</p>}
    {view?.nextBefore && <button type="button" className="secondary" onClick={() => void loadOlderDecisions()}>Older decisions</button>}
    <form className="automation-form" onSubmit={saveDecision}><label>Decision title <input required value={title} onChange={event => setTitle(event.target.value)} /></label><label>Reason <textarea required value={rationale} onChange={event => setRationale(event.target.value)} /></label><label>Supersedes <select value={supersedesId} onChange={event => setSupersedesId(event.target.value)}><option value="">No earlier decision</option>{view?.decisions.filter(card => !card.superseded).map(card => <option key={card.id} value={card.id}>{card.title}</option>)}</select></label><button className="primary" disabled={busy}>Save decision</button></form>
    <h3>Selected conversation context</h3><p className="muted">Select up to 50 retained messages for a decision citation or a new task. No approval or unknown effect carries over.</p>
    <div className="context-messages">{messages.slice(-50).map(message => <label className="checkbox-row" key={message.id}><input type="checkbox" checked={selectedMessages.includes(message.id)} onChange={event => setSelectedMessages(current => event.target.checked ? [...current, message.id].slice(0, 50) : current.filter(id => id !== message.id))} />{message.role}: {message.content.slice(0, 140)}</label>)}</div>
    <h3>Event evidence</h3><p className="muted">Select up to 50 retained event references. Event details stay in the activity timeline.</p>
    {eventsError && <p role="alert">Could not load events: {eventsError} <button type="button" onClick={() => void loadOlderEvents()}>Retry</button></p>}
    <div className="context-messages">{events.map(item => { const id = `event:${item.sequence}`; return <label className="checkbox-row" key={id}><input type="checkbox" checked={selectedEvidence.includes(id)} onChange={event => setSelectedEvidence(current => event.target.checked ? [...current, id].slice(0, 50) : current.filter(value => value !== id))} />{item.type} · {new Date(item.createdAt).toLocaleString()} · #{item.sequence}</label>; })}</div>
    {eventsBefore !== null && <button type="button" className="secondary" onClick={() => void loadOlderEvents()}>Older events</button>}
    {retired && <label>Retained local source commit (optional) <input value={retainedCommit} pattern="[a-fA-F0-9]{40}" title="40-character Git commit SHA" onChange={event => setRetainedCommit(event.target.value)} placeholder="40-character Git commit SHA" /></label>}
    <h3>Continue in a new task</h3><button type="button" className="secondary" disabled={busy || Boolean(retired && retainedCommit.trim() && !/^[a-fA-F0-9]{40}$/.test(retainedCommit.trim()))} onClick={() => void previewContinuation()}>Preview selected context and Git base</button>
    {preview && <div className="continuation-preview"><p>Source commit {preview.sourceCommit} · {preview.bytes.toLocaleString()} bytes · expires {new Date(preview.expiresAt).toLocaleTimeString()}</p>{preview.warnings.map((warning, index) => <p className="recovery-notice" key={index}>{warning}</p>)}<pre>{preview.context}</pre><label>New task title <input required value={continuationTitle} onChange={event => setContinuationTitle(event.target.value)} /></label><label>Profile <select value={continuationProfile} onChange={event => setContinuationProfile(event.target.value)}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label>Mode <select value={continuationMode} onChange={event => setContinuationMode(event.target.value as typeof continuationMode)}><option value="chat">Chat</option><option value="coding">Coding</option></select></label><label>Token budget <input type="number" min={1024} max={10000000} value={continuationBudget} onChange={event => setContinuationBudget(Number(event.target.value))} /></label><button type="button" className="primary" disabled={busy || !continuationTitle.trim() || !continuationProfile} onClick={() => void createContinuation()}>Create new task from preview</button></div>}
    <h3>Related tasks</h3>{view?.lineage.map(item => <article className="automation-card" key={`${item.sourceTaskId}-${item.taskId}`}><strong>Continued from {item.sourceTaskId.slice(0, 8)}</strong><small>Commit {item.sourceCommit.slice(0, 10)} · {item.messageIds.length} selected messages</small></article>)}{view?.nextLineage && <button type="button" className="secondary" onClick={() => void loadMoreLineage()}>More related tasks</button>}
    <h3>Artifact preview</h3><p className="muted">Read-only local preview of a bounded text, Markdown or image file. HTML and remote media are not executed.</p><label>Repository path <input value={artifactPath} onChange={event => setArtifactPath(event.target.value)} placeholder="docs/notes.md" /></label><button type="button" className="secondary" disabled={busy || !artifactPath.trim()} onClick={() => void inspectArtifact()}>Preview artifact</button>
    {artifact && <div className="artifact-preview"><strong>{artifact.path}</strong><small>{artifact.mimeType} · {artifact.bytes.toLocaleString()} bytes · SHA-256 {artifact.sha256.slice(0, 12)}…</small>{imageUrl ? <img src={imageUrl} alt={`Preview of ${artifact.path}`} /> : artifact.mimeType === 'text/markdown' ? <div className="markdown-preview"><ReactMarkdown skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>{alt}</span> }}>{text}</ReactMarkdown></div> : <pre>{text}</pre>}{artifact.nextOffset !== null && <button type="button" className="secondary" disabled={busy} onClick={() => void loadArtifact()}>Load more content</button>}</div>}
    <h3>Transcript export</h3><label className="checkbox-row"><input type="checkbox" checked={includeChildren} onChange={event => setIncludeChildren(event.target.checked)} />Include child conversations</label><button type="button" className="secondary" disabled={busy} onClick={() => void exportTranscript()}>Export redacted transcript</button>{exportResult && <p role="status">Exported {exportResult.messageCount} messages to {exportResult.path}. {exportResult.files.map(file => `${file.name}: ${file.sha256.slice(0, 12)}…`).join('; ')}</p>}
  </section>;
}
