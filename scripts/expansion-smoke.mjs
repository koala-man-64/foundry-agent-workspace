import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function until(label, probe, attempts = 300) {
  for (let count = 0; count < attempts; count++) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Expansion smoke timed out waiting for ${label}; inspect the isolated runtime before retrying any unknown work.`);
}

/** Exercise expansion paths through a packaged runtime's JSON-RPC connection and isolated fixture. */
export async function verifyExpansion({ invoke, crashAndRestart, source, directory, profileId }) {
  const schema = await invoke('workspace.schema', {});
  assert.equal(schema.version, 3, 'Packaged expansion smoke requires the verified v3 runtime.');
  const marker = `expansionsmoke${randomUUID().replaceAll('-', '')}`;
  const coding = await invoke('task.create', { title: marker, projectPath: source, profileId, mode: 'coding', tokenBudget: 200000 });
  await invoke('task.send', { taskId: coding.id, content: '/demo' });
  const first = await until('coding approval', async () => {
    const approvals = await invoke('task.approvals', { taskId: coding.id, limit: 50 });
    const pending = approvals.approvals.find(item => item.state === 'awaiting-approval');
    return pending && { pending, read: await invoke('task.read', { taskId: coding.id }) };
  });
  assert.equal(first.read.task.status, 'running');
  const archived = await invoke('task.setArchived', { taskId: coding.id, archived: true });
  assert.ok(archived.archivedAt);
  const listed = await invoke('workspace.tasks', { visibility: 'archived', limit: 50 });
  assert.ok(listed.tasks.some(item => item.id === coding.id));
  const actions = await invoke('workspace.actions', { limit: 50 });
  assert.ok(actions.items.some(item => item.taskId === coding.id && item.archived && item.kind === 'approval' && item.state === 'awaiting-approval'), 'Archived pending approval must remain in the global action center.');
  for (let count = 0; count < 300; count++) {
    const read = await invoke('task.read', { taskId: coding.id });
    const summaries = await invoke('task.approvals', { taskId: coding.id, limit: 50 });
    for (const item of summaries.approvals.filter(value => value.state === 'awaiting-approval')) {
      const review = await invoke('approval.get', { taskId: coding.id, approvalId: item.id });
      assert.equal(review.truncatedFields.length, 0, 'The smoke must review complete approval evidence.');
      const approval = review.approval;
      assert.ok(['replace_text', 'run_command'].includes(approval.tool), `Unexpected smoke approval: ${approval.tool}`);
      await invoke('approval.decide', { taskId: coding.id, approvalId: approval.id, nonce: approval.nonce, decision: 'approve' });
    }
    if (read.task.status !== 'running') break;
    await delay(100);
  }
  const settled = await invoke('task.read', { taskId: coding.id });
  assert.equal(settled.task.status, 'idle', 'Archived coding task must settle after ordinary edit and command approvals.');
  assert.ok(settled.task.archivedAt, 'Completing a task must not unarchive it.');
  const finalApprovals = await invoke('task.approvals', { taskId: coding.id, limit: 50 });
  assert.deepEqual(finalApprovals.approvals.map(item => item.tool).sort(), ['replace_text', 'run_command']);
  assert.ok(finalApprovals.approvals.every(item => item.state === 'complete'));
  const titleSearch = await invoke('workspace.search', { query: marker, visibility: 'archived', limit: 50 });
  assert.ok(titleSearch.hits.some(hit => hit.taskId === coding.id));
  const messageSearch = await invoke('workspace.search', { query: 'demo', visibility: 'archived', limit: 50 });
  assert.ok(messageSearch.hits.some(hit => hit.taskId === coding.id && hit.messageId), 'FTS must find archived message text.');

  const sourceTask = await invoke('task.create', { title: 'Expansion continuation source', projectPath: source, profileId, mode: 'chat', tokenBudget: 200000 });
  const selectedText = `Selected context ${marker}`;
  await invoke('task.send', { taskId: sourceTask.id, content: selectedText });
  await until('continuation source settling', async () => (await invoke('task.read', { taskId: sourceTask.id })).task.status === 'idle');
  const sourceMessages = await invoke('task.messages', { taskId: sourceTask.id, limit: 50 });
  const selected = sourceMessages.items.find(item => item.message.role === 'user' && item.message.content === selectedText)?.message;
  assert.ok(selected, 'Completed user message must be selectable.');
  const preview = await invoke('task.continuationPreview', { taskId: sourceTask.id, messageIds: [selected.id] });
  assert.deepEqual(preview.messageIds, [selected.id]);
  assert.ok(preview.context.includes(selectedText));
  assert.ok(preview.warnings.some(value => value.includes('Approvals')));
  const fork = await invoke('task.continue', { previewId: preview.id, title: 'Expansion context fork', profileId, tokenBudget: 200000, mode: 'chat' });
  assert.equal(fork.status, 'idle');
  const forkMessages = await invoke('task.messages', { taskId: fork.id, limit: 50 });
  assert.ok(forkMessages.items.some(item => item.message.content.includes(selectedText)));
  assert.equal((await invoke('task.approvals', { taskId: fork.id, limit: 50 })).approvals.length, 0, 'Historical context must not carry approval authority.');
  const transcript = await invoke('task.exportTranscript', { taskId: coding.id, includeChildren: false });
  assert.ok(resolve(transcript.path).startsWith(resolve(join(directory, 'data'))), 'Export must stay in the isolated profile.');
  const files = new Map(transcript.files.map(item => [item.name, item]));
  for (const file of transcript.files) {
    const bytes = await readFile(join(transcript.path, file.name));
    assert.equal(bytes.length, file.bytes);
    assert.equal(digest(bytes), file.sha256);
  }
  const manifest = JSON.parse(await readFile(join(transcript.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'foundry-transcript-manifest');
  assert.deepEqual(manifest.files.map(item => item.name).sort(), ['transcript.json', 'transcript.md']);
  assert.equal(files.size, 3);
  const exported = JSON.parse(await readFile(join(transcript.path, 'transcript.json'), 'utf8'));
  assert.equal(exported.format, 'foundry-transcript');
  assert.ok(exported.tasks.some(item => item.id === coding.id));

  const ruleId = randomUUID();
  await invoke('automation.rule.save', { id: ruleId, version: 1, name: 'Built-in completion note', enabled: true, triggers: ['task.completed'], projectPath: source, action: 'notification', title: 'Completed review', body: marker });
  const unicode = 'café 東京 😀';
  const unicodeTriggerTitle = `Expansion hook trigger ${unicode}`;
  const scriptIds = [];
  const registrations = new Map();
  const descendantPidPath = join(directory, `hook-descendant-${marker}.pid`);
  for (const language of ['javascript', 'powershell']) {
    const scriptId = randomUUID();
    const sourceCode = language === 'javascript'
      ? `const fs=require('fs'); const cp=require('child_process'); const e=JSON.parse(fs.readFileSync(0,'utf8')); if(e.type!=='task.completed') process.exit(4); const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore'}); child.unref(); fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid)); process.stdout.write(JSON.stringify([{kind:'notification',title:'JS hook',body:'${marker}'}]));`
      : `#requires -Version 5.1
param([string]$Label)
$e=[Console]::In.ReadToEnd() | ConvertFrom-Json; if($e.type -ne 'task.completed'){exit 4}; [Console]::Out.Write('[' + ((@{kind='notification';title=$Label;body=($e.title + ' café 東京 😀')} | ConvertTo-Json -Compress)) + ']')`;
    const revision = await invoke('automation.script.register', { id: scriptId, name: `${language} smoke`, language, source: sourceCode, triggers: ['task.completed'], projectPath: source, arguments: language === 'powershell' ? ['-Label', unicode] : [], cwd: source, inputFields: language === 'powershell' ? ['sequence', 'type', 'taskId', 'title'] : ['sequence', 'type', 'taskId'], timeoutMs: 30000 });
    const reviewed = await invoke('automation.script.source', { revisionId: revision.id });
    assert.equal(reviewed.source, sourceCode);
    assert.equal(reviewed.revision.sha256, revision.sha256);
    await invoke('automation.script.grant', { revisionId: revision.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxRunsPer24h: 100 });
    scriptIds.push(revision.id);
    registrations.set(language, { scriptId, sourceCode, revision });
  }
  const trigger = await invoke('task.create', { title: unicodeTriggerTitle, projectPath: source, profileId, mode: 'chat', tokenBudget: 200000 });
  await invoke('task.send', { taskId: trigger.id, content: 'Run the offline hook smoke.' });
  await until('hook source task settling', async () => (await invoke('task.read', { taskId: trigger.id })).task.status === 'idle');
  await until('both packaged Job scripts and built-in rule completing', async () => {
    const state = await invoke('automation.list', {});
    const relevant = state.runs.filter(item => (scriptIds.includes(item.ruleId) || item.ruleId === ruleId) && ['complete', 'failed', 'unknown', 'cancelled'].includes(item.state));
    if (relevant.some(item => item.state !== 'complete')) throw new Error(`Packaged hook failed or has unknown external effects: ${JSON.stringify(relevant)}`);
    return relevant.length === 3 && state.drafts.some(item => item.title === 'JS hook') && state.drafts.some(item => item.title === unicode && item.body === `${unicodeTriggerTitle} ${unicode}`) && state.drafts.some(item => item.title === 'Completed review') && state;
  }, 600);
  const initialRuns = (await invoke('automation.list', {})).runs;
  for (const id of [...scriptIds, ruleId]) assert.equal(initialRuns.filter(item => item.ruleId === id).length, 1, 'A single durable completion event must run each rule exactly once.');
  const descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  assert.throws(() => process.kill(descendantPid, 0), 'The packaged Job host must terminate script descendants before reporting success.');

  const originalJs = registrations.get('javascript');
  const replacement = await invoke('automation.script.register', { id: originalJs.scriptId, name: 'javascript changed source', language: 'javascript', source: `require('fs').readFileSync(0,'utf8'); process.stdout.write('malformed proposal');`, triggers: ['task.completed'], projectPath: source, arguments: [], cwd: source, inputFields: ['sequence', 'type', 'taskId'], timeoutMs: 30000 });
  assert.notEqual(replacement.id, originalJs.revision.id);
  await assert.rejects(() => invoke('automation.script.grant', { revisionId: originalJs.revision.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxRunsPer24h: 100 }), /current script revision/i);
  const beforeUntrusted = await invoke('automation.list', {});
  const untrustedTask = await invoke('task.create', { title: 'Expansion changed hook untrusted', projectPath: source, profileId, mode: 'chat', tokenBudget: 200000 });
  await invoke('task.send', { taskId: untrustedTask.id, content: 'A changed script has no inherited grant.' });
  await until('changed-script untrusted event processing', async () => {
    if ((await invoke('task.read', { taskId: untrustedTask.id })).task.status !== 'idle') return false;
    const state = await invoke('automation.list', {});
    return state.runs.filter(item => item.ruleId === ruleId).length > beforeUntrusted.runs.filter(item => item.ruleId === ruleId).length && state;
  });
  const afterUntrusted = await invoke('automation.list', {});
  assert.equal(afterUntrusted.runs.filter(item => item.ruleId === replacement.id).length, 0, 'A changed script must not launch before a new grant.');
  assert.equal(afterUntrusted.runs.filter(item => item.ruleId === originalJs.revision.id).length, 1, 'The replaced revision must not relaunch.');
  await invoke('automation.script.grant', { revisionId: replacement.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxRunsPer24h: 100 });
  const oversizedId = randomUUID();
  const oversized = await invoke('automation.script.register', { id: oversizedId, name: 'oversized output', language: 'javascript', source: `require('fs').readFileSync(0,'utf8'); process.stdout.write('x'.repeat(65537));`, triggers: ['task.completed'], projectPath: source, arguments: [], cwd: source, inputFields: ['sequence', 'type', 'taskId'], timeoutMs: 30000 });
  await invoke('automation.script.grant', { revisionId: oversized.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxRunsPer24h: 100 });
  const invalidTask = await invoke('task.create', { title: 'Expansion invalid output trigger', projectPath: source, profileId, mode: 'chat', tokenBudget: 200000 });
  await invoke('task.send', { taskId: invalidTask.id, content: 'Invalid output must remain inert.' });
  await until('malformed and oversized hook outcomes', async () => {
    const state = await invoke('automation.list', {});
    const runs = [replacement.id, oversized.id].map(id => state.runs.find(item => item.ruleId === id));
    return runs.every(run => run && ['failed', 'unknown'].includes(run.state)) && state;
  }, 600);
  const invalidState = await invoke('automation.list', {});
  assert.equal(invalidState.runs.filter(item => item.ruleId === replacement.id).length, 1);
  assert.equal(invalidState.runs.filter(item => item.ruleId === oversized.id).length, 1);
  const invalidRunIds = invalidState.runs.filter(run => [replacement.id, oversized.id].includes(run.ruleId)).map(run => run.id);
  assert.ok(!invalidState.drafts.some(item => invalidRunIds.some(id => item.sourceId.startsWith(`${id}:`))), 'Malformed or oversized output must create no proposals.');

  const beforeRevoke = await invoke('automation.list', {});
  const activeIds = [registrations.get('powershell').revision.id, replacement.id, oversized.id];
  for (const revisionId of activeIds) assert.equal((await invoke('automation.script.revoke', { revisionId })).revoked, true);
  const afterRevokeTask = await invoke('task.create', { title: 'Expansion revoked hook trigger', projectPath: source, profileId, mode: 'chat', tokenBudget: 200000 });
  await invoke('task.send', { taskId: afterRevokeTask.id, content: 'Confirm revoked hooks stay inactive.' });
  await until('post-revoke source settling', async () => (await invoke('task.read', { taskId: afterRevokeTask.id })).task.status === 'idle');
  const previousRuleRuns = beforeRevoke.runs.filter(item => item.ruleId === ruleId).length;
  const postRevoke = await until('post-revoke event processing', async () => {
    const state = await invoke('automation.list', {});
    return state.runs.filter(item => item.ruleId === ruleId).length > previousRuleRuns && state;
  });
  for (const revisionId of activeIds) {
    const priorIds = new Set(beforeRevoke.runs.filter(item => item.ruleId === revisionId).map(item => item.id));
    const later = postRevoke.runs.filter(item => item.ruleId === revisionId && !priorIds.has(item.id));
    assert.ok(later.every(item => item.state === 'cancelled'), `Revoked script dispatched again: ${JSON.stringify(later)}`);
  }

  const racePidPath = join(directory, `hook-revoke-${marker}.pid`);
  const race = await invoke('automation.script.register', { id: randomUUID(), name: 'running revocation', language: 'javascript', source: `const fs=require('fs'); fs.readFileSync(0,'utf8'); fs.writeFileSync(${JSON.stringify(racePidPath)},String(process.pid)); setTimeout(()=>process.stdout.write(JSON.stringify([{kind:'notification',title:'Revoked race proposal',body:'${marker}'}])),120000);`, triggers: ['task.completed'], projectPath: source, arguments: [], cwd: source, inputFields: ['sequence', 'type', 'taskId'], timeoutMs: 30000 });
  await invoke('automation.script.grant', { revisionId: race.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxRunsPer24h: 100 });
  const raceTask = await invoke('task.create', { title: 'Expansion running revoke', projectPath: source, profileId, mode: 'chat', tokenBudget: 200000 });
  await invoke('task.send', { taskId: raceTask.id, content: 'Start the cancellable hook.' });
  const racePid = Number(await until('packaged hook process launch', async () => readFile(racePidPath, 'utf8').catch(() => '')));
  assert.ok(Number.isSafeInteger(racePid) && racePid > 0);
  assert.equal((await invoke('automation.script.revoke', { revisionId: race.id })).revoked, true);
  const raceResult = await until('running hook cancellation', async () => {
    const state = await invoke('automation.list', {});
    const run = state.runs.find(item => item.ruleId === race.id);
    return run && ['unknown', 'cancelled', 'failed'].includes(run.state) && { run, state };
  }, 300);
  assert.ok(['unknown', 'cancelled'].includes(raceResult.run.state), 'A running revoked hook cannot complete successfully.');
  assert.ok(!raceResult.state.drafts.some(item => item.title === 'Revoked race proposal'), 'Revocation must discard a running hook proposal.');
  assert.throws(() => process.kill(racePid, 0), 'Revocation must terminate the packaged hook process.');

  const scheduleId = randomUUID();
  const messagesBeforeSchedule = (await invoke('task.messages', { taskId: coding.id, limit: 50 })).items.length;
  await invoke('automation.schedule.save', { id: scheduleId, name: 'Archived review reminder', enabled: true, projectPath: source, taskId: coding.id, kind: 'reminder', title: 'Archived task check-in', body: marker, cadence: 'once', localTime: '00:00', timeZone: 'UTC', startAt: '2020-01-01T00:00:00.000Z', weekDay: null });
  assert.equal((await invoke('automation.schedule.tick', {})).created, 1);
  assert.equal((await invoke('automation.schedule.tick', {})).created, 0);
  const scheduled = await invoke('automation.list', {});
  assert.ok(scheduled.drafts.some(item => item.source === 'schedule' && item.taskId === coding.id && item.title === 'Archived task check-in'));
  assert.equal((await invoke('task.messages', { taskId: coding.id, limit: 50 })).items.length, messagesBeforeSchedule, 'A schedule may prepare an Inbox draft but must not call a model.');

  const crashPidPath = join(directory, `hook-crash-${marker}.json`);
  const crashRevision = await invoke('automation.script.register', { id: randomUUID(), name: 'unknown recovery', language: 'javascript', source: `const fs=require('fs'); const cp=require('child_process'); fs.readFileSync(0,'utf8'); const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(crashPidPath)},JSON.stringify({script:process.pid,descendant:child.pid})); setTimeout(()=>process.stdout.write(JSON.stringify([{kind:'notification',title:'Replayed crash proposal',body:'${marker}'}])),120000);`, triggers: ['task.completed'], projectPath: source, arguments: [], cwd: source, inputFields: ['sequence', 'type', 'taskId'], timeoutMs: 30000 });
  await invoke('automation.script.grant', { revisionId: crashRevision.id, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxRunsPer24h: 100 });
  const crashTask = await invoke('task.create', { title: 'Expansion crash recovery', projectPath: source, profileId, mode: 'chat', tokenBudget: 200000 });
  await invoke('task.send', { taskId: crashTask.id, content: 'Start the crash recovery hook.' });
  const crashPids = JSON.parse(await until('running packaged hook and descendant before crash', async () => readFile(crashPidPath, 'utf8').catch(() => '')));
  assert.ok(Number.isSafeInteger(crashPids.script) && Number.isSafeInteger(crashPids.descendant));
  const launched = await until('durable running hook before runtime crash', async () => {
    const state = await invoke('automation.list', {});
    return state.runs.find(item => item.ruleId === crashRevision.id && item.state === 'running');
  });
  assert.ok(launched.grantSnapshot && launched.pin, 'The running hook must persist its grant and pin before process launch.');
  await crashAndRestart();
  assert.equal((await invoke('workspace.schema', {})).version, 3, 'Restart must reopen the same v3 profile.');
  const recovered = await until('durable unknown hook after real packaged runtime crash', async () => {
    const state = await invoke('automation.list', {});
    return state.runs.find(item => item.id === launched.id && item.state === 'unknown') && state;
  });
  assert.equal(recovered.runs.filter(item => item.id === launched.id).length, 1);
  assert.ok(!recovered.drafts.some(item => item.title === 'Replayed crash proposal'), 'An unknown script outcome must never produce a proposal.');
  await until('crashed Job script and descendant termination', async () => {
    try { process.kill(crashPids.script, 0); return false; } catch { /* terminated */ }
    try { process.kill(crashPids.descendant, 0); return false; } catch { return true; }
  }, 100);
  await delay(500);
  const noReplay = await invoke('automation.list', {});
  assert.equal(noReplay.runs.filter(item => item.ruleId === crashRevision.id).length, 1, 'Restart must not replay a dispatched or running hook.');
  assert.equal(noReplay.runs.find(item => item.id === launched.id)?.state, 'unknown');
  assert.equal((await invoke('automation.script.revoke', { revisionId: crashRevision.id })).revoked, true);
  await stat(join(transcript.path, 'manifest.json'));
  return { archivedTaskId: coding.id, continuationTaskId: fork.id, scriptRevisionIds: [...scriptIds, replacement.id, oversized.id, race.id, crashRevision.id], scheduleId, transcriptPath: transcript.path, unknownRunId: launched.id };
}
