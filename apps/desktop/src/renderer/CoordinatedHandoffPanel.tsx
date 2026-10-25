import { useEffect, useRef, useState } from 'react';
import type { DesktopApi } from '../../../../packages/protocol/src/index';
import { createCoordinatedHandoff } from './coordinatedHandoff';
import type { CoordinatedHandoffReport } from './coordinatedHandoff';
import { errorMessage } from './feedback';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function CoordinatedHandoffPanel({ api, rootTaskId }: { api: DesktopApi; rootTaskId: string }) {
  const [report, setReport] = useState<CoordinatedHandoffReport>();
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    setReport(undefined); setError(''); setStatus(''); setBusy(true); inFlight.current = false;
    void api.invoke('orchestration.get', { rootTaskId, runsCursor: 0 }).then(view => {
      const preview = createCoordinatedHandoff(view, rootTaskId);
      if (current === generation.current) setReport(preview);
    }).catch(reason => {
      if (current === generation.current) setError(errorMessage(reason));
    }).finally(() => { if (current === generation.current) setBusy(false); });
    return () => { ++generation.current; };
  }, [api, rootTaskId]);

  const download = async () => {
    if (inFlight.current) return;
    const current = generation.current;
    inFlight.current = true; setBusy(true); setError(''); setStatus('');
    // The preview is only a previous observation. Never use it as export authority.
    setReport(undefined);
    try {
      if (!UUID.test(rootTaskId)) throw new Error('The task identity is invalid. Reopen the coordinated task.');
      const view = await api.invoke('orchestration.get', { rootTaskId, runsCursor: 0 });
      const fresh = createCoordinatedHandoff(view, rootTaskId);
      if (current !== generation.current) return;
      setReport(fresh);
      const url = URL.createObjectURL(new Blob([JSON.stringify(fresh, null, 2) + '\n'], { type: 'application/json' }));
      const anchor = document.createElement('a');
      try {
        anchor.href = url;
        anchor.download = `coordinated-handoff-${rootTaskId.toLowerCase()}.json`;
        document.body.append(anchor);
        anchor.click();
        setStatus('Handoff report download requested. Your browser controls where the file is saved.');
      } finally {
        anchor.remove();
        // Give the browser time to consume the URL before releasing its backing data.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (reason) {
      if (current === generation.current) {
        setReport(undefined);
        setError(`Report not exported: ${errorMessage(reason)}`);
      }
    } finally {
      if (current === generation.current) { inFlight.current = false; setBusy(false); }
    }
  };

  return <section className="publish-panel" aria-label="Coordinated handoff report">
    <h3>Handoff report</h3>
    <p>This JSON report contains metadata and evidence references. It contains no Git objects, code or conversation text. Use your normal publication process to deliver the code.</p>
    <p className="muted">Every download checks the current task again. The preview is a checked snapshot; later changes can invalidate it. Coordinated commit and push remain unavailable here.</p>
    <button type="button" className="primary" disabled={busy} onClick={() => void download()}>{busy ? 'Checking current state…' : 'Download handoff report'}</button>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {report && <div className="orchestration-evidence">
      <h3>Checked report preview</h3>
      <dl><dt>Branch</dt><dd>{report.repository.branch}</dd></dl>
      <dl><dt>Commit</dt><dd>{report.repository.head}</dd></dl>
      <dl><dt>Tree</dt><dd>{report.repository.tree}</dd></dl>
      <dl><dt>Validation reference</dt><dd>{report.validation.id}</dd></dl>
      <details><summary>JSON metadata</summary><pre>{JSON.stringify(report, null, 2)}</pre></details>
    </div>}
  </section>;
}
