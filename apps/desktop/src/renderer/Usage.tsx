import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopApi, UsageBreakdownRow, UsageFilters, UsageGroup, UsageRequest, UsageSummary, UsageTotals } from '../../../../packages/protocol/src/index';

type Period = 'today' | '7' | '30' | 'all' | 'custom';
type Sort = 'tokens' | 'requests' | 'name';
const groups: Array<{ value: UsageGroup; label: string }> = [
  { value: 'conversation', label: 'Conversation' }, { value: 'model', label: 'Model' },
  { value: 'effort', label: 'Effort' }, { value: 'modelEffort', label: 'Model + effort' },
  { value: 'profile', label: 'Profile' }, { value: 'api', label: 'API' }
];
const number = (value: number) => value.toLocaleString();
const localDate = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const calendarDay = (value: string): number => {
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
};
const validLocalDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  if (year < 1000 || year > 9998 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  return localDate(new Date(year, month - 1, day)) === value;
};
const boundary = (date: string, nextDay = false): string => {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(year, month - 1, day + Number(nextDay)).toISOString();
};
function periodFilters(period: Period, from: string, to: string): Pick<UsageFilters, 'from' | 'to'> {
  if (period === 'all') return {};
  if (period === 'custom') return validLocalDate(from) && validLocalDate(to) && from <= to ? { from: boundary(from), to: boundary(to, true) } : {};
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (period === 'today' ? 0 : Number(period) - 1));
  return { from: first.toISOString(), to: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString() };
}
function metric(value: number | null, coverage: number, known: number): string {
  return value === null ? 'Unavailable' : `${number(value)}${coverage < known ? ` · ${coverage}/${known} reported` : ''}`;
}
function RequestRow({ record, onOpenTask }: { record: UsageRequest; onOpenTask: (taskId: string) => void }) {
  const model = record.reportedModel ? record.reportedModel : record.deployment ? `${record.deployment} (deployment only)` : 'Model unknown';
  const role = record.purpose === 'probe' ? 'Profile check' : record.role === 'coordinator' ? 'Coordinator' : record.role === 'child' ? 'Child agent' : 'Standalone conversation';
  const usageState = record.usageKnown ? `${number((record.inputTokens ?? 0) + (record.outputTokens ?? 0))} measured tokens`
    : !record.attemptedAt && record.attributionKnown ? record.outcome === 'pending' ? 'Pending dispatch' : 'Not dispatched'
      : record.outcome === 'pending' ? 'Pending usage' : 'Usage unknown';
  return <article className="usage-request">
    <div><strong>{model}</strong><span>{record.effort ? `Requested effort: ${record.effort}` : record.attributionKnown ? 'Requested effort: provider default' : 'Requested effort unknown'} · {record.apiKind ?? 'API unknown'}</span></div>
    <div><strong>{usageState}</strong><span>{record.usageKnown ? `${number(record.inputTokens ?? 0)} in · ${number(record.outputTokens ?? 0)} out` : record.reservedTokens ? `${number(record.reservedTokens)} reserved conservatively` : 'No reservation'} · {record.outcome}</span></div>
    <div><span>{new Date(record.createdAt).toLocaleString()} · {role} · {record.taskTitle ?? 'Untitled conversation'}</span>{record.taskId && <button type="button" className="quiet" onClick={() => onOpenTask(record.rootTaskId ?? record.taskId!)}>Open conversation</button>}</div>
    <div className="usage-request-detail"><span>Cache read: {record.cacheReadTokens === null ? 'unavailable' : number(record.cacheReadTokens)}</span><span>Cache creation: {record.cacheCreationTokens === null ? 'unavailable' : number(record.cacheCreationTokens)}</span><span>Reasoning output: {record.reasoningTokens === null ? 'unavailable' : number(record.reasoningTokens)}</span>{record.reason && <span>{record.reason}</span>}</div>
  </article>;
}

export function UsageView({ api, refreshKey, onOpenTask }: { api: DesktopApi; refreshKey: number; onOpenTask: (taskId: string) => void }) {
  const [period, setPeriod] = useState<Period>('30');
  const [from, setFrom] = useState(localDate(new Date()));
  const [to, setTo] = useState(localDate(new Date()));
  const [includeDemo, setIncludeDemo] = useState(false);
  const [groupBy, setGroupBy] = useState<UsageGroup>('conversation');
  const [sort, setSort] = useState<Sort>('tokens');
  const [summary, setSummary] = useState<UsageSummary>();
  const [rows, setRows] = useState<UsageBreakdownRow[]>([]);
  const [nextRowCursor, setNextRowCursor] = useState<string | null>(null);
  const [requests, setRequests] = useState<UsageRequest[]>([]);
  const [nextRequestCursor, setNextRequestCursor] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<UsageBreakdownRow>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const queryVersion = useRef(0);
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const filters = useMemo<UsageFilters>(() => ({ ...periodFilters(period, from, to), includeDemo }), [period, from, to, includeDemo]);
  const validDates = period !== 'custom' || (validLocalDate(from) && validLocalDate(to) && from <= to);
  const requestFilters = useMemo<UsageFilters>(() => ({ ...filters, ...(selectedRow?.filters ?? {}) }), [filters, selectedRow]);

  useEffect(() => {
    const version = ++queryVersion.current;
    if (!validDates) { setError('Choose valid start and end dates, with the start on or before the end.'); setSummary(undefined); setRows([]); setRequests([]); setNextRowCursor(null); setNextRequestCursor(null); setLoading(false); return; }
    setLoading(true); setError(''); setSummary(undefined); setRows([]); setRequests([]); setNextRowCursor(null); setNextRequestCursor(null);
    void Promise.all([
      api.invoke('usage.summary', { filters, timeZone }),
      api.invoke('usage.breakdown', { filters, groupBy, sort, limit: 25 }),
      api.invoke('usage.requests', { filters: requestFilters, limit: 25 })
    ]).then(([nextSummary, nextBreakdown, nextRequests]) => {
      if (version !== queryVersion.current) return;
      setSummary(nextSummary); setRows(nextBreakdown.rows); setNextRowCursor(nextBreakdown.nextCursor);
      setRequests(nextRequests.records); setNextRequestCursor(nextRequests.nextCursor); setLoading(false);
    }).catch(cause => { if (version === queryVersion.current) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); } });
    return () => { ++queryVersion.current; };
  }, [api, filters, requestFilters, groupBy, sort, timeZone, refreshKey, validDates]);

  async function loadMoreRows() {
    if (!nextRowCursor) return;
    const version = queryVersion.current; const cursor = nextRowCursor; setNextRowCursor(null);
    try { const result = await api.invoke('usage.breakdown', { filters, groupBy, sort, cursor, limit: 25 }); if (version === queryVersion.current) { setRows(current => [...current, ...result.rows]); setNextRowCursor(result.nextCursor); } }
    catch (cause) { if (version === queryVersion.current) { setNextRowCursor(cursor); setError(cause instanceof Error ? cause.message : String(cause)); } }
  }
  async function loadMoreRequests() {
    if (!nextRequestCursor) return;
    const version = queryVersion.current; const cursor = nextRequestCursor; setNextRequestCursor(null);
    try { const result = await api.invoke('usage.requests', { filters: requestFilters, cursor, limit: 25 }); if (version === queryVersion.current) { setRequests(current => [...current, ...result.records]); setNextRequestCursor(result.nextCursor); } }
    catch (cause) { if (version === queryVersion.current) { setNextRequestCursor(cursor); setError(cause instanceof Error ? cause.message : String(cause)); } }
  }

  const totals: UsageTotals | undefined = summary?.totals;
  const days = summary?.days ?? [];
  const peak = Math.max(1, ...days.map(day => day.totals.total));
  const chartHeight = 116;
  const chartFrom = filters.from ? localDate(new Date(filters.from)) : days[0]?.date;
  const chartTo = filters.to ? localDate(new Date(Date.parse(filters.to) - 1)) : days.at(-1)?.date;
  const chartSpan = chartFrom && chartTo ? Math.max(1, calendarDay(chartTo) - calendarDay(chartFrom) + 1) : 1;
  const chartWidth = Math.max(320, Math.min(1200, chartSpan * 20));
  const chartStep = chartWidth / chartSpan;
  return <section className="usage-page" aria-label="Usage overview">
    <header className="usage-page-header"><div><p className="eyebrow">LOCAL REQUEST HISTORY</p><h1>Usage</h1><p>Measured tokens from this workspace. Unknown usage and budget reservations are shown separately.</p></div><small>Calendar days in {timeZone}</small></header>
    <div className="usage-controls" role="group" aria-label="Date range">
      {([['today', 'Today'], ['7', '7 days'], ['30', '30 days'], ['all', 'All'], ['custom', 'Custom']] as const).map(([value, label]) => <button key={value} type="button" className={period === value ? 'active' : ''} aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}
      {period === 'custom' && <><label>From <input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>Through <input type="date" value={to} onChange={event => setTo(event.target.value)} /></label></>}
      <label className="checkbox-row"><input type="checkbox" checked={includeDemo} onChange={event => setIncludeDemo(event.target.checked)} />Include offline demo</label>
    </div>
    {error && <p className="usage-error" role="alert">Could not load usage: {error}</p>}
    {loading && <p className="muted" role="status">Loading usage…</p>}
    {summary && <>
      {!summary.detailedTracking && <p className="usage-context">Older records have measured totals when reported; model and effort details are unavailable for those requests.</p>}
      <div className="usage-cards">
        <div><span>Measured tokens</span><strong>{number(totals!.total)}</strong><small>{number(totals!.input)} input · {number(totals!.output)} output</small></div>
        <div><span>Request attempts</span><strong>{number(totals!.attemptedRequests)}</strong><small>{number(totals!.knownRequests)} measured · {number(totals!.unknownRequests)} unknown · {number(totals!.pendingRequests)} pending · {number(totals!.notSentRequests)} not dispatched</small></div>
        <div><span>Cache read</span><strong>{metric(totals!.cacheRead, totals!.cacheReadKnownRequests, totals!.knownRequests)}</strong><small>Subset of input tokens</small></div>
        <div><span>Cache creation</span><strong>{metric(totals!.cacheCreation, totals!.cacheCreationKnownRequests, totals!.knownRequests)}</strong><small>Included in input tokens</small></div>
        <div><span>Reasoning output</span><strong>{metric(totals!.reasoning, totals!.reasoningKnownRequests, totals!.knownRequests)}</strong><small>Subset of output tokens</small></div>
        <div><span>Conservative reservations</span><strong>{number(totals!.reservedUnknown + totals!.reservedPending + totals!.reservedNotSent)}</strong><small>{number(totals!.reservedUnknown)} unknown · {number(totals!.reservedPending)} pending · {number(totals!.reservedNotSent)} not dispatched; excluded from measured total</small></div>
      </div>
      <section className="usage-section" aria-label="Daily measured tokens"><h2>Daily trend</h2>{summary.daysTruncated && <p className="usage-context">The chart shows the most recent 730 active days; totals cover the full selected range.</p>}{days.length ? <div className="usage-chart"><svg role="img" aria-label="Daily measured token totals, spaced by calendar day" viewBox={`0 0 ${chartWidth} ${chartHeight + 22}`} preserveAspectRatio="none"><title>Daily measured tokens</title>{days.filter(day => day.totals.total > 0).map(day => { const height = day.totals.total / peak * chartHeight; const x = (calendarDay(day.date) - calendarDay(chartFrom ?? day.date)) * chartStep + chartStep * .12; return <rect key={day.date} x={x} y={chartHeight - height} width={chartStep * .76} height={height}><title>{day.date}: {number(day.totals.total)} measured tokens</title></rect>; })}</svg><div className="usage-chart-scale"><span>{chartFrom}</span><span>{chartTo}</span></div><ul className="visually-hidden">{days.map(day => <li key={day.date}>{day.date}: {number(day.totals.total)} measured tokens</li>)}</ul></div> : <p className="muted">No requests in this date range.</p>}</section>
    </>}
    <section className="usage-section" aria-label="Usage breakdown"><div className="usage-section-head"><h2>Breakdown</h2><div><label>Group by <select value={groupBy} onChange={event => { setGroupBy(event.target.value as UsageGroup); setSelectedRow(undefined); }}>{groups.map(group => <option key={group.value} value={group.value}>{group.label}</option>)}</select></label><label>Sort <select value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="tokens">Measured tokens</option><option value="requests">Requests</option><option value="name">Name</option></select></label></div></div>
      <div className="usage-breakdown" role="list">{rows.map(row => <button type="button" role="listitem" key={row.key} className={selectedRow?.key === row.key ? 'selected' : ''} onClick={() => setSelectedRow(current => current?.key === row.key ? undefined : row)}><span><strong>{row.label}</strong><small>{number(row.totals.attemptedRequests)} attempts · {number(row.totals.unknownRequests)} unknown</small></span><span><strong>{number(row.totals.total)}</strong><small>{row.sharePercent.toFixed(1)}% measured</small></span></button>)}</div>
      {!loading && !rows.length && <p className="muted">No groups in this date range.</p>}{nextRowCursor && <button type="button" className="secondary" onClick={() => void loadMoreRows()}>More groups</button>}
    </section>
    <section className="usage-section" aria-label="Request details"><div className="usage-section-head"><h2>{selectedRow ? `Requests · ${selectedRow.label}` : 'Recent requests'}</h2>{selectedRow && <button type="button" className="quiet" onClick={() => setSelectedRow(undefined)}>Clear group</button>}</div>
      <div className="usage-request-list">{requests.map(record => <RequestRow key={record.requestId} record={record} onOpenTask={onOpenTask} />)}</div>
      {!loading && !requests.length && <p className="muted">No requests match this view.</p>}{nextRequestCursor && <button type="button" className="secondary" onClick={() => void loadMoreRequests()}>More requests</button>}
    </section>
  </section>;
}
