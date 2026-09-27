import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { DesktopApi } from '../../../../packages/protocol/src/index';
import type { AutomationDraft, AutomationPage, AutomationView, HookRule, Schedule, ScriptRegistration, ScriptRevision } from '../../../../packages/protocol/src/automation';
import type { FeatureName, FeatureSnapshot } from '../../../../packages/protocol/src/features';

const triggers = ['task.started', 'task.completed', 'task.stopped', 'approval.changed'] as const;
const scriptInputFields = ['sequence', 'type', 'taskId', 'createdAt', 'projectPath', 'title', 'status', 'approvalId', 'approvalState'] as const;
const defaultScriptFields: ScriptRegistration['inputFields'] = ['sequence', 'type', 'taskId', 'createdAt', 'projectPath', 'title', 'status'];
const defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const dateInZone = (value: Date, timeZone: string) => {
  const parts = Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

export function AutomationSettings({ api, onDraft, onPrepared, setNotice }: {
  api: DesktopApi;
  onDraft: (draft: AutomationDraft) => void;
  onPrepared?: (draft: AutomationDraft, approvalId: string) => void;
  setNotice: (message: string) => void;
}) {
  const [view, setView] = useState<AutomationView>();
  const [features, setFeatures] = useState<FeatureSnapshot>();
  const [featureError, setFeatureError] = useState('');
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationError, setNotificationError] = useState('');
  const [historyKind, setHistoryKind] = useState<AutomationPage['kind']>('runs');
  const [history, setHistory] = useState<AutomationPage>();
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ruleName, setRuleName] = useState('');
  const [ruleTrigger, setRuleTrigger] = useState<typeof triggers[number]>('task.completed');
  const [ruleAction, setRuleAction] = useState<HookRule['action']>('notification');
  const [ruleTitle, setRuleTitle] = useState('');
  const [ruleBody, setRuleBody] = useState('');
  const [ruleTaskId, setRuleTaskId] = useState('');
  const [ruleProjectPath, setRuleProjectPath] = useState('');
  const [ruleMode, setRuleMode] = useState<'' | 'chat' | 'coding' | 'coordinated'>('');
  const [ruleStatus, setRuleStatus] = useState('');
  const [ruleTool, setRuleTool] = useState<'run_command' | 'write_file'>('run_command');
  const [ruleArguments, setRuleArguments] = useState('{"command":"Write-Output reviewed","cwd":"","timeoutMs":30000}');
  const [previewTaskId, setPreviewTaskId] = useState('');
  const [previewResult, setPreviewResult] = useState('');
  const [scriptName, setScriptName] = useState('');
  const [scriptLanguage, setScriptLanguage] = useState<'powershell' | 'javascript'>('powershell');
  const [scriptSource, setScriptSource] = useState('');
  const [scriptCwd, setScriptCwd] = useState('');
  const [scriptTrigger, setScriptTrigger] = useState<typeof triggers[number]>('task.completed');
  const [scriptProjectPath, setScriptProjectPath] = useState('');
  const [scriptArguments, setScriptArguments] = useState('[]');
  const [scriptInput, setScriptInput] = useState<ScriptRegistration['inputFields']>(defaultScriptFields);
  const [scriptTimeoutSeconds, setScriptTimeoutSeconds] = useState(30);
  const [scriptEditingId, setScriptEditingId] = useState<string>();
  const [review, setReview] = useState<{ revision: ScriptRevision; source: string; registration: Omit<ScriptRegistration, 'source'> }>();
  const reviewDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (review && reviewDialogRef.current && !reviewDialogRef.current.open) {
      reviewDialogRef.current.showModal();
      reviewDialogRef.current.querySelector<HTMLInputElement>('input')?.focus();
    }
  }, [review]);
  const closeReview = () => { reviewDialogRef.current?.close(); setReview(undefined); };
  const trapReviewTab = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')]
      .filter(control => !control.disabled && control.tabIndex >= 0);
    const first = controls[0]; const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const [grantDays, setGrantDays] = useState(30);
  const [grantDaily, setGrantDaily] = useState(100);
  const [scheduleName, setScheduleName] = useState('');
  const [scheduleTitle, setScheduleTitle] = useState('');
  const [scheduleBody, setScheduleBody] = useState('');
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [scheduleCadence, setScheduleCadence] = useState<Schedule['cadence']>('once');
  const [scheduleKind, setScheduleKind] = useState<Schedule['kind']>('reminder');
  const [scheduleTaskId, setScheduleTaskId] = useState('');
  const [scheduleProjectPath, setScheduleProjectPath] = useState('');
  const [scheduleTimeZone, setScheduleTimeZone] = useState(defaultZone);
  const [scheduleDate, setScheduleDate] = useState(dateInZone(new Date(), defaultZone));
  const [scheduleWeekDay, setScheduleWeekDay] = useState(new Date().getDay());
  const [scheduleEditingId, setScheduleEditingId] = useState<string>();
  const reviewedRegistration = review?.registration ?? (review ? (
    view?.scripts.find(item => item.revision.id === review.revision.id) ??
    history?.items.find((item): item is AutomationView['scripts'][number] => 'registration' in item && item.revision.id === review.revision.id)
  )?.registration : undefined);

  const reload = useCallback(async () => {
    try { setView(await api.invoke('automation.list', {})); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    try { setFeatures(await api.invoke('features.get', {})); setFeatureError(''); }
    catch (cause) { setFeatureError(cause instanceof Error ? cause.message : String(cause)); }
    try { setNotificationsEnabled((await api.notificationPreferences()).enabled); setNotificationError(''); }
    catch (cause) { setNotificationError(cause instanceof Error ? cause.message : String(cause)); }
  }, [api]);
  const toggleFeature = async (feature: FeatureName, enabled: boolean) => {
    try { await api.invoke('features.set', { feature, enabled, ...(!enabled ? { reason: 'user-paused' as const } : {}) }); await reload(); }
    catch (cause) { setFeatureError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { void reload(); return () => setReview(undefined); }, [reload]);
  useEffect(() => { setHistory(undefined); void loadHistory(historyKind); }, [api, historyKind]);

  async function loadHistory(kind: AutomationPage['kind'], before?: number) {
    if (historyBusy && before !== undefined) return;
    setHistoryBusy(true);
    try {
      const page = await api.invoke('automation.query', { kind, before, limit: 20 });
      setHistory(previous => before !== undefined && previous?.kind === kind ? { ...page, items: [...previous.items, ...page.items] } : page);
      setHistoryError('');
    } catch (cause) { setHistoryError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setHistoryBusy(false); }
  }

  const createRule = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true);
    try {
      const proposal = ruleAction === 'actionDraft' ? { tool: ruleTool, arguments: JSON.parse(ruleArguments) as Record<string, unknown> } : undefined;
      await api.invoke('automation.rule.save', { id: crypto.randomUUID(), version: 1, name: ruleName.trim(), enabled: true, triggers: [ruleTrigger], projectPath: ruleProjectPath.trim() || null, ...(ruleTaskId.trim() ? { taskId: ruleTaskId.trim() } : {}), ...(ruleMode || ruleStatus ? { conditions: { ...(ruleMode ? { mode: ruleMode } : {}), ...(ruleStatus ? { status: ruleStatus as 'running' | 'idle' | 'failed' } : {}) } } : {}), action: ruleAction, title: ruleTitle.trim(), body: ruleBody, ...(proposal ? { proposal } : {}) });
      setRuleName(''); setRuleTitle(''); setRuleBody(''); setRuleProjectPath(''); await reload();
    } catch (cause) { setNotice(`Could not save rule: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  };
  const previewRule = async (rule: HookRule) => {
    try {
      const result = await api.invoke('automation.rule.preview', { ruleId: rule.id, taskId: previewTaskId.trim() || rule.taskId || '', eventType: rule.triggers[0] ?? 'task.started' });
      setPreviewResult(`${rule.name}: ${result.matches ? 'matches' : 'does not match'}${result.reason ? ` — ${result.reason}` : ''}${result.draftPreview ? `; would prepare ${result.draftPreview.kind} “${result.draftPreview.title}”` : ''}`);
    } catch (cause) { setPreviewResult(`Could not preview ${rule.name}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  const registerScript = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true);
    try {
      const source = scriptSource;
      const argumentsValue: unknown = JSON.parse(scriptArguments);
      if (!Array.isArray(argumentsValue) || argumentsValue.length > 16 || argumentsValue.some(item => typeof item !== 'string' || item.length > 512)) throw new Error('Arguments must be a JSON array of at most 16 strings, each at most 512 characters.');
      if (!Number.isInteger(scriptTimeoutSeconds) || scriptTimeoutSeconds < 1 || scriptTimeoutSeconds > 120) throw new Error('Timeout must be 1–120 seconds.');
      const registration: ScriptRegistration = { id: scriptEditingId ?? crypto.randomUUID(), name: scriptName.trim(), language: scriptLanguage, source, triggers: [scriptTrigger], projectPath: scriptProjectPath.trim() || null, arguments: argumentsValue as string[], cwd: scriptCwd.trim(), inputFields: scriptInput, timeoutMs: scriptTimeoutSeconds * 1000 };
      const revision = await api.invoke('automation.script.register', registration);
      const { source: _source, ...reviewRegistration } = registration;
      cancelScriptEdit();
      setReview({ source, revision, registration: reviewRegistration }); await reload();
    } catch (cause) { setNotice(`Could not register script: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  };
  const cancelScriptEdit = () => {
    setScriptEditingId(undefined); setScriptSource(''); setScriptName(''); setScriptCwd(''); setScriptProjectPath('');
    setScriptArguments('[]'); setScriptInput(defaultScriptFields); setScriptTimeoutSeconds(30); setScriptLanguage('powershell'); setScriptTrigger('task.completed');
  };
  const editScript = async (item: AutomationView['scripts'][number]) => {
    try {
      const source = await api.invoke('automation.script.source', { revisionId: item.revision.id });
      setScriptEditingId(item.registration.id); setScriptName(item.registration.name); setScriptLanguage(item.registration.language);
      setScriptSource(source.source); setScriptCwd(item.registration.cwd); setScriptProjectPath(item.registration.projectPath ?? '');
      setScriptTrigger(item.registration.triggers[0] ?? 'task.completed'); setScriptArguments(JSON.stringify(item.registration.arguments));
      setScriptInput(item.registration.inputFields); setScriptTimeoutSeconds(item.registration.timeoutMs / 1000);
    } catch (cause) { setNotice(`Could not load script revision: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  const openReview = async (revisionId: string) => {
    try {
      const registration = view?.scripts.find(item => item.revision.id === revisionId)?.registration ?? history?.items.find((item): item is AutomationView['scripts'][number] => 'registration' in item && item.revision.id === revisionId)?.registration;
      if (!registration) throw new Error('Script configuration is unavailable; refresh history before granting trust.');
      setReview({ ...await api.invoke('automation.script.source', { revisionId }), registration });
    }
    catch (cause) { setNotice(`Could not load pinned script: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  const grant = async () => {
    if (!review || busy) return; setBusy(true);
    try {
      await api.invoke('automation.script.grant', { revisionId: review.revision.id, expiresAt: inDays(grantDays), maxRunsPer24h: grantDaily });
      closeReview(); await reload();
    } catch (cause) { setNotice(`Could not grant script trust: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  };
  const createSchedule = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: scheduleTimeZone.trim() });
      const linkedTask = scheduleTaskId.trim() ? await api.invoke('task.read', { taskId: scheduleTaskId.trim() }) : null;
      const projectPath = (linkedTask?.task.projectPath ?? scheduleProjectPath.trim()) || null;
      await api.invoke('automation.schedule.save', { id: scheduleEditingId ?? crypto.randomUUID(), name: scheduleName.trim(), enabled: true, projectPath, taskId: scheduleTaskId.trim() || null, kind: scheduleKind, title: scheduleTitle.trim(), body: scheduleBody, cadence: scheduleCadence, localTime: scheduleTime, timeZone: scheduleTimeZone.trim(), startDate: scheduleDate, startAt: new Date().toISOString(), weekDay: scheduleCadence === 'weekly' ? scheduleWeekDay : null });
      setScheduleEditingId(undefined); setScheduleName(''); setScheduleTitle(''); setScheduleBody(''); setScheduleTaskId(''); setScheduleProjectPath(''); await reload();
    } catch (cause) { setNotice(`Could not save follow-up: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(false); }
  };
  const editSchedule = (item: Schedule) => {
    setScheduleEditingId(item.id); setScheduleName(item.name); setScheduleTitle(item.title); setScheduleBody(item.body);
    setScheduleTaskId(item.taskId ?? ''); setScheduleProjectPath(item.projectPath ?? ''); setScheduleKind(item.kind);
    setScheduleCadence(item.cadence); setScheduleTime(item.localTime); setScheduleTimeZone(item.timeZone);
    setScheduleDate(item.startDate ?? dateInZone(new Date(item.startAt), item.timeZone));
    setScheduleWeekDay(item.weekDay ?? new Date().getDay());
  };
  const prepareDraft = async (draft: AutomationDraft) => {
    try {
      const result = await api.invoke('automation.draft.prepare', { draftId: draft.id });
      await reload();
      onPrepared?.(draft, result.approvalId);
    } catch (cause) { setNotice(`Could not prepare approval: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };

  return <section className="automation-settings" aria-label="Hooks and follow-ups">
    <div className="dialog-head"><div><p className="eyebrow">PERSONAL WORKSPACE</p><h2>Hooks and follow-ups</h2></div><button type="button" className="secondary" onClick={() => void reload()}>Refresh</button></div>
    <p className="probe-note">Rules observe recorded events and prepare local notifications or drafts. Drafts never send themselves. Scripts run only after an explicit reusable trust grant for a pinned revision; execution uses your Windows privileges and is not sandboxed.</p>
    <section aria-label="Feature controls"><h3>Workspace controls</h3><p className="muted">Pause a feature without deleting its saved records. Restore remains available when archiving is paused; hooks and follow-ups remain visible in history.</p>{featureError && <p role="alert">Could not load feature controls: {featureError}</p>}{features?.features.map(item => <div className="automation-card" key={item.feature}><strong>{item.feature === 'archive' ? 'Conversation archive' : item.feature === 'hooks' ? 'Hooks' : 'App-open follow-ups'}</strong><small>{item.enabled ? 'Enabled' : `Paused${item.reason ? ` · ${item.reason}` : ''}`}</small><button type="button" className="secondary" onClick={() => void toggleFeature(item.feature, !item.enabled)}>{item.enabled ? 'Pause' : 'Re-enable'}</button></div>)}<label className="checkbox-row"><input type="checkbox" checked={notificationsEnabled} onChange={event => { const enabled = event.target.checked; void api.setNotificationsEnabled(enabled).then(result => { setNotificationsEnabled(result.enabled); setNotificationError(''); }, cause => setNotificationError(cause instanceof Error ? cause.message : String(cause))); }} />Desktop notifications</label><p className="muted">Optional local alerts for approvals, completion and failures. Inbox remains the durable record, including after restart.</p>{notificationError && <p role="alert">Could not update notifications: {notificationError}</p>}</section>
    {error && <p role="alert">Could not load automations: {error} <button type="button" onClick={() => void reload()}>Retry</button></p>}
    {!view && !error && <p role="status">Loading hooks and follow-ups…</p>}
    {view?.truncated && <p role="status">The overview shows the newest 20 records per kind. Browse older records below.</p>}
    <div className="automation-columns">
      <section><h3>Built-in rules</h3><p className="muted">Pure local notification and draft rules need no script trust.</p>
        <label>Preview against task ID <input value={previewTaskId} onChange={event => setPreviewTaskId(event.target.value)} placeholder="Task UUID" /></label>
        {previewResult && <p role="status">{previewResult}</p>}
        {view?.rules.map(rule => <article className="automation-card" key={rule.id}><strong>{rule.name}</strong><small>{rule.triggers.join(', ')} · {rule.action} · {rule.enabled ? 'Enabled' : 'Disabled'}</small><p>{rule.title}</p><div className="approval-actions"><button type="button" className="secondary" onClick={() => void previewRule(rule)}>Preview match</button><button type="button" className="secondary" disabled={busy} onClick={() => void api.invoke('automation.rule.save', { ...rule, version: rule.version + 1, enabled: !rule.enabled }).then(reload, cause => setNotice(String(cause)))}>{rule.enabled ? 'Disable' : 'Enable'}</button><button type="button" className="danger" disabled={busy} onClick={() => void api.invoke('automation.rule.remove', { ruleId: rule.id }).then(reload, cause => setNotice(String(cause)))}>Remove</button></div></article>)}
        <form className="automation-form" onSubmit={createRule}>
          <label>Rule name <input required value={ruleName} onChange={event => setRuleName(event.target.value)} /></label>
          <label>When <select value={ruleTrigger} onChange={event => setRuleTrigger(event.target.value as typeof ruleTrigger)}>{triggers.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>Task ID scope (optional) <input value={ruleTaskId} onChange={event => setRuleTaskId(event.target.value)} /></label>
          <label>Project path scope (optional; blank means all projects) <input value={ruleProjectPath} onChange={event => setRuleProjectPath(event.target.value)} /></label>
          <label>Mode condition <select value={ruleMode} onChange={event => setRuleMode(event.target.value as typeof ruleMode)}><option value="">Any</option><option value="chat">Chat</option><option value="coding">Coding</option><option value="coordinated">Coordinated</option></select></label>
          <label>Status condition <select value={ruleStatus} onChange={event => setRuleStatus(event.target.value)}><option value="">Any</option><option value="idle">Ready</option><option value="running">Working</option><option value="failed">Failed</option></select></label>
          <label>Prepare <select value={ruleAction} onChange={event => setRuleAction(event.target.value as HookRule['action'])}><option value="notification">Notification</option><option value="label">Evidence label</option><option value="promptDraft">Prompt draft</option><option value="actionDraft">Action draft</option></select></label>
          <label>Title <input required value={ruleTitle} onChange={event => setRuleTitle(event.target.value)} /></label><label>Body <textarea value={ruleBody} onChange={event => setRuleBody(event.target.value)} /></label>
          {ruleAction === 'actionDraft' && <><p className="muted">An action draft only prepares a proposal. Review it later through the ordinary approval panel before any command or file write.</p><label>Proposed tool <select value={ruleTool} onChange={event => setRuleTool(event.target.value as typeof ruleTool)}><option value="run_command">Command</option><option value="write_file">Existing-file edit</option></select></label><label>Tool arguments (JSON) <textarea required value={ruleArguments} onChange={event => setRuleArguments(event.target.value)} /></label></>}
          <button className="primary" disabled={busy}>Save rule</button>
        </form>
      </section>
      <section><h3>Pinned scripts</h3><p className="muted">Register source, inspect the copied revision, then grant trust. A new revision is untrusted. Event selection limits when a script runs; it does not limit filesystem or network effects.</p>
        {view?.scripts.map(item => <article className="automation-card" key={item.revision.id}><strong>{item.registration.name}</strong><small>{item.registration.language} · {item.revision.sha256.slice(0, 12)}… · {item.revision.trusted ? 'Trusted' : 'Untrusted'}</small><p>{item.registration.triggers.join(', ')} · {item.registration.projectPath ?? 'All projects'} · {item.registration.cwd || 'App working directory'}</p><div className="approval-actions"><button type="button" className="secondary" onClick={() => void openReview(item.revision.id)}>Review source and grant</button><button type="button" className="secondary" disabled={busy} onClick={() => void editScript(item)}>Create new revision</button>{item.revision.trusted && <button type="button" className="danger" onClick={() => void api.invoke('automation.script.revoke', { revisionId: item.revision.id }).then(reload, cause => setNotice(String(cause)))}>Revoke</button>}</div></article>)}
        <form className="automation-form" onSubmit={registerScript}><h4>{scriptEditingId ? 'Create new untrusted revision' : 'Register new script'}</h4><label>Script name <input required value={scriptName} onChange={event => setScriptName(event.target.value)} /></label><label>Language <select value={scriptLanguage} onChange={event => setScriptLanguage(event.target.value as typeof scriptLanguage)}><option value="powershell">PowerShell (.ps1)</option><option value="javascript">JavaScript (.js)</option></select></label><label>When <select value={scriptTrigger} onChange={event => setScriptTrigger(event.target.value as typeof scriptTrigger)}>{triggers.map(item => <option key={item} value={item}>{item}</option>)}</select></label><label>Project path scope (optional; blank means all projects) <input value={scriptProjectPath} onChange={event => setScriptProjectPath(event.target.value)} /></label><label>Working directory (absolute) <input required value={scriptCwd} onChange={event => setScriptCwd(event.target.value)} /></label><label>Arguments (JSON array of strings) <textarea required value={scriptArguments} onChange={event => setScriptArguments(event.target.value)} /></label><label>Timeout (seconds) <input type="number" required min={1} max={120} step={1} value={scriptTimeoutSeconds} onChange={event => setScriptTimeoutSeconds(Number(event.target.value))} /></label><fieldset><legend>Event input fields</legend>{scriptInputFields.map(field => <label className="checkbox-row" key={field}><input type="checkbox" checked={scriptInput.includes(field)} onChange={event => setScriptInput(current => event.target.checked ? [...current, field] : current.filter(item => item !== field))} />{field}</label>)}</fieldset><label>Script source <textarea required value={scriptSource} onChange={event => setScriptSource(event.target.value)} placeholder="Paste source code; do not include credentials." /></label><p className="muted">The runtime selects and pins the interpreter. Scope and input fields do not sandbox script effects.</p><button className="primary" disabled={busy}>{scriptEditingId ? 'Register replacement revision' : 'Register untrusted revision'}</button>{scriptEditingId && <button type="button" className="secondary" onClick={cancelScriptEdit}>Cancel revision</button>}</form>
      </section>
      <section><h3>App-open follow-ups</h3><p className="muted">Due reminders appear while the app is open or on the next open. Prompt drafts require you to press Send; no model call runs automatically.</p>
        {view?.schedules.map(item => <article className="automation-card" key={item.id}><strong>{item.name}</strong><small>{item.cadence} at {item.localTime} {item.timeZone} · from {item.startDate ?? item.startAt.slice(0, 10)} · {item.enabled ? 'Enabled' : 'Disabled'}</small><p>{item.title}</p><div className="approval-actions"><button type="button" className="secondary" onClick={() => editSchedule(item)}>Edit</button><button type="button" className="secondary" onClick={() => void api.invoke('automation.schedule.save', { ...item, enabled: !item.enabled }).then(reload, cause => setNotice(String(cause)))}>{item.enabled ? 'Disable' : 'Enable'}</button><button type="button" className="danger" onClick={() => void api.invoke('automation.schedule.remove', { scheduleId: item.id }).then(reload, cause => setNotice(String(cause)))}>Remove</button></div></article>)}
        <form className="automation-form" onSubmit={createSchedule}>
          <h4>{scheduleEditingId ? 'Edit follow-up' : 'New follow-up'}</h4>
          <label>Name <input required value={scheduleName} onChange={event => setScheduleName(event.target.value)} /></label>
          <label>Title <input required value={scheduleTitle} onChange={event => setScheduleTitle(event.target.value)} /></label>
          <label>Follow-up text <textarea value={scheduleBody} onChange={event => setScheduleBody(event.target.value)} /></label>
          <label>Task ID (optional) <input value={scheduleTaskId} onChange={event => setScheduleTaskId(event.target.value)} /></label>
          <label>Project path (optional) <input value={scheduleProjectPath} onChange={event => setScheduleProjectPath(event.target.value)} disabled={Boolean(scheduleTaskId.trim())} /></label>
          <p className="muted">For a linked task, its current project path is read and saved automatically.</p>
          <label>Kind <select value={scheduleKind} onChange={event => setScheduleKind(event.target.value as Schedule['kind'])}><option value="reminder">Reminder</option><option value="promptDraft">Prompt draft</option></select></label>
          <label>Cadence <select value={scheduleCadence} onChange={event => setScheduleCadence(event.target.value as Schedule['cadence'])}><option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
          <label>Start date <input type="date" required value={scheduleDate} onChange={event => setScheduleDate(event.target.value)} /></label>
          {scheduleCadence === 'weekly' && <label>Weekday <select value={scheduleWeekDay} onChange={event => setScheduleWeekDay(Number(event.target.value))}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
          <label>Local time <input type="time" required value={scheduleTime} onChange={event => setScheduleTime(event.target.value)} /></label>
          <label>Time zone (IANA) <input required value={scheduleTimeZone} onChange={event => setScheduleTimeZone(event.target.value)} placeholder="America/Chicago" /></label>
          <button className="primary" disabled={busy}>{scheduleEditingId ? 'Save changes' : 'Save follow-up'}</button>
          {scheduleEditingId && <button type="button" className="secondary" onClick={() => setScheduleEditingId(undefined)}>Cancel edit</button>}
        </form>
      </section>
    </div>
    <section><h3>Prepared drafts</h3>{view?.drafts.map(draft => <article className="automation-card" key={draft.id}><strong>{draft.title}</strong><small>{draft.source} · {draft.kind} · {draft.state}</small><p>{draft.body}</p>{draft.proposal && <p className="muted">Proposed {draft.proposal.tool}; its full arguments appear in the ordinary approval review.</p>}<div className="approval-actions">{draft.state === 'open' && draft.kind === 'promptDraft' && <button type="button" className="primary" onClick={() => onDraft(draft)}>Use prompt draft</button>}{draft.state === 'open' && draft.kind === 'actionDraft' && draft.proposal && draft.taskId && <button type="button" className="primary" onClick={() => void prepareDraft(draft)}>Review proposed action</button>}{draft.state === 'open' && <button type="button" className="secondary" onClick={() => void api.invoke('automation.draft.dismiss', { draftId: draft.id }).then(reload, cause => setNotice(String(cause)))}>Dismiss</button>}</div>{draft.approvalId && <small>Approval {draft.approvalId}</small>}</article>)}{!view?.drafts.length && <p className="muted">No follow-up drafts are recorded.</p>}</section>
    <section><h3>Script outcomes</h3>{view?.runs.map(run => <article className="automation-card" key={run.id}><strong>{run.state}</strong><small>Event {run.eventSequence} · {new Date(run.updatedAt).toLocaleString()}</small><p>{run.detail ?? 'No additional detail.'}</p></article>)}{!view?.runs.length && <p className="muted">No script invocations recorded.</p>}</section>
    <section aria-label="Automation history"><h3>Full automation history</h3><label>Record type <select value={historyKind} onChange={event => setHistoryKind(event.target.value as AutomationPage['kind'])}><option value="rules">Rules</option><option value="scripts">Scripts</option><option value="schedules">Follow-ups</option><option value="drafts">Drafts</option><option value="runs">Script outcomes</option></select></label>
      {historyError && <p role="alert">Could not load history: {historyError} <button type="button" onClick={() => void loadHistory(historyKind)}>Retry</button></p>}
      {history?.kind === historyKind && history.items.map((item, index) => <article className="automation-card" key={`${historyKind}-${'id' in item ? item.id : item.revision.id}-${index}`}><strong>{'registration' in item ? item.registration.name : 'name' in item ? item.name : 'title' in item ? item.title : item.state}</strong><small>{'state' in item ? item.state : 'enabled' in item ? item.enabled ? 'Enabled' : 'Disabled' : 'grant' in item ? item.grant ? 'Trusted revision' : 'Untrusted revision' : historyKind}</small>{'registration' in item && <div className="approval-actions"><button type="button" className="secondary" onClick={() => void openReview(item.revision.id)}>Review source and grant</button><button type="button" className="secondary" disabled={busy} onClick={() => void editScript(item)}>Create new revision</button></div>}</article>)}
      {history?.kind === historyKind && !history.items.length && !historyBusy && <p className="muted">No records of this kind.</p>}
      {history?.kind === historyKind && history.nextCursor !== null && <button type="button" className="quiet" disabled={historyBusy} onClick={() => void loadHistory(historyKind, history.nextCursor ?? undefined)}>{historyBusy ? 'Loading…' : 'Older records'}</button>}
      {!history && historyBusy && <p role="status">Loading history…</p>}
    </section>
    {review && <dialog ref={reviewDialogRef} className="review-dialog" aria-label="Review pinned script" onClose={() => setReview(undefined)} onKeyDown={trapReviewTab}><div className="review-content"><h3>Grant reusable trust to this revision</h3><p role="alert">This script runs with your Windows privileges. Event scope and limits do not sandbox filesystem, network, imported modules or child processes. Granting trust authorizes future invocations until expiry or revocation.</p><dl><dt>Source SHA-256</dt><dd>{review.revision.sha256}</dd><dt>Interpreter</dt><dd>{review.revision.interpreterPath} · {review.revision.interpreterVersion}</dd><dt>Interpreter SHA-256</dt><dd>{review.revision.interpreterSha256}</dd><dt>Config SHA-256</dt><dd>{review.revision.configSha256}</dd><dt>Snapshot</dt><dd>{review.revision.snapshotPath}</dd><dt>Events</dt><dd>{reviewedRegistration?.triggers.join(', ') ?? 'Current registration'}</dd><dt>Project scope</dt><dd>{reviewedRegistration?.projectPath ?? 'All projects'}</dd><dt>Working directory</dt><dd>{reviewedRegistration?.cwd ?? 'Current registration'}</dd><dt>Arguments</dt><dd>{JSON.stringify(reviewedRegistration?.arguments ?? [])}</dd><dt>Input fields</dt><dd>{reviewedRegistration?.inputFields.join(', ') ?? 'Current registration'}</dd><dt>Timeout</dt><dd>{reviewedRegistration?.timeoutMs ?? 30_000} ms</dd></dl><pre>{review.source}</pre><div className="limits"><label>Days until expiry <input type="number" min={1} max={365} value={grantDays} onChange={event => setGrantDays(Number(event.target.value))} /></label><label>Max runs per 24 hours <input type="number" min={1} max={100} value={grantDaily} onChange={event => setGrantDaily(Number(event.target.value))} /></label></div><div className="dialog-actions"><button type="button" className="secondary" onClick={closeReview}>Keep untrusted</button><button type="button" className="danger" disabled={busy} onClick={() => void grant()}>Grant trust to pinned revision</button></div></div></dialog>}
  </section>;
}
