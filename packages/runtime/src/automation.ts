import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ActionProposalSchema, AutomationRpc, HookRuleSchema, ScheduleSchema, ScriptGrantSchema, ScriptRegistrationSchema, type ActionProposal, type AutomationDraft, type AutomationPage, type AutomationView, type HookRule, type HookRun, type Schedule, type ScriptGrant, type ScriptGrantSnapshot, type ScriptRegistration, type ScriptRevision, type WorkspaceEvent } from '../../protocol/src/index';
import type { Store } from './store';
import type { Redactor } from './redaction';
import { POWERSHELL_LAUNCHER_SHA256, sha256File, WindowsHookRunner, type HookExecutor } from './hook-runner';
import { ToolArguments } from './tool-definitions';
import { isNetworkOrDevicePath } from './network-path';

type RegistrationRow = { registration: ScriptRegistration; revision: ScriptRevision };
type EventSource = Pick<WorkspaceEvent, 'sequence' | 'type' | 'taskId' | 'createdAt' | 'data'>;
export interface AutomationOptions { scriptDirectory: string; executor?: HookExecutor; now?: () => Date; resolveInterpreter?: (language: ScriptRegistration['language']) => Promise<{ path: string; version: string }>; prepareAction?: (draft: AutomationDraft) => Promise<{ approvalId: string }>; admission?: () => { hooks: boolean; scheduling: boolean }; }
/** Only the trusted preparation callback may assert that no approval or execution was created. */
export class ActionPreparationError extends Error { constructor(message: string, readonly outcome: 'none' | 'unknown' = 'unknown') { super(message); } }
const BLOCKED_EVENT = /^(?:task\.progress|hook\.|automation\.|draft\.|schedule\.)/;
const MAX_DRAFTS_PER_RUN = 10;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 224 * 1024;
function responseBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

/** Durable automation authority. Hook output is inert data; no method invokes a model or a repository tool. */
export class AutomationService {
  private readonly executor: HookExecutor;
  private readonly running = new Map<string, AbortController>();
  private readonly runningPromises = new Set<Promise<void>>();
  private scriptBusy = false;
  private pumping = false;
  private drainPromise?: Promise<void>;
  private closing = false;
  private readonly now: () => Date;
  constructor(private readonly store: Store, private readonly redactor: Redactor, private readonly publish: (type: string, data: unknown, taskId?: string) => void, private readonly options: AutomationOptions) {
    this.executor = options.executor ?? new WindowsHookRunner();
    this.now = options.now ?? (() => new Date());
    this.store.db.prepare('INSERT OR IGNORE INTO automation_event_cursor(id,sequence) VALUES(1,?)').run(this.latestEventSequence());
    for (const run of this.rows<HookRun>("SELECT data FROM automation_runs WHERE state IN ('dispatching', 'running')")) this.setRun(run, 'unknown', 'Runtime restarted after possible script launch; inspect external effects.');
    for (const draft of this.rows<AutomationDraft>("SELECT data FROM automation_drafts WHERE json_extract(data,'$.state') = 'preparing'")) {
      draft.state = 'unknown';
      this.store.db.prepare('UPDATE automation_drafts SET data = ? WHERE id = ?').run(JSON.stringify(draft), draft.id);
    }
  }

  async dispatch(method: keyof typeof AutomationRpc, input: unknown): Promise<unknown> {
    const params = AutomationRpc[method].parse(input);
    switch (method) {
      case 'automation.list': return this.view();
      case 'automation.query': return this.query(params as { kind: AutomationPage['kind']; before?: number; limit: number });
      case 'automation.rule.save': return this.saveRule(HookRuleSchema.parse(params));
      case 'automation.rule.preview': return this.previewRule(params as { ruleId: string; taskId: string; eventType: HookRule['triggers'][number]; approvalState?: string });
      case 'automation.rule.remove': return { removed: this.store.db.prepare('DELETE FROM automation_rules WHERE id = ?').run((params as { ruleId: string }).ruleId).changes > 0 };
      case 'automation.script.register': return this.register(ScriptRegistrationSchema.parse(params));
      case 'automation.script.source': return this.source((params as { revisionId: string }).revisionId);
      case 'automation.script.grant': return this.grant(ScriptGrantSchema.parse(params));
      case 'automation.script.revoke': return this.revoke((params as { revisionId: string }).revisionId);
      case 'automation.schedule.save': return this.saveSchedule(ScheduleSchema.parse(params));
      case 'automation.schedule.remove': return { removed: this.store.db.prepare('DELETE FROM automation_schedules WHERE id = ?').run((params as { scheduleId: string }).scheduleId).changes > 0 };
      case 'automation.schedule.tick': return { created: this.tick(this.now()) };
      case 'automation.draft.dismiss': return this.dismiss((params as { draftId: string }).draftId);
      case 'automation.draft.prepare': return this.prepareDraft((params as { draftId: string }).draftId);
    }
  }

  view(): AutomationView {
    const rules = this.rows<HookRule>('SELECT data FROM automation_rules ORDER BY rowid DESC LIMIT 21');
    const scripts = this.rows<RegistrationRow>('SELECT data FROM automation_scripts ORDER BY rowid DESC LIMIT 21').map(row => { const grant = this.grantFor(row.revision.id); return { registration: omitSource(row.registration), revision: { ...row.revision, trusted: Boolean(grant) }, grant }; });
    const schedules = this.rows<Schedule>('SELECT data FROM automation_schedules ORDER BY rowid DESC LIMIT 21');
    const drafts = this.rows<AutomationDraft>('SELECT data FROM automation_drafts ORDER BY rowid DESC LIMIT 21');
    const runs = this.rows<HookRun>('SELECT data FROM automation_runs ORDER BY rowid DESC LIMIT 21');
    const result: AutomationView = { rules: rules.slice(0, 20), scripts: scripts.slice(0, 20), schedules: schedules.slice(0, 20), drafts: drafts.slice(0, 20), runs: runs.slice(0, 20), truncated: [rules, scripts, schedules, drafts, runs].some(rows => rows.length > 20) };
    const groups = [result.rules, result.scripts, result.schedules, result.drafts, result.runs];
    while (responseBytes(result) > MAX_RESPONSE_BYTES) {
      const largest = groups.filter(group => group.length).sort((a, b) => responseBytes(b) - responseBytes(a))[0];
      if (!largest) throw new Error('Automation response cannot fit the size limit.');
      largest.pop();
      result.truncated = true;
    }
    return result;
  }
  query(input: { kind: AutomationPage['kind']; before?: number; limit: number }): AutomationPage {
    const table = { rules: 'automation_rules', scripts: 'automation_scripts', schedules: 'automation_schedules', drafts: 'automation_drafts', runs: 'automation_runs' }[input.kind];
    const rows = this.store.db.prepare(`SELECT rowid,data FROM ${table} WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`).all(input.before ?? Number.MAX_SAFE_INTEGER, input.limit + 1) as { rowid: number; data: string }[];
    const page = rows.slice(0, input.limit);
    const items = page.map(row => {
      const data = JSON.parse(row.data) as unknown;
      if (input.kind !== 'scripts') return data;
      const script = data as RegistrationRow; const grant = this.grantFor(script.revision.id);
      return { registration: omitSource(script.registration), revision: { ...script.revision, trusted: Boolean(grant) }, grant };
    }) as AutomationPage['items'];
    const result: AutomationPage = { kind: input.kind, items, nextCursor: rows.length > input.limit ? page.at(-1)!.rowid : null };
    while (responseBytes(result) > MAX_RESPONSE_BYTES && result.items.length > 1) result.items.pop();
    if (responseBytes(result) > MAX_RESPONSE_BYTES) throw new Error('Automation item exceeds response limit.');
    if (result.items.length < page.length) result.nextCursor = page[result.items.length - 1]!.rowid;
    return result;
  }

  private rows<T>(sql: string, ...args: unknown[]): T[] { return (this.store.db.prepare(sql).all(...args) as { data: string }[]).map(row => JSON.parse(row.data) as T); }
  private saveRule(rule: HookRule): HookRule {
    if (rule.enabled && this.options.admission && !this.options.admission().hooks) throw new Error('Hook admission is paused; save the rule disabled or re-enable hooks explicitly.');
    assertScreened(this.redactor, JSON.stringify(rule));
    if (rule.proposal) {
      if (rule.action !== 'actionDraft') throw new Error('Only action drafts may include executable proposals.');
      validateProposal(rule.proposal, this.redactor);
    }
    if (rule.taskId) {
      const task = this.store.task(rule.taskId);
      if (rule.projectPath && task.projectPath !== rule.projectPath) throw new Error('Rule task must match its project scope.');
    }
    const old = this.store.db.prepare('SELECT version FROM automation_rules WHERE id = ?').get(rule.id) as { version: number } | undefined;
    if (!old && (this.store.db.prepare('SELECT COUNT(*) AS count FROM automation_rules').get() as { count: number }).count >= 100) throw new Error('At most 100 hook rules may be registered.');
    if (old && rule.version <= old.version) throw new Error('Rule version must increase before saving changes.');
    this.store.db.transaction(() => {
      this.store.db.prepare('INSERT INTO automation_rules(id,version,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data').run(rule.id, rule.version, JSON.stringify(rule));
      this.setActivation(rule.id, this.latestEventSequence());
    })();
    return rule;
  }
  private previewRule(input: { ruleId: string; taskId: string; eventType: HookRule['triggers'][number]; approvalState?: string }): { matches: boolean; reason: string | null; draftPreview: Pick<AutomationDraft, 'kind' | 'title' | 'body' | 'proposal'> | null } {
    const rule = this.rows<HookRule>('SELECT data FROM automation_rules WHERE id = ?', input.ruleId)[0];
    if (!rule) throw new Error('Hook rule not found.');
    const reason = this.ruleMismatch(rule, input.taskId, input.eventType, input.approvalState);
    return { matches: reason === null, reason, draftPreview: reason === null ? { kind: rule.action, title: rule.title, body: rule.body, ...(rule.proposal ? { proposal: rule.proposal } : {}) } : null };
  }
  private ruleMismatch(rule: HookRule, taskId: string | undefined, eventType: string, approvalState?: string): string | null {
    if (this.options.admission && !this.options.admission().hooks) return 'Hook admission is paused.';
    if (!rule.enabled) return 'Rule is disabled.';
    if (!rule.triggers.includes(eventType as HookRule['triggers'][number])) return 'Trigger is not selected.';
    if (rule.taskId && rule.taskId !== taskId) return 'Task does not match.';
    if (rule.projectPath && !this.inProject(rule.projectPath, taskId)) return 'Project does not match.';
    if (rule.conditions?.approvalState && (eventType !== 'approval.changed' || rule.conditions.approvalState !== approvalState)) return 'Approval state does not match.';
    if (rule.conditions?.mode || rule.conditions?.status) {
      if (!taskId) return 'Task context is unavailable.';
      let task; try { task = this.store.task(taskId); } catch { return 'Task context is unavailable.'; }
      if (rule.conditions.mode && rule.conditions.mode !== task.mode) return 'Task mode does not match.';
      if (rule.conditions.status && rule.conditions.status !== task.status) return 'Task status does not match.';
    }
    return null;
  }
  private async register(registration: ScriptRegistration): Promise<ScriptRevision> {
    assertScreened(this.redactor, JSON.stringify(registration));
    if (Buffer.byteLength(registration.source, 'utf8') > 64 * 1024) throw new Error('Hook source exceeds 64 KiB.');
    if (Buffer.byteLength(JSON.stringify(registration.source), 'utf8') > 128 * 1024) throw new Error('Hook source exceeds the serialized review limit.');
    if (registration.language === 'powershell' && registration.source.startsWith('\uFEFF')) throw new Error('PowerShell source must omit a transport BOM; the runtime adds it to the pinned snapshot.');
    if (!this.script(registration.id) && (this.store.db.prepare('SELECT COUNT(*) AS count FROM automation_scripts').get() as { count: number }).count >= 100) throw new Error('At most 100 scripts may be registered.');
    if (isNetworkOrDevicePath(registration.cwd)) throw new Error('Hook working directory must not be on a network share.');
    if (!path.isAbsolute(registration.cwd) || !(await fs.stat(registration.cwd).catch(() => undefined))?.isDirectory()) throw new Error('Hook working directory must be an existing absolute directory.');
    const interpreter = await (this.options.resolveInterpreter ?? defaultInterpreter)(registration.language);
    const realInterpreter = await fs.realpath(interpreter.path);
    const interpreterSha256 = await sha256File(realInterpreter);
    const snapshotBytes = scriptSnapshotBytes(registration);
    const sha256 = digest(snapshotBytes);
    const revisionId = randomUUID();
    const directory = path.resolve(this.options.scriptDirectory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const snapshotPath = path.join(directory, `${revisionId}.${registration.language === 'powershell' ? 'ps1' : 'js'}`);
    await fs.writeFile(snapshotPath, snapshotBytes, { flag: 'wx', mode: 0o600 });
    if (await sha256File(snapshotPath) !== sha256) throw new Error('Script snapshot integrity check failed.');
    const revision: ScriptRevision = { id: revisionId, scriptId: registration.id, sha256, interpreterPath: realInterpreter, interpreterSha256, interpreterVersion: interpreter.version, snapshotPath, configSha256: configDigest(registration), registeredAt: this.now().toISOString(), trusted: false };
    const row: RegistrationRow = { registration, revision };
    let previousRevisionId: string | undefined;
    let previousGrantId: string | undefined;
    this.store.db.transaction(() => {
      const previous = this.store.db.prepare('SELECT revision_id FROM automation_scripts WHERE id = ?').get(registration.id) as { revision_id: string } | undefined;
      if (previous) {
        previousRevisionId = previous.revision_id;
        const grant = this.storedGrantFor(previous.revision_id);
        this.store.db.prepare('UPDATE automation_revisions SET grant = NULL WHERE id = ?').run(previous.revision_id);
        if (grant) { this.recordGrant(grant, 'revoked', 'revision-replaced'); previousGrantId = grant.id; }
      }
      this.store.db.prepare('INSERT INTO automation_scripts(id,revision_id,data,source_sha256) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision_id=excluded.revision_id,data=excluded.data,source_sha256=excluded.source_sha256').run(registration.id, revisionId, JSON.stringify(row), sha256);
      this.store.db.prepare('INSERT INTO automation_revisions(id,script_id,data,grant) VALUES(?,?,?,NULL)').run(revisionId, registration.id, JSON.stringify(revision));
    })();
    if (previousRevisionId) this.running.get(previousRevisionId)?.abort();
    if (previousRevisionId && previousGrantId) this.notifyGrant('revoked', previousRevisionId, previousGrantId, 'revision-replaced');
    return revision;
  }
  private async source(revisionId: string): Promise<{ source: string; revision: ScriptRevision }> {
    const row = this.store.db.prepare('SELECT data FROM automation_revisions WHERE id = ?').get(revisionId) as { data: string } | undefined;
    if (!row) throw new Error('Script revision not found.');
    const revision = JSON.parse(row.data) as ScriptRevision;
    const current = this.script(revision.scriptId);
    if (!current || current.revision.id !== revisionId) throw new Error('Only the current revision can be reviewed for trust.');
    await this.validateRevision(current);
    const snapshotSource = await fs.readFile(revision.snapshotPath, 'utf8');
    const source = current.registration.language === 'powershell' ? snapshotSource.slice(1) : snapshotSource;
    const result = { source, revision: { ...revision, trusted: Boolean(this.grantFor(revisionId)) } };
    if (responseBytes(result) > MAX_RESPONSE_BYTES) throw new Error('Reviewed script exceeds the response size limit.');
    return result;
  }
  private async grant(grant: ScriptGrant): Promise<ScriptRevision> {
    if (this.options.admission && !this.options.admission().hooks) throw new Error('Hook admission is paused; re-enable hooks explicitly before granting trust.');
    if (new Date(grant.expiresAt).getTime() <= this.now().getTime() || new Date(grant.expiresAt).getTime() > this.now().getTime() + 30 * 86_400_000) throw new Error('Grant must expire within 30 days.');
    const row = this.store.db.prepare('SELECT data FROM automation_revisions WHERE id = ?').get(grant.revisionId) as { data: string } | undefined;
    if (!row) throw new Error('Script revision not found.');
    const revision = JSON.parse(row.data) as ScriptRevision;
    const current = this.script(revision.scriptId);
    if (!current || current.revision.id !== revision.id) throw new Error('Only the current script revision may be trusted.');
    await this.validateRevision(current);
    const snapshot: ScriptGrantSnapshot = { ...grant, id: randomUUID(), grantedAt: this.now().toISOString() };
    const transition: { replaced?: ScriptGrantSnapshot } = {};
    this.store.db.transaction(() => {
      const prior = this.storedGrantFor(revision.id);
      if (prior) {
        this.recordGrant(prior, 'revoked', 'regranted'); transition.replaced = prior;
        for (const queued of this.rows<HookRun>("SELECT data FROM automation_runs WHERE rule_id = ? AND state = 'queued'", revision.id)) this.setRun(queued, 'cancelled', 'Prior trust grant was replaced before launch.');
      }
      this.store.db.prepare('UPDATE automation_revisions SET grant = ? WHERE id = ?').run(JSON.stringify(snapshot), revision.id);
      this.recordGrant(snapshot, 'issued', null);
      this.setActivation(revision.id, this.latestEventSequence());
    })();
    if (transition.replaced) this.notifyGrant('revoked', revision.id, transition.replaced.id, 'regranted');
    this.notifyGrant('issued', revision.id, snapshot.id);
    return { ...revision, trusted: true };
  }
  private revoke(revisionId: string): { revoked: boolean } {
    const transition: { revoked?: ScriptGrantSnapshot } = {};
    const changed = this.store.db.transaction(() => {
      const grant = this.storedGrantFor(revisionId);
      const revoked = this.store.db.prepare('UPDATE automation_revisions SET grant = NULL WHERE id = ? AND grant IS NOT NULL').run(revisionId).changes > 0;
      if (grant && revoked) { this.recordGrant(grant, 'revoked', 'user-revoked'); transition.revoked = grant; }
      for (const run of this.rows<HookRun>("SELECT data FROM automation_runs WHERE rule_id = ? AND state = 'queued'", revisionId)) this.setRun(run, 'cancelled', 'Trust grant revoked.');
      return revoked;
    })();
    this.running.get(revisionId)?.abort();
    if (changed && transition.revoked) this.notifyGrant('revoked', revisionId, transition.revoked.id, 'user-revoked');
    return { revoked: changed };
  }
  private recordGrant(grant: ScriptGrantSnapshot, action: 'issued' | 'revoked', reason: string | null): void {
    this.store.db.prepare('INSERT INTO automation_grant_history(id,revision_id,grant_id,action,reason,snapshot,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), grant.revisionId, grant.id, action, reason, JSON.stringify(grant), this.now().toISOString());
  }
  private notifyGrant(action: 'issued' | 'revoked', revisionId: string, grantId: string, reason?: string): void {
    try { this.publish(`automation.grant.${action}`, { revisionId, grantId, ...(reason ? { reason } : {}) }); } catch { /* Durable grant history remains authoritative. */ }
  }
  private latestEventSequence(): number { return (this.store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM events').get() as { value: number }).value; }
  private setActivation(id: string, sequence: number): void { this.store.db.prepare('INSERT INTO automation_activation(id,enabled_at_sequence) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET enabled_at_sequence=excluded.enabled_at_sequence').run(id, sequence); }
  private activeFor(id: string, sequence: number): boolean {
    const row = this.store.db.prepare('SELECT enabled_at_sequence FROM automation_activation WHERE id = ?').get(id) as { enabled_at_sequence: number } | undefined;
    return Boolean(row && sequence > row.enabled_at_sequence);
  }
  private grantFor(revisionId: string): ScriptGrantSnapshot | null {
    const grant = this.storedGrantFor(revisionId);
    return grant && Date.parse(grant.expiresAt) > this.now().getTime() ? grant : null;
  }
  private storedGrantFor(revisionId: string): ScriptGrantSnapshot | null {
    const row = this.store.db.prepare('SELECT grant FROM automation_revisions WHERE id = ?').get(revisionId) as { grant: string | null } | undefined;
    if (!row?.grant) return null;
    return JSON.parse(row.grant) as ScriptGrantSnapshot;
  }
  private script(id: string): RegistrationRow | null {
    const row = this.store.db.prepare('SELECT data FROM automation_scripts WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as RegistrationRow : null;
  }
  private async validateRevision(row: RegistrationRow): Promise<void> {
    const { registration, revision } = row;
    const snapshot = await fs.lstat(revision.snapshotPath).catch(() => undefined);
    const directory = await fs.realpath(this.options.scriptDirectory).catch(() => '');
    const actual = await fs.realpath(revision.snapshotPath).catch(() => '');
    if (!snapshot?.isFile() || snapshot.isSymbolicLink() || snapshot.nlink !== 1 || path.dirname(actual) !== directory || configDigest(registration) !== revision.configSha256 || digest(scriptSnapshotBytes(registration)) !== revision.sha256 || await sha256File(revision.snapshotPath) !== revision.sha256 || await sha256File(revision.interpreterPath) !== revision.interpreterSha256) {
      this.revoke(revision.id);
      throw new Error('Pinned script or interpreter changed. Register and review a new revision.');
    }
  }

  /** A notification only: the durable events table and cursor are the source of truth. */
  async onEvent(_event: EventSource): Promise<void> { if (this.closing) return; await this.catchUp(); await this.pumpQueued(); }
  /** Safe at startup: committed events after the cursor are consumed even if notification was lost. */
  catchUp(): Promise<void> {
    this.drainPromise ??= this.consumeEvents().finally(() => { this.drainPromise = undefined; });
    return this.drainPromise;
  }
  private async consumeEvents(): Promise<void> {
    while (!this.closing) {
      const cursor = (this.store.db.prepare('SELECT sequence FROM automation_event_cursor WHERE id = 1').get() as { sequence: number }).sequence;
      const events = this.store.db.prepare('SELECT sequence,type,task_id,data,created_at FROM events WHERE sequence > ? ORDER BY sequence LIMIT 100').all(cursor) as { sequence: number; type: string; task_id: string | null; data: string; created_at: string }[];
      if (!events.length) break;
      for (const row of events) {
        const event: EventSource = { sequence: row.sequence, type: row.type, ...(row.task_id ? { taskId: row.task_id } : {}), data: JSON.parse(row.data) as unknown, createdAt: row.created_at };
        this.processEvent(event);
        this.store.db.prepare('UPDATE automation_event_cursor SET sequence = ? WHERE id = 1').run(row.sequence);
      }
      // A long offline backlog must not monopolize the runtime's event loop.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  private processEvent(event: EventSource): void {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0 || BLOCKED_EVENT.test(event.type)) return;
    if (event.type === 'approval.changed' && event.data && typeof event.data === 'object' && !Array.isArray(event.data) && (event.data as Record<string, unknown>).origin === 'hook') {
      const data = event.data as Record<string, unknown>;
      if (typeof data.approvalId === 'string' && typeof data.state === 'string') this.syncDraftApproval(data.approvalId, data.state);
      return; // A hook-initiated approval never triggers another hook.
    }
    if (this.options.admission && !this.options.admission().hooks) return;
    if (Buffer.byteLength(JSON.stringify(event.data ?? {}), 'utf8') > MAX_EVENT_BYTES) return;
    const rules = this.rows<HookRule>('SELECT data FROM automation_rules ORDER BY id');
    for (const rule of rules) {
      const approvalState = event.type === 'approval.changed' && event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? String((event.data as Record<string, unknown>).state ?? '') : undefined;
      if (!this.activeFor(rule.id, event.sequence) || this.ruleMismatch(rule, event.taskId, event.type, approvalState)) continue;
      const created = this.store.db.transaction(() => {
        const run = this.enqueue(rule.id, rule.version, event.sequence);
        if (!run) return null;
        const draft = this.addDraft('hook', run.id, event.taskId ?? null, rule.action, rule.title, rule.body, false, rule.proposal);
        this.setRun(run, 'complete');
        return draft;
      })();
      if (created) this.publish('automation.draft.created', { draftId: created.id, kind: created.kind, taskId: created.taskId }, created.taskId ?? undefined);
    }
    const scripts = this.rows<RegistrationRow>('SELECT data FROM automation_scripts ORDER BY id');
    for (const row of scripts) {
      if (!this.activeFor(row.revision.id, event.sequence) || !row.registration.triggers.includes(event.type as ScriptRegistration['triggers'][number]) || !this.inProject(row.registration.projectPath, event.taskId)) continue;
      this.enqueue(row.revision.id, 1, event.sequence);
    }
  }
  /** Resume only jobs that remained queued before any script launch. */
  async pumpQueued(): Promise<void> {
    if (this.closing || this.scriptBusy || this.pumping) return;
    this.pumping = true;
    try { while (!this.closing) {
      const queued = this.rows<HookRun>("SELECT data FROM automation_runs WHERE state = 'queued' ORDER BY rowid LIMIT 1");
      const run = queued[0];
      if (!run) break;
      if (this.options.admission && !this.options.admission().hooks) { this.setRun(run, 'cancelled', 'Hook admission was paused before dispatch.'); continue; }
      const revision = this.store.db.prepare('SELECT script_id FROM automation_revisions WHERE id = ?').get(run.ruleId) as { script_id: string } | undefined;
      const row = revision && this.script(revision.script_id);
      const event = this.store.db.prepare('SELECT sequence,type,task_id,data,created_at FROM events WHERE sequence = ?').get(run.eventSequence) as { sequence: number; type: string; task_id: string | null; data: string; created_at: string } | undefined;
      if (!row || row.revision.id !== run.ruleId || !event) { this.setRun(run, 'cancelled', 'Pinned revision or source event is no longer available.'); continue; }
      const source: EventSource = { sequence: event.sequence, type: event.type, ...(event.task_id ? { taskId: event.task_id } : {}), data: JSON.parse(event.data) as unknown, createdAt: event.created_at };
      const execution = this.dispatchScript(row, run, source);
      this.runningPromises.add(execution);
      try { await execution; } finally { this.runningPromises.delete(execution); }
    } } finally { this.pumping = false; }
  }
  private inProject(projectPath: string | null, taskId?: string): boolean {
    if (!projectPath) return true;
    if (!taskId) return false;
    try { return this.store.task(taskId).projectPath === projectPath; } catch { return false; }
  }
  private enqueue(ruleId: string, ruleVersion: number, eventSequence: number): HookRun | null {
    const run: HookRun = { id: randomUUID(), ruleId, ruleVersion, eventSequence, state: 'queued', createdAt: this.now().toISOString(), updatedAt: this.now().toISOString() };
    const inserted = this.store.db.prepare('INSERT OR IGNORE INTO automation_runs(id,rule_id,rule_version,event_sequence,state,data) VALUES(?,?,?,?,?,?)').run(run.id, ruleId, ruleVersion, eventSequence, run.state, JSON.stringify(run));
    return inserted.changes ? run : null;
  }
  private setRun(run: HookRun, state: HookRun['state'], detail?: string): void {
    run.state = state; run.updatedAt = this.now().toISOString(); if (detail) run.detail = this.redactor.text(detail).slice(0, 1000);
    this.store.db.prepare('UPDATE automation_runs SET state = ?, data = ? WHERE id = ?').run(state, JSON.stringify(run), run.id);
  }
  private async dispatchScript(row: RegistrationRow, run: HookRun, event: EventSource): Promise<void> {
    if (this.scriptBusy) return; // queued, never dispatched; a later pump may claim it.
    if (this.options.admission && !this.options.admission().hooks) { this.setRun(run, 'cancelled', 'Hook admission was paused before dispatch.'); return; }
    const grant = this.grantFor(row.revision.id);
    if (!grant || Date.parse(grant.expiresAt) <= this.now().getTime()) { this.setRun(run, 'cancelled', 'No current trust grant.'); return; }
    const count = this.store.db.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE rule_id = ? AND state IN ('dispatching','running','complete','failed','unknown') AND json_extract(data,'$.updatedAt') >= ?").get(row.revision.id, new Date(this.now().getTime() - 86_400_000).toISOString()) as { count: number };
    if (count.count >= grant.maxRunsPer24h) { this.setRun(run, 'cancelled', 'Trust grant daily run limit reached.'); return; }
    this.scriptBusy = true;
    try {
      // Registrations saved before network paths were refused are re-checked before anything touches their files.
      if (isNetworkOrDevicePath(row.registration.cwd)) { this.setRun(run, 'cancelled', 'Hook working directory must not be on a network share.'); return; }
      await this.validateRevision(row);
      const currentGrant = this.grantFor(row.revision.id);
      if (!currentGrant || Date.parse(currentGrant.expiresAt) <= this.now().getTime()) { this.setRun(run, 'cancelled', 'Trust grant was revoked or expired.'); return; }
      const controller = new AbortController(); this.running.set(row.revision.id, controller);
      const approval = event.type === 'approval.changed' && event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as Record<string, unknown> : {};
      const fields: Record<string, unknown> = { sequence: event.sequence, type: event.type, taskId: event.taskId, createdAt: event.createdAt, projectPath: event.taskId ? this.store.task(event.taskId).projectPath : undefined, title: event.taskId ? this.store.task(event.taskId).title : undefined, status: event.taskId ? this.store.task(event.taskId).status : undefined, approvalId: typeof approval.approvalId === 'string' ? approval.approvalId : undefined, approvalState: typeof approval.state === 'string' && ['awaiting-approval', 'approved', 'executing', 'complete', 'rejected', 'revoked', 'unknown', 'failed'].includes(approval.state) ? approval.state : undefined };
      const input = Object.fromEntries(row.registration.inputFields.map(key => [key, fields[key]]));
      assertScreened(this.redactor, JSON.stringify(input));
      run.grantSnapshot = currentGrant;
      run.pin = { revisionId: row.revision.id, scriptId: row.revision.scriptId, sourceSha256: row.revision.sha256, interpreterSha256: row.revision.interpreterSha256, configSha256: row.revision.configSha256 };
      this.setRun(run, 'dispatching'); // Grant and pin evidence are durable before possible launch.
      const args = row.registration.language === 'powershell' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', row.revision.snapshotPath, ...row.registration.arguments] : [row.revision.snapshotPath, ...row.registration.arguments];
      this.setRun(run, 'running');
      const result = await this.executor.execute({ command: row.revision.interpreterPath, arguments: args, cwd: row.registration.cwd, input, timeoutMs: row.registration.timeoutMs, signal: controller.signal, language: row.registration.language });
      const latest = this.script(row.registration.id);
      if (controller.signal.aborted || latest?.revision.id !== row.revision.id || this.grantFor(row.revision.id)?.id !== currentGrant.id || (this.options.admission && !this.options.admission().hooks)) { this.setRun(run, 'unknown', 'Trust, pinned revision, or feature admission changed while script was running; external effects require inspection.'); return; }
      if (!result.cleanupVerified || result.timedOut || result.cancelled) { this.setRun(run, 'unknown', 'Script ended without a confirmed clean result; external effects require inspection.'); return; }
      if (result.exitCode !== 0 || (row.registration.language === 'powershell' && result.stderr.trim())) { this.setRun(run, 'failed', result.stderr || `PowerShell exited with code ${result.exitCode}.`); return; }
      let proposals: ReturnType<typeof parseProposals>;
      try { proposals = parseProposals(result.stdout, this.redactor); }
      catch (error) { this.setRun(run, 'failed', error instanceof Error ? error.message : 'Invalid script output.'); return; }
      await this.validateRevision(row);
      let drafts: AutomationDraft[] = [];
      this.store.db.transaction(() => {
        const pinned = this.script(row.registration.id);
        if (controller.signal.aborted || pinned?.revision.id !== row.revision.id || this.grantFor(row.revision.id)?.id !== currentGrant.id || (this.options.admission && !this.options.admission().hooks)) throw new Error('Trust, pinned revision, or feature admission changed before proposals were committed.');
        drafts = proposals.map((proposal, index) => this.addDraft('hook', `${run.id}:${index}`, event.taskId ?? null, proposal.kind, proposal.title, proposal.body, false, proposal.proposal));
        this.setRun(run, 'complete');
      })();
      for (const draft of drafts) {
        try { this.publish('automation.draft.created', { draftId: draft.id, kind: draft.kind, taskId: draft.taskId }, draft.taskId ?? undefined); }
        catch { /* The committed draft is available through the durable inbox even if notification fails. */ }
      }
    } catch (error) {
      this.setRun(run, run.state === 'dispatching' || run.state === 'running' ? 'unknown' : 'failed', error instanceof Error ? error.message : 'Hook failed.');
    } finally { this.running.delete(row.revision.id); this.scriptBusy = false; }
  }
  private addDraft(source: AutomationDraft['source'], sourceId: string, taskId: string | null, kind: AutomationDraft['kind'], title: string, body: string, notify = true, proposal?: ActionProposal): AutomationDraft {
    const draft: AutomationDraft = { id: randomUUID(), source, sourceId, taskId, kind, title: this.redactor.text(title).slice(0, 2000), body: this.redactor.text(body).slice(0, 8000), ...(proposal ? { proposal } : {}), state: 'open', createdAt: this.now().toISOString() };
    const inserted = this.store.db.prepare('INSERT OR IGNORE INTO automation_drafts(id,source,source_id,data) VALUES(?,?,?,?)').run(draft.id, source, sourceId, JSON.stringify(draft));
    if (inserted.changes && notify) this.publish('automation.draft.created', { draftId: draft.id, kind, taskId }, taskId ?? undefined);
    return draft;
  }
  private dismiss(id: string): { dismissed: boolean } {
    const row = this.store.db.prepare('SELECT data FROM automation_drafts WHERE id = ?').get(id) as { data: string } | undefined;
    if (!row) return { dismissed: false };
    const draft = JSON.parse(row.data) as AutomationDraft;
    if (draft.state !== 'open') throw new Error('A prepared draft cannot be dismissed while its execution outcome is unresolved.');
    draft.state = 'dismissed';
    this.store.db.prepare('UPDATE automation_drafts SET data = ? WHERE id = ?').run(JSON.stringify(draft), id);
    return { dismissed: true };
  }
  private async prepareDraft(id: string): Promise<{ approvalId: string }> {
    if (!this.options.prepareAction) throw new Error('Action draft review is unavailable.');
    const row = this.store.db.prepare('SELECT data FROM automation_drafts WHERE id = ?').get(id) as { data: string } | undefined;
    if (!row) throw new Error('Action draft not found.');
    const draft = JSON.parse(row.data) as AutomationDraft;
    if (draft.state !== 'open' || draft.kind !== 'actionDraft' || !draft.proposal || !draft.taskId) throw new Error('This draft has no eligible action to review.');
    validateProposal(draft.proposal, this.redactor);
    const task = this.store.task(draft.taskId);
    if (task.mode !== 'coding' || task.parentTaskId || task.status !== 'idle') throw new Error('Action review requires a settled standalone coding task.');
    if (this.store.approvals(task.id).some(item => ['awaiting-approval', 'approved', 'executing', 'unknown'].includes(item.state))) throw new Error('Resolve existing approvals before reviewing this action.');
    draft.state = 'preparing';
    const claimed = this.store.db.prepare("UPDATE automation_drafts SET data = ? WHERE id = ? AND json_extract(data,'$.state') = 'open'").run(JSON.stringify(draft), id);
    if (!claimed.changes) throw new Error('This draft is already being reviewed.');
    try {
      const result = await this.options.prepareAction(draft);
      draft.state = approvalDraftState(this.store.approval(result.approvalId).state); draft.approvalId = result.approvalId;
      this.store.db.prepare('UPDATE automation_drafts SET data = ? WHERE id = ?').run(JSON.stringify(draft), id);
      return result;
    } catch (error) {
      draft.state = error instanceof ActionPreparationError && error.outcome === 'none' ? 'open' : 'unknown';
      this.store.db.prepare('UPDATE automation_drafts SET data = ? WHERE id = ?').run(JSON.stringify(draft), id);
      throw error;
    }
  }
  private syncDraftApproval(approvalId: string, state: string): void {
    const rows = this.rows<AutomationDraft>("SELECT data FROM automation_drafts WHERE json_extract(data,'$.approvalId') = ?", approvalId);
    for (const draft of rows) {
      draft.state = approvalDraftState(state);
      this.store.db.prepare('UPDATE automation_drafts SET data = ? WHERE id = ?').run(JSON.stringify(draft), draft.id);
    }
  }
  private saveSchedule(schedule: Schedule): Schedule {
    if (schedule.enabled && this.options.admission && !this.options.admission().scheduling) throw new Error('Scheduling admission is paused; save the schedule disabled or re-enable scheduling explicitly.');
    assertScreened(this.redactor, JSON.stringify(schedule));
    if (schedule.taskId) {
      const task = this.store.task(schedule.taskId);
      if (schedule.projectPath !== task.projectPath) throw new Error('Scheduled task must match its project scope.');
    }
    const previous = this.store.db.prepare('SELECT data,revision FROM automation_schedules WHERE id = ?').get(schedule.id) as { data: string; revision: string } | undefined;
    if (!previous && (this.store.db.prepare('SELECT COUNT(*) AS count FROM automation_schedules').get() as { count: number }).count >= 100) throw new Error('At most 100 schedules may be registered.');
    let formatter: Intl.DateTimeFormat;
    try { formatter = scheduleFormatter(schedule.timeZone); } catch { throw new Error('Unknown time zone.'); }
    if (schedule.cadence === 'weekly' && schedule.weekDay === null) throw new Error('Weekly schedules require a weekday.');
    if (schedule.cadence === 'once') {
      const localDate = schedule.startDate ?? localStamp(formatter, Date.parse(schedule.startAt)).slice(0, 10);
      if (resolveLocalInstant(formatter, localDate, schedule.localTime) < Date.parse(schedule.startAt)) throw new Error('Choose a one-time reminder at or after its activation instant.');
    }
    const data = JSON.stringify(schedule);
    const revision = previous?.data === data ? previous.revision : randomUUID();
    this.store.db.prepare('INSERT INTO automation_schedules(id,data,revision) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision').run(schedule.id, data, revision);
    return schedule;
  }
  /** One most-recent due occurrence per schedule: missed app-closed periods coalesce. */
  tick(now: Date): number {
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid schedule time.');
    if (this.options.admission && !this.options.admission().scheduling) return 0;
    let created = 0;
    for (const row of this.store.db.prepare('SELECT data,revision FROM automation_schedules ORDER BY id').all() as { data: string; revision: string }[]) {
      const schedule = JSON.parse(row.data) as Schedule;
      if (!schedule.enabled) continue;
      const due = dueOccurrence(schedule, now);
      if (!due) continue;
      const key = `${row.revision}:${due.localDate}`;
      const occurrence = { revision: row.revision, localDate: due.localDate, localTime: schedule.localTime, timeZone: schedule.timeZone, dueAt: due.dueAt };
      const draftId = randomUUID();
      this.store.db.transaction(() => {
        const inserted = this.store.db.prepare('INSERT OR IGNORE INTO automation_schedule_occurrences(schedule_id,local_key,draft_id,data) VALUES(?,?,?,?)').run(schedule.id, key, draftId, JSON.stringify(occurrence));
        if (!inserted.changes) return;
        const draft: AutomationDraft = { id: draftId, source: 'schedule', sourceId: `${schedule.id}:${key}`, taskId: schedule.taskId, kind: schedule.kind === 'reminder' ? 'notification' : 'promptDraft', title: schedule.title, body: schedule.body, state: 'open', createdAt: now.toISOString(), occurrence };
        this.store.db.prepare('INSERT INTO automation_drafts(id,source,source_id,data) VALUES(?,?,?,?)').run(draft.id, draft.source, draft.sourceId, JSON.stringify(draft));
        created++;
      })();
    }
    if (created) this.publish('automation.schedule.drafts', { created });
    return created;
  }
  async close(): Promise<void> { this.closing = true; for (const controller of this.running.values()) controller.abort(); await this.drainPromise?.catch(() => undefined); await Promise.allSettled([...this.runningPromises]); }
}

function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function approvalDraftState(state: string): AutomationDraft['state'] {
  return ['complete', 'rejected', 'revoked', 'failed', 'unknown'].includes(state) ? state as AutomationDraft['state'] : 'awaiting-approval';
}
function scriptSnapshotBytes(value: ScriptRegistration): Buffer { return Buffer.from(`${value.language === 'powershell' ? '\uFEFF' : ''}${value.source}`, 'utf8'); }
function configDigest(value: ScriptRegistration): string { return digest(JSON.stringify({ ...value, source: undefined, ...(value.language === 'powershell' ? { launcherSha256: POWERSHELL_LAUNCHER_SHA256 } : {}) })); }
function assertScreened(redactor: Redactor, value: string): void { if (redactor.text(value) !== value) throw new Error('Automation input contains secret-like content.'); }
function omitSource(registration: ScriptRegistration): Omit<ScriptRegistration, 'source'> { const { source: _source, ...rest } = registration; return rest; }
async function defaultInterpreter(language: ScriptRegistration['language']): Promise<{ path: string; version: string }> {
  if (language === 'javascript') return { path: process.execPath, version: process.version };
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return { path: path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), version: 'WindowsPowerShell-5.1' };
}
function validateProposal(input: ActionProposal, redactor: Redactor): ActionProposal {
  const proposal = ActionProposalSchema.parse(input);
  const args = ToolArguments[proposal.tool].parse(proposal.arguments);
  if (proposal.tool === 'run_command' && 'environment' in args && Object.keys(args.environment).length) throw new Error('Hook commands cannot supply environment variables.');
  assertScreened(redactor, JSON.stringify({ tool: proposal.tool, arguments: args }));
  return { tool: proposal.tool, arguments: args };
}
function parseProposals(stdout: string, redactor: Redactor): { kind: AutomationDraft['kind']; title: string; body: string; proposal?: ActionProposal }[] {
  if (!stdout.trim()) return [];
  if (Buffer.byteLength(stdout, 'utf8') > 64 * 1024) throw new Error('Hook output exceeds 64 KiB.');
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length > MAX_DRAFTS_PER_RUN) throw new Error('Hook must return an array of at most ten drafts.');
  return parsed.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid hook proposal.');
    const value = item as Record<string, unknown>;
    if (Object.keys(value).some(key => !['kind', 'title', 'body', 'proposal'].includes(key)) || !['notification', 'label', 'promptDraft', 'actionDraft'].includes(String(value.kind)) || typeof value.title !== 'string' || typeof value.body !== 'string' || value.title.length > 2000 || value.body.length > 8000 || (value.proposal !== undefined && value.kind !== 'actionDraft')) throw new Error('Hook proposal contains unsupported fields.');
    assertScreened(redactor, JSON.stringify(value));
    const proposal = value.proposal === undefined ? undefined : validateProposal(value.proposal as ActionProposal, redactor);
    return { kind: value.kind as AutomationDraft['kind'], title: value.title, body: value.body, ...(proposal ? { proposal } : {}) };
  });
}
function dueOccurrence(schedule: Schedule, now: Date): { localDate: string; dueAt: string } | null {
  if (now.getTime() < Date.parse(schedule.startAt)) return null;
  const formatter = scheduleFormatter(schedule.timeZone);
  const today = localStamp(formatter, now.getTime()).slice(0, 10);
  const startDay = schedule.startDate ?? localStamp(formatter, Date.parse(schedule.startAt)).slice(0, 10);
  if (schedule.cadence === 'once') {
    const dueAt = resolveLocalInstant(formatter, startDay, schedule.localTime);
    return dueAt >= Date.parse(schedule.startAt) && dueAt <= now.getTime() ? { localDate: startDay, dueAt: new Date(dueAt).toISOString() } : null;
  }
  let date = new Date(`${today}T12:00:00Z`);
  if (schedule.cadence === 'weekly') {
    while (date.getUTCDay() !== schedule.weekDay) date = new Date(date.getTime() - 86_400_000);
  }
  let candidate = date.toISOString().slice(0, 10);
  let dueAt = resolveLocalInstant(formatter, candidate, schedule.localTime);
  if (dueAt > now.getTime()) {
    date = new Date(date.getTime() - (schedule.cadence === 'weekly' ? 7 : 1) * 86_400_000);
    candidate = date.toISOString().slice(0, 10); dueAt = resolveLocalInstant(formatter, candidate, schedule.localTime);
  }
  return candidate >= startDay && dueAt >= Date.parse(schedule.startAt) ? { localDate: candidate, dueAt: new Date(dueAt).toISOString() } : null;
}

function scheduleFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function localStamp(formatter: Intl.DateTimeFormat, instant: number): string {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
/** Earliest matching instant for a fold; first valid instant after a gap. No host-zone arithmetic. */
function resolveLocalInstant(formatter: Intl.DateTimeFormat, date: string, time: string): number {
  const wall = `${date}T${time}`; const nominal = Date.parse(`${wall}:00Z`);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = nominal + hours * 3_600_000;
    offsets.add(Date.parse(`${localStamp(formatter, sample)}:00Z`) - sample);
  }
  const candidates = [...offsets].map(offset => nominal - offset).sort((a, b) => a - b);
  const exact = candidates.find(candidate => localStamp(formatter, candidate) === wall);
  if (exact !== undefined) return exact;
  // No matching wall time exists: the interval brackets the forward clock transition.
  let low = Math.floor(candidates[0]! / 60_000); let high = Math.floor(candidates.at(-1)! / 60_000);
  if (localStamp(formatter, low * 60_000) >= wall || localStamp(formatter, high * 60_000) < wall) throw new Error('Could not resolve schedule wall-clock time.');
  while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (localStamp(formatter, middle * 60_000) < wall) low = middle; else high = middle; }
  return high * 60_000;
}

/** Exported only for the WPF migration golden vectors (tests/golden); not a runtime API. */
export const scheduleInternals = { scheduleFormatter, localStamp, resolveLocalInstant, dueOccurrence } as const;
