import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopApi, WorkspaceEvent } from '../../../../packages/protocol/src/index';

const label = (type: string) => type.replace(/[._-]/g, ' ').replace(/\b\w/g, character => character.toUpperCase());

export function TaskActivity({ api, taskId, refreshToken, unknownOutcomes = 0 }: {
  api: DesktopApi; taskId: string; refreshToken: number; unknownOutcomes?: number;
}) {
  const [events, setEvents] = useState<WorkspaceEvent[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'decisions' | 'agents' | 'publishing'>('all');
  const selectedTask = useRef(taskId);
  selectedTask.current = taskId;
  const loadedTask = useRef<string | null>(null);
  const cursor = useRef<number | null>(null);
  const newest = useRef(0);
  const flight = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);

  const load = useCallback((older = false): Promise<void> => {
    if (flight.current) { if (!older) dirty.current = true; return flight.current; }
    const run = (async () => {
      let nextOlder = older;
      do {
        dirty.current = false;
        const target = selectedTask.current;
        const sameTask = loadedTask.current === target;
        setLoading(true);
        try {
          const page = await api.invoke('task.timeline', { taskId: target, limit: 50, ...(nextOlder && sameTask && cursor.current !== null ? { before: cursor.current } : {}) });
          if (selectedTask.current !== target) { dirty.current = true; continue; }
          const gap = sameTask && !nextOlder && page.nextBefore !== null && (page.events.at(-1)?.sequence ?? 0) > newest.current;
          setEvents(current => {
            const merged = new Map((sameTask ? current : []).map(event => [event.sequence, event]));
            for (const event of page.events) merged.set(event.sequence, event);
            return [...merged.values()].sort((a, b) => b.sequence - a.sequence);
          });
          if (!sameTask || nextOlder || gap) { cursor.current = page.nextBefore; setBefore(page.nextBefore); }
          newest.current = Math.max(sameTask ? newest.current : 0, page.events[0]?.sequence ?? 0);
          loadedTask.current = target; setError('');
        } catch (cause) { if (selectedTask.current === target) setError(cause instanceof Error ? cause.message : String(cause)); }
        nextOlder = false;
      } while (dirty.current);
    })();
    flight.current = run;
    void run.finally(() => { if (flight.current === run) { flight.current = null; setLoading(false); } });
    return run;
  }, [api]);

  useEffect(() => { setEvents([]); setBefore(null); cursor.current = null; newest.current = 0; loadedTask.current = null; void load(); }, [taskId, load]);
  useEffect(() => { void load(); }, [refreshToken, load]);

  const visible = events.filter(event => filter === 'all' || filter === 'decisions' && /approval|decision/.test(event.type) || filter === 'agents' && /child|agent|assignment|orchestration/.test(event.type) || filter === 'publishing' && /commit|push|publish|retire/.test(event.type));
  return <section className="task-activity" aria-label="Task activity">
    <h3>Activity and recovery</h3>
    {unknownOutcomes > 0 && <p role="alert" className="recovery-notice">{unknownOutcomes} outcome{unknownOutcomes === 1 ? '' : 's'} need inspection. Open Approvals or Publish to check the recorded evidence. Unknown does not mean success and is never retried automatically.</p>}
    <div className="activity-filters" role="group" aria-label="Activity filters">{(['all', 'decisions', 'agents', 'publishing'] as const).map(item => <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)}>{item.charAt(0).toUpperCase() + item.slice(1)}</button>)}</div>
    {error && <p role="alert">Could not load activity: {error} <button type="button" onClick={() => void load()}>Retry</button></p>}
    <ol className="activity-timeline">{visible.map(event => <li key={event.sequence} id={`activity-event-${event.sequence}`}><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time><strong>{label(event.type)}</strong><details><summary>Inspect evidence record {event.sequence}</summary><small>{event.legacy ? 'Legacy provenance' : `Runtime event v${event.version ?? 1}`} · Task {event.taskId ?? 'workspace'}</small><pre>{JSON.stringify(event.data, null, 2)}</pre>{Boolean(event.data && typeof event.data === 'object' && 'truncated' in event.data) && <p>Payload exceeds the timeline limit. Inspect the source operation in Approvals or Publish.</p>}</details></li>)}</ol>
    {!visible.length && !loading && !error && <p className="muted">No activity in this view yet.</p>}
    {before !== null && <button type="button" className="secondary" disabled={loading} onClick={() => void load(true)}>Older activity</button>}
    {loading && <p className="muted" role="status">Loading activity…</p>}
  </section>;
}
