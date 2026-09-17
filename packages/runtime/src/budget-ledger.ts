import { randomUUID } from 'node:crypto';
import type { BudgetSummary, RunBudget } from '../../protocol/src/index';
import { ORCHESTRATION_LIMITS } from '../../protocol/src/index';
import type { Store } from './store';

export class BudgetError extends Error {
  constructor(message: string, readonly reason: 'task-budget' | 'child-allocation' | 'fenced' | 'overrun') { super(message); this.name = 'BudgetError'; }
}

interface HoldRow { assignment_id: string; child_task_id: string; amount: number; state: 'held' | 'released'; released_unused: number | null }
interface ReservationRow { request_id: string; run_task_id: string; amount: number; state: 'reserved' | 'settled' | 'retained'; charged: number | null; usage_known: number }
interface Totals { cap: number; protectedCoordinator: number; charged: number; inFlight: number; retainedUnknown: number; unusedHolds: number; coordinatorConsumed: number; perRun: Map<string, { charged: number; inFlight: number }>; holds: HoldRow[] }

/**
 * Aggregate budget authority for one coordinated root. Allocation (holds) is separate
 * from consumption (reservations/settlements). Every mutation is a single IMMEDIATE
 * SQLite transaction so competing runs, connections and restarts cannot oversubscribe
 * or double-charge. Nothing here makes a provider request.
 */
export class BudgetLedger {
  constructor(private readonly store: Store) {}

  openAccount(rootTaskId: string, cap: number): void {
    const protectedCoordinator = Math.floor(cap * ORCHESTRATION_LIMITS.protectedCoordinatorPercent / 100);
    this.store.db.prepare('INSERT INTO budget_accounts(root_task_id, cap, protected_coordinator, updated_at) VALUES (?, ?, ?, ?)').run(rootTaskId, cap, protectedCoordinator, new Date().toISOString());
  }

  /** Admission-time allocation hold for a child. Does not charge tokens. */
  hold(rootTaskId: string, assignmentId: string, childTaskId: string, amount: number): void {
    this.immediate(() => {
      const totals = this.totals(rootTaskId);
      const coordinatorReserve = Math.max(0, totals.protectedCoordinator - totals.coordinatorConsumed);
      const committed = totals.charged + totals.inFlight + totals.unusedHolds;
      if (committed > totals.cap) throw new BudgetError('Recorded usage exceeds the task budget; new admission is blocked until the user reviews it.', 'overrun');
      if (committed + coordinatorReserve + amount > totals.cap) throw new BudgetError('The child allocation does not fit the remaining task budget after the protected coordinator reserve.', 'task-budget');
      this.store.db.prepare("INSERT INTO budget_holds(id, root_task_id, assignment_id, child_task_id, amount, state, created_at) VALUES (?, ?, ?, ?, ?, 'held', ?)").run(randomUUID(), rootTaskId, assignmentId, childTaskId, amount, new Date().toISOString());
    });
  }

  /**
   * Reserve a conservative request amount for a run at an exact generation. A child
   * converts its unused hold into the reservation; a coordinator may use unallocated or
   * returned funds but never another run's held allocation.
   */
  reserve(rootTaskId: string, runTaskId: string, generation: number, amount: number, requestId = randomUUID()): string {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new BudgetError('Invalid reservation amount.', 'task-budget');
    this.immediate(() => {
      const run = this.store.db.prepare('SELECT role, generation, cancel_requested, lifecycle FROM agent_runs WHERE task_id = ? AND root_task_id = ?').get(runTaskId, rootTaskId) as { role: string; generation: number; cancel_requested: number; lifecycle: string } | undefined;
      if (!run || run.generation !== generation || run.cancel_requested || run.lifecycle === 'terminal') throw new BudgetError('This run is cancelled, superseded or finished; no request was reserved.', 'fenced');
      const root = this.store.db.prepare('SELECT cancel_requested FROM agent_runs WHERE task_id = ?').get(rootTaskId) as { cancel_requested: number } | undefined;
      if (!root || root.cancel_requested) throw new BudgetError('The coordinated task is cancelled; no request was reserved.', 'fenced');
      const totals = this.totals(rootTaskId);
      const committed = totals.charged + totals.inFlight + totals.unusedHolds;
      if (committed > totals.cap) throw new BudgetError('Recorded usage exceeds the task budget; requests are blocked until the user reviews it.', 'overrun');
      if (run.role === 'child') {
        const hold = totals.holds.find(item => item.child_task_id === runTaskId);
        if (!hold || hold.state !== 'held') throw new BudgetError('This child has no active allocation.', 'child-allocation');
        const used = totals.perRun.get(runTaskId) ?? { charged: 0, inFlight: 0 };
        if (used.charged + used.inFlight + amount > hold.amount) throw new BudgetError('Insufficient child allocation for the conservative request reservation.', 'child-allocation');
        // The unused hold shrinks by exactly `amount`, so root commitment is unchanged.
      } else if (committed + amount > totals.cap) {
        throw new BudgetError('Insufficient unallocated task budget for the coordinator request; held child allocations are not borrowed.', 'task-budget');
      }
      this.store.db.prepare("INSERT INTO budget_reservations(request_id, root_task_id, run_task_id, generation, amount, state, created_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?)").run(requestId, rootTaskId, runTaskId, generation, amount, new Date().toISOString());
    });
    return requestId;
  }

  /**
   * Idempotent. Known usage is charged exactly once (even above the reservation, recorded
   * truthfully as an overrun). Missing usage retains the full reservation. Returns false
   * when the request was already settled, e.g. a duplicate after restart.
   */
  settle(requestId: string, usage: number | undefined, reason?: string): boolean {
    return this.immediate(() => {
      const row = this.store.db.prepare('SELECT amount, state FROM budget_reservations WHERE request_id = ?').get(requestId) as { amount: number; state: string } | undefined;
      if (!row) throw new Error('Unknown budget reservation.');
      if (row.state !== 'reserved') return false;
      const known = usage !== undefined && Number.isSafeInteger(usage) && usage >= 0;
      this.store.db.prepare('UPDATE budget_reservations SET state = ?, charged = ?, usage_known = ?, reason = ?, settled_at = ? WHERE request_id = ?')
        .run(known ? 'settled' : 'retained', known ? usage : row.amount, known ? 1 : 0, reason ?? null, new Date().toISOString(), requestId);
      return true;
    });
  }

  /** Release a child's unused allocation once it is safely terminal. In-flight requests block release. */
  release(childTaskId: string): number {
    return this.immediate(() => {
      const hold = this.store.db.prepare('SELECT root_task_id, amount, state FROM budget_holds WHERE child_task_id = ?').get(childTaskId) as { root_task_id: string; amount: number; state: string } | undefined;
      if (!hold || hold.state === 'released') return 0;
      const usage = this.store.db.prepare("SELECT COALESCE(SUM(CASE WHEN state = 'reserved' THEN amount ELSE 0 END), 0) AS inflight, COALESCE(SUM(COALESCE(charged, 0)), 0) AS charged FROM budget_reservations WHERE run_task_id = ?").get(childTaskId) as { inflight: number; charged: number };
      if (usage.inflight > 0) throw new Error('A child request is still in flight; its allocation cannot be released.');
      const unused = Math.max(0, hold.amount - usage.charged);
      this.store.db.prepare("UPDATE budget_holds SET state = 'released', released_unused = ?, released_at = ? WHERE child_task_id = ?").run(unused, new Date().toISOString(), childTaskId);
      return unused;
    });
  }

  summary(rootTaskId: string): BudgetSummary {
    const totals = this.totals(rootTaskId);
    const runs = this.store.db.prepare('SELECT task_id, role FROM agent_runs WHERE root_task_id = ? ORDER BY created_at, task_id').all(rootTaskId) as { task_id: string; role: 'coordinator' | 'child' }[];
    const perRun: RunBudget[] = runs.map(run => {
      const used = totals.perRun.get(run.task_id) ?? { charged: 0, inFlight: 0 };
      const hold = totals.holds.find(item => item.child_task_id === run.task_id);
      return { taskId: run.task_id, role: run.role, allocation: hold?.amount ?? null, charged: used.charged, inFlight: used.inFlight, unusedHold: hold && hold.state === 'held' ? Math.max(0, hold.amount - used.charged - used.inFlight) : 0, released: hold?.state === 'released' };
    });
    const committed = totals.charged + totals.inFlight + totals.unusedHolds;
    return {
      cap: totals.cap, protectedCoordinator: totals.protectedCoordinator, charged: totals.charged, inFlight: totals.inFlight,
      unusedHolds: totals.unusedHolds, unallocated: totals.cap - committed, retainedUnknown: totals.retainedUnknown,
      overrun: committed > totals.cap, warning: committed >= totals.cap * ORCHESTRATION_LIMITS.budgetWarningPercent / 100, runs: perRun
    };
  }

  runUsage(runTaskId: string): number {
    const row = this.store.db.prepare("SELECT COALESCE(SUM(CASE WHEN state = 'reserved' THEN amount ELSE charged END), 0) AS used FROM budget_reservations WHERE run_task_id = ?").get(runTaskId) as { used: number };
    return row.used;
  }

  private totals(rootTaskId: string): Totals {
    const account = this.store.db.prepare('SELECT cap, protected_coordinator FROM budget_accounts WHERE root_task_id = ?').get(rootTaskId) as { cap: number; protected_coordinator: number } | undefined;
    if (!account) throw new Error('Budget account not found.');
    const reservations = this.store.db.prepare('SELECT request_id, run_task_id, amount, state, charged, usage_known FROM budget_reservations WHERE root_task_id = ?').all(rootTaskId) as ReservationRow[];
    const holds = this.store.db.prepare('SELECT assignment_id, child_task_id, amount, state, released_unused FROM budget_holds WHERE root_task_id = ?').all(rootTaskId) as HoldRow[];
    const perRun = new Map<string, { charged: number; inFlight: number }>();
    let charged = 0; let inFlight = 0; let retainedUnknown = 0;
    for (const row of reservations) {
      const entry = perRun.get(row.run_task_id) ?? { charged: 0, inFlight: 0 };
      if (row.state === 'reserved') { inFlight += row.amount; entry.inFlight += row.amount; }
      else { charged += row.charged ?? row.amount; entry.charged += row.charged ?? row.amount; if (!row.usage_known) retainedUnknown += row.charged ?? row.amount; }
      perRun.set(row.run_task_id, entry);
    }
    let unusedHolds = 0;
    for (const hold of holds) {
      if (hold.state !== 'held') continue;
      const used = perRun.get(hold.child_task_id) ?? { charged: 0, inFlight: 0 };
      unusedHolds += Math.max(0, hold.amount - used.charged - used.inFlight);
    }
    const coordinator = perRun.get(rootTaskId) ?? { charged: 0, inFlight: 0 };
    return { cap: account.cap, protectedCoordinator: account.protected_coordinator, charged, inFlight, retainedUnknown, unusedHolds, coordinatorConsumed: coordinator.charged + coordinator.inFlight, perRun, holds };
  }

  private immediate<T>(fn: () => T): T { return this.store.db.transaction(fn).immediate(); }
}
