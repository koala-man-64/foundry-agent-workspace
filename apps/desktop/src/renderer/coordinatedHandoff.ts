import type { IntegrationOperation, OrchestrationView } from '../../../../packages/protocol/src/orchestration';

export interface CoordinatedHandoffReport {
  format: 'foundry-coordinated-handoff';
  version: 1;
  capturedAt: string;
  rootTaskId: string;
  completionRecordedAt: string;
  containsCode: false;
  repository: { branch: string; head: string; tree: string };
  validation: { id: string; recordedAt: string; head: string; tree: string; branch: string; passed: true; clean: true; exitCode: 0; cleanupVerified: true };
  integrations: { id: string; assignmentId: string; resultId: string; kind: IntegrationOperation['kind']; state: IntegrationOperation['state']; sourceCommit: string; expectedHead: string; expectedTree: string; observedCommit: string | null; observedTree: string | null; resolvedTree: string | null }[];
  childResults: { id: string; assignmentId: string; childTaskId: string; revision: number; baseCommit: string; commit: string; tree: string; manifestSha256: string; validationEvidenceIds: string[] }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const TERMINAL_INTEGRATION_STATES = new Set(['succeeded', 'continued', 'rejected', 'revoked', 'failed']);
const INVALID_REF_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', '\\']);

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function id(value: string): string {
  requireValue(UUID.test(value), 'The handoff contains an invalid identifier. Refresh the task before exporting.');
  return value;
}

function gitObject(value: string): string {
  requireValue(GIT_OBJECT.test(value), 'The handoff needs full Git commit and tree identifiers.');
  return value;
}

function isoDate(value: string): string {
  const milliseconds = Date.parse(value);
  requireValue(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value, 'The handoff contains an invalid evidence timestamp.');
  return value;
}

function branchName(value: string): string {
  const invalidCharacter = [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || INVALID_REF_CHARACTERS.has(character);
  });
  const valid = value.length > 0 && value.length <= 1024 && value !== 'HEAD' && !invalidCharacter
    && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.')
    && !value.includes('..') && !value.includes('//') && !value.includes('@{')
    && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));
  requireValue(valid, 'The handoff needs the coordinator branch name.');
  return value;
}

/** Metadata snapshot only. The caller must fetch orchestration.get immediately before use.
 * This report is not an execution permission or an atomic repository seal.
 */
export function createCoordinatedHandoff(view: OrchestrationView, rootTaskId: string, exportedAt = new Date()): CoordinatedHandoffReport {
  id(rootTaskId);
  requireValue(view.rootTaskId === rootTaskId, 'The handoff belongs to a different coordinated task.');
  requireValue(!view.truncated && view.runsCursor === null, 'The task metadata is incomplete. A complete task view is required to export a handoff.');
  requireValue(view.completion.complete && view.completion.blockers.length === 0 && view.completion.completedAt, `The coordinated work is not currently verified as complete.${view.completion.blockers[0] ? ` ${view.completion.blockers[0]}` : ''}`);
  const coordinators = view.runs.filter(run => run.role === 'coordinator');
  const coordinator = coordinators[0];
  requireValue(coordinators.length === 1 && coordinator?.taskId === rootTaskId && coordinator.rootTaskId === rootTaskId, 'The coordinator identity could not be verified.');
  requireValue(coordinator.lifecycle === 'terminal' && coordinator.outcome === 'succeeded' && !coordinator.cancelRequested, 'Wait for the coordinator to finish successfully before exporting a handoff.');
  requireValue(view.runs.every(run => run.rootTaskId === rootTaskId && run.lifecycle === 'terminal'), 'Wait for every child agent to finish before exporting a handoff.');

  // The runtime returns evidence newest first. Never skip a newer failed combined
  // validation in favor of an older passing row, or infer one missing from the page.
  const evidence = view.evidence.find(item => item.kind === 'combined');
  requireValue(evidence && evidence.rootTaskId === rootTaskId && evidence.runTaskId === rootTaskId, 'The current combined validation evidence is unavailable.');
  requireValue(evidence.passed && evidence.clean && evidence.exitCode === 0 && evidence.cleanupVerified, 'The latest combined validation must pass on a clean tree with verified cleanup.');
  const branch = branchName(coordinator.branch);
  requireValue(evidence.branch === branch, 'The validation evidence does not match the coordinator branch.');
  const head = gitObject(evidence.head);
  const tree = gitObject(evidence.tree);
  const resultsById = new Map(view.results.map(result => [result.id, result]));
  const assignmentIds = new Set(view.assignments.map(assignment => assignment.id));
  const childIds = new Set(view.runs.filter(run => run.role === 'child').map(run => run.taskId));
  requireValue(view.integrations.every(operation => operation.rootTaskId === rootTaskId && resultsById.get(operation.resultId)?.assignmentId === operation.assignmentId && assignmentIds.has(operation.assignmentId)), 'The integration references are incomplete or belong to another task.');
  requireValue(view.results.every(result => result.rootTaskId === rootTaskId && assignmentIds.has(result.assignmentId) && childIds.has(result.childTaskId)), 'The child result references are incomplete or belong to another task.');
  requireValue(view.integrations.every(operation => (operation.kind === 'cherry-pick' || operation.kind === 'continue') && TERMINAL_INTEGRATION_STATES.has(operation.state)), 'An integration still needs review or reconciliation before export.');

  return {
    format: 'foundry-coordinated-handoff', version: 1, capturedAt: isoDate(exportedAt.toISOString()),
    rootTaskId, completionRecordedAt: isoDate(view.completion.completedAt), containsCode: false,
    repository: { branch, head, tree },
    validation: { id: id(evidence.id), recordedAt: isoDate(evidence.createdAt), head, tree, branch, passed: true, clean: true, exitCode: 0, cleanupVerified: true },
    // Positive whitelists: no free-text commands, paths, summaries, messages,
    // credentials, patches, events, approval payloads or continuation state.
    integrations: view.integrations.map(operation => ({
      id: id(operation.id), assignmentId: id(operation.assignmentId), resultId: id(operation.resultId), kind: operation.kind, state: operation.state,
      sourceCommit: gitObject(operation.sourceSha), expectedHead: gitObject(operation.expectedHead), expectedTree: gitObject(operation.expectedTree),
      observedCommit: operation.observed?.commit ? gitObject(operation.observed.commit) : null,
      observedTree: operation.observed?.tree ? gitObject(operation.observed.tree) : null,
      resolvedTree: operation.resolvedTree ? gitObject(operation.resolvedTree) : null
    })),
    childResults: view.results.map(result => {
      requireValue(Number.isSafeInteger(result.revision) && result.revision > 0 && SHA256.test(result.manifestSha256), 'The child result metadata is invalid.');
      return {
        id: id(result.id), assignmentId: id(result.assignmentId), childTaskId: id(result.childTaskId), revision: result.revision,
        baseCommit: gitObject(result.baseCommit), commit: gitObject(result.commit), tree: gitObject(result.tree), manifestSha256: result.manifestSha256,
        validationEvidenceIds: result.evidenceIds.map(id)
      };
    })
  };
}
